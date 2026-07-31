//
//  FlopsActivityManager.swift
//  FlopsMobile
//
//  播报模式 Live Activity 的主 App 侧管理器（ActivityKit）。全局单例：播报模式是 app 级唯一状态，
//  同一时刻至多一个活动，故 start 前先 end 掉旧的。由 FlopsAudioModule 的 startLiveActivity /
//  endLiveActivity 桥接方法驱动，JS 侧在 setBroadcastMode(true/false) 的收敛处调用
//  （见 src/audio/ttsRealtime.ts）。灵动岛 / 锁屏的 UI 见 WidgetExtension 侧 FlopsBroadcastLiveActivity。
//
//  Live Activity 需 iOS 16.1+；主 App 部署目标 15.1，故整个类型标 @available(iOS 16.1, *)，
//  调用方（FlopsAudioModule）用 if #available 兜底，低版本全 no-op。
//
//  这里用的是 iOS 16.1 版 ActivityKit API（Activity.request(attributes:contentState:pushType:)、
//  update(using:)、end(using:dismissalPolicy:)）——在 16.2+ 虽被标记 deprecated 但仍可用，选它是为了
//  覆盖 16.1 设备而不必二分 16.2 分支。push token（远程更新）留到 Phase 2，这里只做本机 request/update/end。
//

import ActivityKit
import Foundation

@available(iOS 16.1, *)
enum FlopsActivityManager {
  /// 当前活动句柄（ActivityKit 无同步查询接口，自持一份以便 update / end）。
  private static var current: Activity<FlopsBroadcastAttributes>?

  /// 当前活动内容的本地镜像。update 用「只覆盖传入字段」的合并语义：isActive 由原生 WS 事件
  /// （speak_start/end）驱动，activeCount/pendingCount 由 JS（inbox SSE）驱动，二者各自更新时
  /// 不会把对方的字段清零。start 时重置为初始值。
  private static var currentState = FlopsBroadcastAttributes.ContentState(
    isActive: false, conversationTitle: nil, activeCount: 0, pendingCount: 0)

  /// 开启播报 Live Activity。幂等：已有活动先结束再开，保证全局单例。
  /// 必须在前台调用——iOS 要求 Activity.request 时 app 处于 foreground，否则抛错（JS 侧只在
  /// 用户手动切开关 / 前台恢复时触发，天然满足）。系统关闭了实时活动（设置里）则静默跳过。
  static func start(conversationTitle: String? = nil) {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      NSLog("[FlopsActivity] start skipped: 系统/应用设置里关了「实时活动」(areActivitiesEnabled=false)")
      return
    }
    // 先「快照」出此刻的残留（自持句柄 + 系统里同类旧活动），request 之后只结束这批旧的。
    // 关键：不能在 request 之后再枚举 Activity.activities 去 endAll——那份列表此刻已含刚建的新活动，
    // 会把新活动一并 .immediate 秒关（表现为灵动岛闪现即灭 / 根本看不到，冷启动首开也中招）。
    let stale = current
    let residual = Activity<FlopsBroadcastAttributes>.activities
    current = nil

    let attributes = FlopsBroadcastAttributes()
    let state = FlopsBroadcastAttributes.ContentState(isActive: false,
                                                      conversationTitle: conversationTitle,
                                                      activeCount: 0,
                                                      pendingCount: 0)
    currentState = state // 重置本地镜像，避免上一轮播报残留的计数漏进新活动
    do {
      current = try Activity.request(attributes: attributes,
                                     contentState: state,
                                     pushType: nil)
      NSLog("[FlopsActivity] started id=%@", current?.id ?? "nil")
    } catch {
      NSLog("[FlopsActivity] request failed: %@", error.localizedDescription)
    }

    // 只结束快照里的旧活动；新建的那个不在 residual/stale 里，安然保留（重复 end 已结束的活动是 no-op）。
    Task {
      if let stale = stale {
        await stale.end(using: nil, dismissalPolicy: .immediate)
      }
      for activity in residual {
        await activity.end(using: nil, dismissalPolicy: .immediate)
      }
    }
  }

  /// 合并式更新当前活动内容：仅覆盖传入（非 nil）的字段，其余沿用上次值。无活动则忽略。
  /// - isActive：是否正在朗读（原生 WS 事件驱动）。
  /// - conversationTitle：当前朗读的对话标题（nil = 不改；标题特性尚未启用，现有流程恒传 nil）。
  /// - activeCount / pendingCount：会话统计（JS 侧 inbox SSE 驱动，见 reportBroadcastStats）。
  @MainActor
  static func update(isActive: Bool? = nil,
                     conversationTitle: String? = nil,
                     activeCount: Int? = nil,
                     pendingCount: Int? = nil) {
    // 系统已结束的活动（用户从锁屏滑动关闭 / 超时自动结束）的句柄仍保留在 current 里，
    // 但调用 update 时 ActivityKit 静默丢弃；检查 activityState 避免无谓 Task 创建。
    guard let activity = current,
          activity.activityState == .active || activity.activityState == .stale else {
      if current != nil {
        NSLog("[FlopsActivity] update skipped: activityState=%@ current is not active/stale, discarding handle",
              current.map { String(describing: $0.activityState) } ?? "nil")
        current = nil
      }
      return
    }
    if let isActive = isActive { currentState.isActive = isActive }
    if let conversationTitle = conversationTitle { currentState.conversationTitle = conversationTitle }
    if let activeCount = activeCount { currentState.activeCount = activeCount }
    if let pendingCount = pendingCount { currentState.pendingCount = pendingCount }
    let snapshot = currentState
    NSLog("[FlopsActivity] update isActive=%@ title=%@ active=%d pending=%d",
          snapshot.isActive ? "YES" : "NO",
          snapshot.conversationTitle ?? "<nil>",
          snapshot.activeCount,
          snapshot.pendingCount)
    Task { @MainActor in await activity.update(using: snapshot) }
  }

  /// 结束当前活动（并兜底清掉进程重启后系统里可能残留的同类活动）。
  static func end() {
    endAll()
  }

  /// 立即结束自持句柄 + 系统里所有同 Attributes 的活动（冷启动时 current 为空但旧活动仍在展示的兜底）。
  private static func endAll() {
    let handle = current
    current = nil
    Task {
      if let handle = handle {
        await handle.end(using: nil, dismissalPolicy: .immediate)
      }
      for activity in Activity<FlopsBroadcastAttributes>.activities {
        await activity.end(using: nil, dismissalPolicy: .immediate)
      }
    }
  }
}
