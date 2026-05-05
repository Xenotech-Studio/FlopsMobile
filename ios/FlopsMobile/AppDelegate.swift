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
    let env: String = {
      // entitlement aps-environment：开发证书 → "development"，发布 → "production"
      // 由 Info.plist 不可知；改读 entitlements 路径同样不直接，故用编译条件 + provisioning 推断
      #if DEBUG
      return "sandbox"
      #else
      // Release 构建可能仍是 TestFlight (production) 或 ad-hoc，统一按 production 上报
      // 这与 entitlements 中 aps-environment=production 对应。
      return "production"
      #endif
    }()
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
