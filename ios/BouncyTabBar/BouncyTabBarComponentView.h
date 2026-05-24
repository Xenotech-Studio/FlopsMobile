/**
 * Fabric ViewComponentView 包装独立 UITabBar（非 UITabBarController 形态）。
 * iOS 26+ 自动 Liquid Glass material + floating pill 视觉 + 系统选段动画。
 * 每个 UITabBarItem 天然是 "icon 在上、title 在下"的 stacked 布局。
 */
#import <React/RCTViewComponentView.h>

NS_ASSUME_NONNULL_BEGIN

@interface BouncyTabBarComponentView : RCTViewComponentView
@end

NS_ASSUME_NONNULL_END
