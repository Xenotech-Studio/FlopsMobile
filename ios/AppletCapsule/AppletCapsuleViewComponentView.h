/**
 * Fabric ViewComponentView：全屏 Applet 右上角胶囊（三圆点 | 圆环）。
 * 纯 CALayer 绘制，避免 RN 侧 borderWidth:0.5 + overflow:hidden + 半透明色的锯齿/毛边。
 * 两半各自可点：左→onPressLeft（展开菜单）、右→onPressRight（关闭 applet）；按下对应半块加深。
 */
#import <React/RCTViewComponentView.h>

NS_ASSUME_NONNULL_BEGIN

@interface AppletCapsuleViewComponentView : RCTViewComponentView
@end

NS_ASSUME_NONNULL_END
