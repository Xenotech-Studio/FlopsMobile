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
          Image(systemName: "speaker.wave.2.fill")
            .font(.title3)
            .foregroundColor(flopsAccent)
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
      } compactLeading: {
        Image(systemName: "speaker.wave.2.fill")
          .foregroundColor(flopsAccent)
      } compactTrailing: {
        // 出声时显示律动波形，空闲监听时留空，让紧凑态更能反映实时状态。
        if context.state.isActive {
          Image(systemName: "waveform")
            .foregroundColor(flopsAccent)
        }
      } minimal: {
        Image(systemName: "speaker.wave.2.fill")
          .foregroundColor(flopsAccent)
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
      Image(systemName: "speaker.wave.2.fill")
        .font(.title2)
        .foregroundColor(flopsAccent)

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
