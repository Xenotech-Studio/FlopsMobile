/**
 * Fabric codegen spec for AppletCapsuleView (iOS only).
 *
 * 全屏 Applet 右上角的「胶囊」控件（对齐桌面版 AppView 的手机胶囊观感）。RN 里用
 * borderWidth:0.5 + overflow:hidden + 半透明色画这东西会有锯齿/毛边，改走原生 CALayer 绘制
 * （AppletCapsuleViewComponentView.mm），一比一还原：
 *   - 宽 87 × 高 32、圆角 16、底色 rgba(0,0,0,0.28)、边框 0.5 rgba(255,255,255,0.28)
 *   - 左半三圆点（3×3、间距 3、白 0.9）｜中缝竖线（1×18、白 0.28）｜右半圆环（外圈 15 stroke1.5 + 中心点 6.5）
 *   - 按下对应半块整体加深到 rgba(0,0,0,0.5)；左半点击 → onPressLeft，右半 → onPressRight
 *
 * 尺寸不写死在 native：由 JS 侧 style 传 width/height（callsite 用 87×32）。
 * Android 端不实现；JS 侧按 Platform.OS 走 RN 兜底（或不提供 applet 入口）。
 *
 * Note: 放在 src/flowdoc-native-input/spec/ 是因为这是 codegenConfig.jsSrcsDir 指向的目录，
 * codegen 扫该目录所有 *.ts，多组件共存。
 */
import type { HostComponent, ViewProps } from 'react-native';
import { codegenNativeComponent } from 'react-native';
import type { DirectEventHandler } from 'react-native/Libraries/Types/CodegenTypes';

type PressEvent = Readonly<{}>;

interface NativeProps extends ViewProps {
  /** 点左半（三圆点）→ 展开菜单 */
  onPressLeft?: DirectEventHandler<PressEvent>;
  /** 点右半（圆环）→ 关闭 applet（goBack） */
  onPressRight?: DirectEventHandler<PressEvent>;
}

export default codegenNativeComponent<NativeProps>('AppletCapsuleView') as HostComponent<NativeProps>;
