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
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  override static func requiresMainQueueSetup() -> Bool {
    return false
  }

  override func supportedEvents() -> [String]! {
    return ["onAPNsToken", "onAPNsRegisterError"]
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
      let status: String
      switch settings.authorizationStatus {
      case .notDetermined: status = "notDetermined"
      case .denied: status = "denied"
      case .authorized: status = "authorized"
      case .provisional: status = "provisional"
      case .ephemeral: status = "ephemeral"
      @unknown default: status = "unknown"
      }
      resolve(["status": status])
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
}
