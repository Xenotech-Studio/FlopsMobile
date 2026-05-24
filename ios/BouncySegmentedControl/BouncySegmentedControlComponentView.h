/**
 * Fabric ViewComponentView wrapper around UISegmentedControl.
 * iOS 26+ 自动 Liquid Glass + 系统切换动画；iOS 15..25 是常规 UISegmentedControl 样式。
 */
#import <React/RCTViewComponentView.h>

NS_ASSUME_NONNULL_BEGIN

@interface BouncySegmentedControlComponentView : RCTViewComponentView
@end

NS_ASSUME_NONNULL_END
