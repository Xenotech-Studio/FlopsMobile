/**
 * Fabric ViewComponentView wrapper around BouncyButtonView.
 * 薄一层 prop / event 桥接，业务逻辑全在 BouncyButtonView。
 */
#import <React/RCTViewComponentView.h>

NS_ASSUME_NONNULL_BEGIN

@interface BouncyButtonViewComponentView : RCTViewComponentView
@end

NS_ASSUME_NONNULL_END
