/**
 * Fabric ViewComponentView wrapper around the plain UIKit FlowDocInputView.
 *
 * 这一层非常薄：负责 prop / command / event 的 Fabric 桥接，业务逻辑全在 FlowDocInputView。
 * 设计意图：以后想换到 paper / 别的 host 系统时只换这一层。
 */
#import <React/RCTViewComponentView.h>

NS_ASSUME_NONNULL_BEGIN

@interface FlowDocInputViewComponentView : RCTViewComponentView
@end

NS_ASSUME_NONNULL_END
