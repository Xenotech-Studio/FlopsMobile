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

  // MARK: - JS 拉取本 app 的 bundle identifier（= APNs topic）

  /// dev / release 双 bundle ID 下，device token 只能用「本 app 的 bundle ID」当 apns-topic 才推得进去。
  /// JS 注册 token 时带上这个值上报后端，后端按 token 存的 topic 逐条推（见 push.ts / flops_push_apns.py）。
  @objc(getBundleIdentifier:rejecter:)
  func getBundleIdentifier(_ resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(["bundleId": Bundle.main.bundleIdentifier ?? ""])
  }

  // MARK: - JS 拉取设备展示信息（deviceName + identifierForVendor）

  /// 电脑端 mic 菜单列手机时用（remote_mic /phones）：
  /// - deviceName：**机型全名**（如「iPhone 16 Pro Max」）。iOS 16+ 无 user-assigned-device-name 授权时
  ///   `UIDevice.current.name` 只返回泛称「iPhone」，拿不到用户在系统设置里起的名字；这里改用
  ///   `hw.machine`（如「iPhone17,2」）查表映射成营销全名，退而求其次给出可辨识的展示名。表里没收录的
  ///   （未来新机型 / iPad）回退到 `UIDevice.current.model` 泛称（「iPhone」/「iPad」），不比原来差。
  /// - identifierForVendor：同一 vendor 在本机的稳定 ID，同机 dev/prod 两个 build 共享同一值；
  ///   后端 /phones 按它去重，同一台物理机只显示一条（取最新那条）。
  @objc(getDeviceInfo:rejecter:)
  func getDeviceInfo(_ resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      let id = Self.machineIdentifier()
      let name = Self.modelNames[id] ?? UIDevice.current.model
      let idfv = UIDevice.current.identifierForVendor?.uuidString ?? ""
      resolve(["deviceName": name, "identifierForVendor": idfv])
    }
  }

  /// `hw.machine` 原始机型标识（如「iPhone17,2」）。模拟器返回被模拟的机型标识。
  private static func machineIdentifier() -> String {
    if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"], !sim.isEmpty {
      return sim
    }
    var size = 0
    sysctlbyname("hw.machine", nil, &size, nil, 0)
    guard size > 0 else { return "" }
    var machine = [CChar](repeating: 0, count: size)
    sysctlbyname("hw.machine", &machine, &size, nil, 0)
    return String(cString: machine)
  }

  /// 机型标识 → 营销全名（iPhone 8 起 + iPod touch 7）。iPad / 未收录新机回退 `UIDevice.model` 泛称。
  /// 数据源：社区维护表（adamawolf/Apple_mobile_device_types）。出新机型时在此追加一行即可。
  private static let modelNames: [String: String] = [
    "iPhone10,1": "iPhone 8", "iPhone10,4": "iPhone 8",
    "iPhone10,2": "iPhone 8 Plus", "iPhone10,5": "iPhone 8 Plus",
    "iPhone10,3": "iPhone X", "iPhone10,6": "iPhone X",
    "iPhone11,2": "iPhone XS",
    "iPhone11,4": "iPhone XS Max", "iPhone11,6": "iPhone XS Max",
    "iPhone11,8": "iPhone XR",
    "iPhone12,1": "iPhone 11",
    "iPhone12,3": "iPhone 11 Pro",
    "iPhone12,5": "iPhone 11 Pro Max",
    "iPhone12,8": "iPhone SE (2nd generation)",
    "iPhone13,1": "iPhone 12 mini",
    "iPhone13,2": "iPhone 12",
    "iPhone13,3": "iPhone 12 Pro",
    "iPhone13,4": "iPhone 12 Pro Max",
    "iPhone14,4": "iPhone 13 mini",
    "iPhone14,5": "iPhone 13",
    "iPhone14,2": "iPhone 13 Pro",
    "iPhone14,3": "iPhone 13 Pro Max",
    "iPhone14,6": "iPhone SE (3rd generation)",
    "iPhone14,7": "iPhone 14",
    "iPhone14,8": "iPhone 14 Plus",
    "iPhone15,2": "iPhone 14 Pro",
    "iPhone15,3": "iPhone 14 Pro Max",
    "iPhone15,4": "iPhone 15",
    "iPhone15,5": "iPhone 15 Plus",
    "iPhone16,1": "iPhone 15 Pro",
    "iPhone16,2": "iPhone 15 Pro Max",
    "iPhone17,3": "iPhone 16",
    "iPhone17,4": "iPhone 16 Plus",
    "iPhone17,1": "iPhone 16 Pro",
    "iPhone17,2": "iPhone 16 Pro Max",
    "iPhone17,5": "iPhone 16e",
    "iPod9,1": "iPod touch (7th generation)",
  ]

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
