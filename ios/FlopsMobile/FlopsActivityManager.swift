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

  /// 开启播报 Live Activity。幂等：已有活动先结束再开，保证全局单例。
  /// 必须在前台调用——iOS 要求 Activity.request 时 app 处于 foreground，否则抛错（JS 侧只在
  /// 用户手动切开关 / 前台恢复时触发，天然满足）。系统关闭了实时活动（设置里）则静默跳过。
  static func start(conversationTitle: String? = nil) {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    endAll() // 先收干净残留
    let attributes = FlopsBroadcastAttributes()
    let state = FlopsBroadcastAttributes.ContentState(isActive: false,
                                                      conversationTitle: conversationTitle)
    do {
      current = try Activity.request(attributes: attributes,
                                     contentState: state,
                                     pushType: nil)
    } catch {
      NSLog("[FlopsActivity] request failed: %@", error.localizedDescription)
    }
  }

  /// 更新当前活动内容（是否正在朗读 / 对话标题）。无活动则忽略。
  static func update(isActive: Bool, conversationTitle: String?) {
    guard let activity = current else { return }
    let state = FlopsBroadcastAttributes.ContentState(isActive: isActive,
                                                      conversationTitle: conversationTitle)
    Task { await activity.update(using: state) }
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
