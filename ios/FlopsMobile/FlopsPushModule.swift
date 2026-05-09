//
//  FlopsPushModule.swift
//  FlopsMobile
//
//  纯 APNs 推送桥：把 AppDelegate 拿到的 device token 通过 RN 事件
//  转发给 JS 侧（事件名 onAPNsToken / onAPNsRegisterError）。
//
//  - 不依赖 Firebase / Notifee；前台展示通知由 AppDelegate 实现 UNUserNotificationCenterDelegate 完成。
//  - JS 侧通过 NativeEventEmitter(NativeModules.FlopsPushModule) 监听事件，
//    或调用 getDeviceToken() 主动拉一次（若已缓存则立即返回）。
//

import Foundation
import React
import UIKit
import UserNotifications

@objc(FlopsPushModule)
class FlopsPushModule: RCTEventEmitter {

  // 单例：AppDelegate 拿到 token 后通过 NotificationCenter 通知；
  // 即使 module 还未实例化，token 也会被 AppDelegate 缓存到 sharedCachedToken。
  fileprivate static var sharedCachedToken: String?
  fileprivate static var sharedCachedEnv: String?
  fileprivate static var sharedLastError: String?
  fileprivate static var sharedInstance: FlopsPushModule?
  // 用户点开通知时 AppDelegate 调 cacheDeepLink 写入；
  // 冷启动场景下 RN bridge 还没起来，先缓存，待 JS 主动 getPendingDeepLink 时一次性消费
  fileprivate static var sharedPendingDeepLink: [String: Any]?

  override init() {
    super.init()
    FlopsPushModule.sharedInstance = self
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(onTokenNotification(_:)),
      name: NSNotification.Name("FlopsAPNsTokenReceived"),
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(onErrorNotification(_:)),
      name: NSNotification.Name("FlopsAPNsRegisterError"),
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(onDeepLinkNotification(_:)),
      name: NSNotification.Name("FlopsAPNsDeepLink"),
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  override static func requiresMainQueueSetup() -> Bool {
    return false
  }

  override func supportedEvents() -> [String]! {
    return ["onAPNsToken", "onAPNsRegisterError", "onAPNsDeepLink"]
  }

  // MARK: - 事件回流

  @objc private func onTokenNotification(_ note: Notification) {
    guard let info = note.userInfo,
          let token = info["token"] as? String else { return }
    let env = (info["env"] as? String) ?? "sandbox"
    sendEvent(withName: "onAPNsToken", body: ["token": token, "env": env])
  }

  @objc private func onErrorNotification(_ note: Notification) {
    let msg = (note.userInfo?["error"] as? String) ?? "unknown"
    sendEvent(withName: "onAPNsRegisterError", body: ["error": msg])
  }

  @objc private func onDeepLinkNotification(_ note: Notification) {
    if let payload = note.userInfo as? [String: Any] {
      sendEvent(withName: "onAPNsDeepLink", body: payload)
    }
  }

  // MARK: - JS 调用：请求权限 + registerForRemoteNotifications

  @objc(requestPermission:rejecter:)
  func requestPermission(_ resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
    let center = UNUserNotificationCenter.current()
    center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
      if let error = error {
        reject("permission_error", error.localizedDescription, error)
        return
      }
      if !granted {
        resolve([
          "granted": false,
          "registered": false,
        ])
        return
      }
      DispatchQueue.main.async {
        UIApplication.shared.registerForRemoteNotifications()
        resolve([
          "granted": true,
          "registered": true,
        ])
      }
    }
  }

  @objc(getAuthorizationStatus:rejecter:)
  func getAuthorizationStatus(_ resolve: @escaping RCTPromiseResolveBlock,
                              rejecter reject: @escaping RCTPromiseRejectBlock) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      resolve(["status": Self.statusString(settings.authorizationStatus)])
    }
  }

  /// 已授权场景下静默调用 registerForRemoteNotifications，不弹权限框；
  /// 用于 app 启动 / 回前台时的自动同步。未授权直接返回当前状态，
  /// 由 JS 侧决定是否引导用户去系统设置。
  @objc(registerSilently:rejecter:)
  func registerSilently(_ resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      let status = Self.statusString(settings.authorizationStatus)
      let canRegister: Bool
      switch settings.authorizationStatus {
      case .authorized, .provisional, .ephemeral:
        canRegister = true
      default:
        canRegister = false
      }
      if canRegister {
        DispatchQueue.main.async {
          UIApplication.shared.registerForRemoteNotifications()
          resolve(["status": status, "registered": true])
        }
      } else {
        resolve(["status": status, "registered": false])
      }
    }
  }

  private static func statusString(_ s: UNAuthorizationStatus) -> String {
    switch s {
    case .notDetermined: return "notDetermined"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .provisional: return "provisional"
    case .ephemeral: return "ephemeral"
    @unknown default: return "unknown"
    }
  }

  // MARK: - JS 主动拉取（拿不到则 reject "no_token"）

  @objc(getDeviceToken:rejecter:)
  func getDeviceToken(_ resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
    if let t = FlopsPushModule.sharedCachedToken {
      resolve([
        "token": t,
        "env": FlopsPushModule.sharedCachedEnv ?? "sandbox",
      ])
      return
    }
    if let err = FlopsPushModule.sharedLastError {
      reject("apns_register_failed", err, nil)
      return
    }
    reject("no_token", "device token not yet available; ensure permission granted and registerForRemoteNotifications was called", nil)
  }

  // MARK: - 由 AppDelegate 调用：把拿到的 token 缓存并广播

  static func cacheToken(_ token: String, env: String) {
    sharedCachedToken = token
    sharedCachedEnv = env
    sharedLastError = nil
    NotificationCenter.default.post(
      name: NSNotification.Name("FlopsAPNsTokenReceived"),
      object: nil,
      userInfo: ["token": token, "env": env]
    )
  }

  static func cacheError(_ message: String) {
    sharedLastError = message
    NotificationCenter.default.post(
      name: NSNotification.Name("FlopsAPNsRegisterError"),
      object: nil,
      userInfo: ["error": message]
    )
  }

  /// 用户点开通知时由 AppDelegate 调用：广播 + 缓存（冷启动 RN 还没起来时让 JS 之后能拉走）
  static func cacheDeepLink(_ payload: [String: Any]) {
    sharedPendingDeepLink = payload
    NotificationCenter.default.post(
      name: NSNotification.Name("FlopsAPNsDeepLink"),
      object: nil,
      userInfo: payload
    )
  }

  /// JS 启动时主动拉一次冷启动期间错过的 deep link；返回后清空缓存。
  @objc(getPendingDeepLink:rejecter:)
  func getPendingDeepLink(_ resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
    if let payload = FlopsPushModule.sharedPendingDeepLink {
      FlopsPushModule.sharedPendingDeepLink = nil
      resolve(["payload": payload])
    } else {
      resolve(["payload": NSNull()])
    }
  }
}
