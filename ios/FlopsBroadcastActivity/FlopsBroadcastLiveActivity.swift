//
//  FlopsBroadcastLiveActivity.swift
//  FlopsBroadcastActivity
//
//  播报模式 Live Activity 的 UI —— 锁屏 / 通知中心横幅 + 灵动岛（compact / minimal / expanded）。
//  纯系统框架（WidgetKit / SwiftUI / ActivityKit），无第三方依赖，无需 pod。
//
//  内容由主 App 侧 FlopsActivityManager 通过 ActivityKit 下发（FlopsBroadcastAttributes.ContentState）。
//  停止按钮走 URL scheme 深链 flops://broadcast/stop：点它把 app 拉起并投递该 url，JS 侧
//  BroadcastLinkRouter 收到后调 disableBroadcastMode() 关播报（会连带 endLiveActivity）。
//

import ActivityKit
import SwiftUI
import WidgetKit

/// Live Activity 统一用纯白强调色，配更暗的半透明黑底更干净（喇叭图标 / 停止按钮 / 灵动岛 accent 都取这个）。
private let flopsAccent = Color.white

/// 停止播报的深链。整块横幅/灵动岛默认点击会打开 app；仅"停止"按钮用它触发关播报。
private let stopURL = URL(string: "flops://broadcast/stop")!

/// Flops 品牌图标（原子 / 轨道 glyph），替代系统 speaker.wave.2.fill。素材在本 WidgetExtension
/// 自带的 Assets.xcassets 里（FlopsGlyph，template-rendering-intent=template，源自桌面端 tray-icon）；
/// 作模板图渲染并染成 flopsAccent（白），与整体白色主题一致。size 按各处版位显式给定。
@available(iOS 16.1, *)
private func flopsGlyph(size: CGFloat) -> some View {
  Image("FlopsGlyph")
    .renderingMode(.template)
    .resizable()
    .aspectRatio(contentMode: .fit)
    .frame(width: size, height: size)
    .foregroundColor(flopsAccent)
}

// MARK: - WidgetBundle 入口（@main）

@main
struct FlopsBroadcastActivityBundle: WidgetBundle {
  var body: some Widget {
    // 部署目标 16.1，用 if #available 兜底：低于 16.1（理论上不会加载本扩展）时不注册任何 widget。
    if #available(iOS 16.1, *) {
      FlopsBroadcastLiveActivity()
    }
  }
}

// MARK: - Live Activity 定义

@available(iOS 16.1, *)
struct FlopsBroadcastLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: FlopsBroadcastAttributes.self) { context in
      // 锁屏 / 通知中心横幅
      BroadcastLockScreenView(state: context.state)
        .activityBackgroundTint(Color.black.opacity(0.82))
        .activitySystemActionForegroundColor(flopsAccent)
    } dynamicIsland: { context in
      DynamicIsland {
        // 展开态（长按灵动岛）：喇叭图标 + "语音播报中" + 停止按钮
        DynamicIslandExpandedRegion(.leading) {
          flopsGlyph(size: 22)
            .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.center) {
          VStack(alignment: .leading, spacing: 2) {
            Text("语音播报中")
              .font(.caption)
              .fontWeight(.semibold)
              .foregroundColor(.white)
            if let title = context.state.conversationTitle, !title.isEmpty {
              Text(title)
                .font(.caption2)
                .foregroundColor(.white.opacity(0.7))
                .lineLimit(1)
            } else {
              Text(context.state.isActive ? "正在朗读" : "监听中")
                .font(.caption2)
                .foregroundColor(.white.opacity(0.7))
            }
          }
        }
        DynamicIslandExpandedRegion(.trailing) {
          Link(destination: stopURL) {
            Text("停止")
              .font(.caption)
              .fontWeight(.semibold)
              .foregroundColor(.white)
              .padding(.horizontal, 12)
              .padding(.vertical, 6)
              .background(Capsule().fill(flopsAccent))
          }
          .padding(.trailing, 4)
        }
        // 展开态底部：会话统计（正在进行 / 已完成待处理）。两者皆 0 时 BroadcastStatsRow 不渲染，
        // 区域自然收起。compact / minimal 空间太小不加。
        DynamicIslandExpandedRegion(.bottom) {
          BroadcastStatsRow(activeCount: context.state.activeCount,
                            pendingCount: context.state.pendingCount)
            .padding(.top, 2)
        }
      } compactLeading: {
        flopsGlyph(size: 16)
      } compactTrailing: {
        // 出声时显示律动波形，空闲监听时留空，让紧凑态更能反映实时状态。
        if context.state.isActive {
          Image(systemName: "waveform")
            .foregroundColor(flopsAccent)
        }
      } minimal: {
        flopsGlyph(size: 16)
      }
      // 不设 widgetURL 为 stopURL：点灵动岛整体应打开 app（默认行为），只有"停止"按钮才关播报。
    }
  }
}

// MARK: - 锁屏 / 通知中心横幅视图

@available(iOS 16.1, *)
struct BroadcastLockScreenView: View {
  let state: FlopsBroadcastAttributes.ContentState

  var body: some View {
    HStack(spacing: 12) {
      flopsGlyph(size: 26)

      VStack(alignment: .leading, spacing: 2) {
        Text("Flops 播报中")
          .font(.headline)
          .foregroundColor(.white)
        if let title = state.conversationTitle, !title.isEmpty {
          Text(title)
            .font(.subheadline)
            .foregroundColor(.white.opacity(0.75))
            .lineLimit(1)
        } else {
          Text(state.isActive ? "正在朗读" : "监听中")
            .font(.subheadline)
            .foregroundColor(.white.opacity(0.75))
        }
      }

      Spacer(minLength: 8)

      VStack(alignment: .trailing, spacing: 6) {
        // 当前时间（横幅右上角），呼应需求里的"时间"信息。
        Text(Date(), style: .time)
          .font(.caption2)
          .foregroundColor(.white.opacity(0.6))
        // 时间下方：会话统计（正在进行 / 已完成待处理），紧凑横向；两者皆 0 时整行不显示。
        BroadcastStatsRow(activeCount: state.activeCount,
                          pendingCount: state.pendingCount)
        Link(destination: stopURL) {
          Image(systemName: "stop.fill")
            .font(.subheadline)
            .foregroundColor(.white)
            .padding(9)
            .background(Circle().fill(flopsAccent))
        }
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
  }
}

// MARK: - 会话统计行（图标 + 数字，紧凑横向）
//
// 🎙️正在进行的对话数 + ⏳已完成待处理数。用于锁屏横幅（时间下方）与灵动岛 expanded（.bottom）；
// compact / minimal 空间太小不显示。两个计数都为 0（空闲）时整行不渲染，保持干净。
// 图标用 SF Symbols 染白，贴合整体白色主题（radiowaves=进行中 / hourglass=待处理）。

@available(iOS 16.1, *)
struct BroadcastStatsRow: View {
  let activeCount: Int
  let pendingCount: Int

  var body: some View {
    if activeCount > 0 || pendingCount > 0 {
      HStack(spacing: 10) {
        if activeCount > 0 {
          statChip(systemName: "dot.radiowaves.left.and.right", value: activeCount)
        }
        if pendingCount > 0 {
          statChip(systemName: "hourglass", value: pendingCount)
        }
      }
    }
  }

  private func statChip(systemName: String, value: Int) -> some View {
    HStack(spacing: 3) {
      Image(systemName: systemName)
        .font(.caption2)
      Text("\(value)")
        .font(.caption2)
        .fontWeight(.semibold)
    }
    .foregroundColor(.white.opacity(0.85))
  }
}
