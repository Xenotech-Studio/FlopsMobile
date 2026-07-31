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

/// 落在 flopsAccent（白）实心底上的前景色（停止按钮的图标/文字）。白底上必须用深色才看得见，
/// 否则白图标压白底=不可见（橙→白换主题后停止按钮就踩了这个坑）。取近黑更醒目。
private let onAccent = Color.black

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

/// 灵动岛 trailing / compactTrailing 的状态图标：返回一枚 SF Symbol 名字反映当前播报状态，优先级从高到低：
///   1) 正在播语音（isActive）           → waveform（音波律动）
///   2) 有对话进行中（activeCount>0）     → hammer.fill（工作中）
///   3) 无进行中但有待处理（pendingCount>0）→ hourglass（待处理）
///   4) 都没有（空闲连上）                → beach.umbrella.fill（沙滩伞，Flops 独有：休息中）
/// 停止按钮不再占 trailing，改放 expanded 的 bottom 区域。
@available(iOS 16.1, *)
private func broadcastStatusSymbol(for state: FlopsBroadcastAttributes.ContentState) -> String {
  if state.isActive {
    return "waveform"
  } else if state.activeCount > 0 {
    return "hammer.fill"
  } else if state.pendingCount > 0 {
    return "hourglass"
  } else {
    return "beach.umbrella.fill"
  }
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
        // 展开态（长按灵动岛）：品牌图标 + "语音播报中" + 右侧状态图标；停止按钮下移到 bottom 区域。
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
            // 次行：有对话读标题；否则用会话统计（进行中/待处理）替代旧的"监听中"文案；都没有才"监听中"。
            BroadcastSecondaryLine(state: context.state,
                                   font: .caption2,
                                   color: .white.opacity(0.7))
          }
        }
        DynamicIslandExpandedRegion(.trailing) {
          // 右侧不再是停止按钮，改成反映实时状态的图标（播音/工作中/待处理/监听中）。
          Image(systemName: broadcastStatusSymbol(for: context.state))
            .font(.title3)
            .foregroundColor(flopsAccent)
            .padding(.trailing, 8)
        }
        DynamicIslandExpandedRegion(.bottom) {
          // 停止按钮从 trailing 移到这里：展开态（长按）下才出现，整条胶囊更好点。
          Link(destination: stopURL) {
            HStack(spacing: 6) {
              Image(systemName: "stop.fill")
              Text("停止播报")
                .fontWeight(.semibold)
            }
            .font(.caption)
            .foregroundColor(onAccent)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(Capsule().fill(flopsAccent))
          }
          .padding(.horizontal, 4)
          .padding(.top, 2)
        }
      } compactLeading: {
        flopsGlyph(size: 16).padding(.leading, 6)
      } compactTrailing: {
        // 右侧状态图标：播音时波形、有对话进行中/待处理各自图标、空闲时沙滩伞，让紧凑态实时反映状态。
        Image(systemName: broadcastStatusSymbol(for: context.state))
          .foregroundColor(flopsAccent)
          .padding(.trailing, 6)
      } minimal: {
        flopsGlyph(size: 16).padding(.leading, 6)
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
        // 次行：有对话读标题；否则用会话统计（进行中/待处理）替代旧的"监听中"文案；都没有才"监听中"。
        BroadcastSecondaryLine(state: state,
                               font: .subheadline,
                               color: .white.opacity(0.75))
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
            .foregroundColor(onAccent)
            .padding(9)
            .background(Circle().fill(flopsAccent))
        }
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
  }
}

// MARK: - 次行（标题 / 会话统计 / 监听中）
//
// 锁屏横幅标题下方、灵动岛 expanded 中间区域的第二行，三选一：
//   1) 正在朗读某条对话 → 显示该对话标题；
//   2) 否则有会话统计 → 用 activeCount/pendingCount 直接顶上（"N 进行中" / "M 待处理"），
//      取代旧的"监听中"占位文案，也不再另起一行堆数字；
//   3) 两个计数都为 0 且无对话 → 回落到"监听中"。
// 字号/颜色由调用方传入（横幅 subheadline、灵动岛 caption2），跟随各版位的次行样式。

@available(iOS 16.1, *)
struct BroadcastSecondaryLine: View {
  let state: FlopsBroadcastAttributes.ContentState
  let font: Font
  let color: Color

  var body: some View {
    if let title = state.conversationTitle, !title.isEmpty {
      Text(title)
        .font(font)
        .foregroundColor(color)
        .lineLimit(1)
    } else if state.activeCount > 0 || state.pendingCount > 0 {
      BroadcastStatsRow(activeCount: state.activeCount,
                        pendingCount: state.pendingCount,
                        font: font,
                        color: color)
    } else {
      Text("监听中")
        .font(font)
        .foregroundColor(color)
    }
  }
}

// MARK: - 会话统计行（图标 + 数字 + 文案，紧凑横向）
//
// 正在进行的对话数（radiowaves=进行中）+ 已完成待处理数（hourglass=待处理）。作为次行内容，
// 两者皆 >0 时并排显示两枚 chip。图标用 SF Symbols 染成次行同色，贴合整体白色主题。

@available(iOS 16.1, *)
struct BroadcastStatsRow: View {
  let activeCount: Int
  let pendingCount: Int
  let font: Font
  let color: Color

  var body: some View {
    HStack(spacing: 10) {
      if activeCount > 0 {
        statChip(systemName: "dot.radiowaves.left.and.right", value: activeCount, label: "进行中")
      }
      if pendingCount > 0 {
        statChip(systemName: "hourglass", value: pendingCount, label: "待处理")
      }
    }
    .foregroundColor(color)
  }

  private func statChip(systemName: String, value: Int, label: String) -> some View {
    HStack(spacing: 3) {
      Image(systemName: systemName)
        .font(font)
      Text("\(value) \(label)")
        .font(font)
        .fontWeight(.semibold)
        .lineLimit(1)
    }
  }
}
