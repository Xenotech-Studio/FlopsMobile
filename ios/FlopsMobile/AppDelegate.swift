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
  /// 真机：读 `embedded.mobileprovision` 里 `Entitlements.aps-environment`。
  /// 该值由 provisioning profile 决定（development / production），
  /// 与 build configuration（Debug / Release）正交：
  ///   - Development profile（Run / sideload）→ aps-environment=development → sandbox token
  ///   - Distribution profile（TestFlight / App Store / Ad-Hoc）→ production → production token
  /// 一旦搞错，APNs 服务端会回 `BadDeviceToken (400)`。
  ///
  /// `embedded.mobileprovision` 是 CMS 签名容器，但内部 plist payload 是明文 ASCII，
  /// 直接子串匹配即可，无需解 CMS。
  ///
  /// 模拟器没有 embedded.mobileprovision（adhoc 签名），fallback 到 sandbox：
  /// 模拟器 build 只可能是 development 场景。
  private static func inferApnsEnv() -> String {
    guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
          let data = try? Data(contentsOf: url),
          let text = String(data: data, encoding: .ascii) else {
      return "sandbox"
    }
    guard let r = text.range(of: "<key>aps-environment</key>") else { return "sandbox" }
    let after = text[r.upperBound...].prefix(200)
    return after.contains("production") ? "production" : "sandbox"
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
