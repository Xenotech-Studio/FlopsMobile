import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import UserNotifications

@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    // UNUserNotificationCenter 代理（前台横幅由本类提供）
    UNUserNotificationCenter.current().delegate = self

    // 不在启动时申请权限/注册远端通知；由 RN 侧 FlopsPushModule.requestPermission()
    // 在用户点「登记推送令牌（APNs）」时触发，避免首次启动打扰用户。

    return true
  }

  func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(
      name: "Default Configuration",
      sessionRole: connectingSceneSession.role
    )
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }

  // MARK: - APNs 注册回调

  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    let tokenHex = deviceToken.map { String(format: "%02x", $0) }.joined()
    let env = Self.inferApnsEnv()
    NSLog("[FlopsPush] APNs token len=%d env=%@", tokenHex.count, env)
    FlopsPushModule.cacheToken(tokenHex, env: env)
  }

  func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    let msg = error.localizedDescription
    NSLog("[FlopsPush] APNs register failed: %@", msg)
    FlopsPushModule.cacheError(msg)
  }

  /// 推断当前 build 的 APNs 环境，**不依赖** `#if DEBUG`。
  ///
  /// APNs token 池子由 entitlement 里的 `aps-environment` 决定：
  ///   - `development` → sandbox token，发 `api.sandbox.push.apple.com`
  ///   - `production`  → production token，发 `api.push.apple.com`
  /// 一旦客户端上报的 env 与 token 实际所属池子不一致，Apple 回 `BadDeviceToken (400)`。
  ///
  /// 三种部署形态如何判断：
  ///
  /// 1. **Sideload (development / ad-hoc / enterprise)**：IPA 内部带 `embedded.mobileprovision`，
  ///    profile 的明文 plist payload 里有 `<key>aps-environment</key><string>...</string>`。
  ///    直接子串匹配读出，最准。
  ///
  /// 2. **TestFlight / App Store**：IPA 上传到 ASC 后被 Apple 重签 (App Store distribution
  ///    certificate)，**移除** `embedded.mobileprovision`（store 分发不需要 device list 概念）。
  ///    所以 Bundle 里**找不到** mobileprovision —— 但 entitlement 里的 `aps-environment`
  ///    仍然是 `production`（archive 阶段就已经烧进 binary）。这种情况强制 production。
  ///
  /// 3. **Simulator**：没有 mobileprovision，APNs 也不真工作；保守标 sandbox。
  ///
  /// 关键：先查 mobileprovision（最准），再按 simulator vs device 兜底。
  private static func inferApnsEnv() -> String {
    if let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
       let data = try? Data(contentsOf: url),
       let text = String(data: data, encoding: .ascii),
       let r = text.range(of: "<key>aps-environment</key>") {
      let after = text[r.upperBound...].prefix(200)
      return after.contains("production") ? "production" : "sandbox"
    }
    #if targetEnvironment(simulator)
    return "sandbox"
    #else
    return "production"
    #endif
  }

  // MARK: - 前台展示

  // 前台收到推送时也允许系统横幅 + 声音 + Badge 展示（替代 Notifee）
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    if #available(iOS 14.0, *) {
      completionHandler([.banner, .list, .sound, .badge])
    } else {
      completionHandler([.alert, .sound, .badge])
    }
  }

  // 用户点开通知（或锁屏滑开）时进入；从 userInfo 提取 push_event 写入的
  // {kind, conversation_id, review_id, ...}，转给 RN 侧路由跳转。
  // 冷启动场景：RN bridge 此时可能还没起来，FlopsPushModule 会把 payload 缓存为
  // pendingDeepLink，待 JS 侧主动调 getPendingDeepLink() 拉走。
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let userInfo = response.notification.request.content.userInfo
    var payload: [String: Any] = [:]
    for (k, v) in userInfo {
      if let key = k as? String, key != "aps" {
        payload[key] = v
      }
    }
    if !payload.isEmpty {
      FlopsPushModule.cacheDeepLink(payload)
    }
    completionHandler()
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
