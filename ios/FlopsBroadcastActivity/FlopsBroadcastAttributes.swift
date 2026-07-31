//
//  FlopsBroadcastAttributes.swift
//  FlopsMobile
//
//  播报模式 Live Activity 的 ActivityAttributes 定义 —— 同一份源码**同时编入**主 App target 与
//  WidgetExtension target（靠 Xcode 的双 target membership，见 project.pbxproj）。主 App 侧
//  FlopsActivityManager 用它 request/update/end；WidgetExtension 侧 FlopsBroadcastLiveActivity 用它
//  声明 UI。二者必须是同一个类型，系统才能把活动内容投递给对应的 widget。
//
//  播报模式（全局语音播报）是 app 级单例，同一时刻至多一个活动，故这里只描述"是否正在朗读"与
//  "当前正在朗读哪条对话"（可空——连上后空闲监听时并没有具体对话在说）。
//
//  ActivityKit 需 iOS 16.1+；主 App 部署目标是 15.1，因此整个类型标 @available(iOS 16.1, *)，
//  主 App 里所有触及处都包在 if #available(iOS 16.1, *) 内（见 FlopsActivityManager.swift）。
//  WidgetExtension target 的部署目标本身就是 16.1，注解在那侧无副作用。
//

import ActivityKit
import Foundation

@available(iOS 16.1, *)
struct FlopsBroadcastAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    /// 是否正在朗读：true=当前有 run 正在出声；false=已连上但空闲监听。
    var isActive: Bool
    /// 当前正在朗读的对话标题（可空：并非每时每刻都有对话在说，空闲监听时为 nil）。
    var conversationTitle: String?
  }
}
