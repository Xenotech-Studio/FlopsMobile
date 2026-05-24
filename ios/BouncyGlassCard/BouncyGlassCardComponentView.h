/**
 * Fabric ViewComponentView 包装 UIVisualEffectView + UIGlassEffect。
 * iOS 26+ Liquid Glass material + 可选 interactive press scale；React 子 view mount 到
 * effectView.contentView 内，按下时跟卡片一起 scale。
 */
#import <React/RCTViewComponentView.h>

NS_ASSUME_NONNULL_BEGIN

@interface BouncyGlassCardComponentView : RCTViewComponentView
@end

NS_ASSUME_NONNULL_END
