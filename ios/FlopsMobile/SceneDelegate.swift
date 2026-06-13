import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else {
      return
    }

    guard
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let reactNativeFactory = appDelegate.reactNativeFactory
    else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    // 旋转动画期间视图边界外短暂露出的是 window 底色；默认偏白，在附件全屏预览（暗色）里
    // 转屏会闪白角。设黑：正常使用时 window 永远被内容盖住看不到，只有转屏瞬间可见。
    window.backgroundColor = .black
    self.window = window

    reactNativeFactory.startReactNative(
      withModuleName: "FlopsMobile",
      in: window,
      launchOptions: nil
    )
  }
}
