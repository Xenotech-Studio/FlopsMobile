#import "BouncyGlassCardComponentView.h"

#import <React/RCTConversions.h>
#import <react/renderer/components/FlopsMobileSpec/ComponentDescriptors.h>
#import <react/renderer/components/FlopsMobileSpec/EventEmitters.h>
#import <react/renderer/components/FlopsMobileSpec/Props.h>
#import <react/renderer/components/FlopsMobileSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

/* 通用 Liquid Glass 卡片容器。
 *
 * 内部结构：
 *   self (RCTViewComponentView)
 *     └── _effectView (UIVisualEffectView, glass effect)
 *           └── _effectView.contentView
 *                 └── React children (通过 mountChildComponentView 重定向到这里)
 *
 * 关键设计：
 * - 子 view mount 到 effectView.contentView 而非 self，这样系统 interactive glass scale
 *   会带着 children 一起形变（这跟之前 BouncyButton.glassButton 的 mount-into-button 同
 *   思路，但 UIVisualEffectView 的 contentView 是公开 API、行为稳定，比 UIButton 内部
 *   layout 可靠）。
 * - interactive=YES 时 system 处理按下 scale + 折光；onPress 通过 UITapGestureRecognizer
 *   单独 emit（cancelsTouchesInView=NO，touch 还能穿到 children 比如 TextInput 让 keyboard
 *   弹出）。
 * - cornerRadius 用 layer.cornerRadius + maskedCorners 控制；effectView 也跟着 mask。
 * - iOS < 26 没有 UIGlassEffect，effectView.effect 留 nil 时是透明 container；callsite
 *   可以走 JS fallback 不用这个组件。 */

static UIColor *_bgc_uiColorFromHex(NSString *hex) {
  if (hex.length == 0) return nil;
  NSString *s = hex;
  if ([s hasPrefix:@"#"]) s = [s substringFromIndex:1];
  unsigned int rgba = 0;
  if (![[NSScanner scannerWithString:s] scanHexInt:&rgba]) return nil;
  CGFloat r, g, b, a;
  if (s.length == 8) {
    a = ((rgba >> 24) & 0xff) / 255.0;
    r = ((rgba >> 16) & 0xff) / 255.0;
    g = ((rgba >> 8) & 0xff) / 255.0;
    b = (rgba & 0xff) / 255.0;
  } else if (s.length == 6) {
    a = 1.0;
    r = ((rgba >> 16) & 0xff) / 255.0;
    g = ((rgba >> 8) & 0xff) / 255.0;
    b = (rgba & 0xff) / 255.0;
  } else {
    return nil;
  }
  return [UIColor colorWithRed:r green:g blue:b alpha:a];
}

@interface BouncyGlassCardComponentView () <RCTBouncyGlassCardViewProtocol,
                                              UIGestureRecognizerDelegate>
@end

@implementation BouncyGlassCardComponentView {
  UIVisualEffectView *_effectView;
  /* 配置缓存 */
  BOOL _interactive;
  CGFloat _cornerRadius;
  NSString *_tintColorHex;
  /* press 检测 */
  UITapGestureRecognizer *_tapRecognizer;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<BouncyGlassCardComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    static const auto defaultProps = std::make_shared<const BouncyGlassCardProps>();
    _props = defaultProps;
    _interactive = YES;
    _cornerRadius = 0;

    _effectView = [[UIVisualEffectView alloc] initWithEffect:nil];
    _effectView.frame = self.bounds;
    _effectView.autoresizingMask =
        UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    _effectView.clipsToBounds = YES;
    [self addSubview:_effectView];

    [self refreshEffect];
    [self refreshTap];
  }
  return self;
}

- (void)prepareForRecycle {
  [super prepareForRecycle];
  _interactive = YES;
  _cornerRadius = 0;
  self.layer.cornerRadius = 0;
  _effectView.layer.cornerRadius = 0;
  _tintColorHex = nil;
  [self refreshEffect];
  [self refreshTap];
  static const auto defaultProps = std::make_shared<const BouncyGlassCardProps>();
  _props = defaultProps;
}

// MARK: - Props

- (void)updateProps:(const Props::Shared &)props oldProps:(const Props::Shared &)oldProps {
  const auto &oldP = *std::static_pointer_cast<const BouncyGlassCardProps>(_props);
  const auto &newP = *std::static_pointer_cast<const BouncyGlassCardProps>(props);

  BOOL effectDirty = NO;
  if (oldP.interactive != newP.interactive) {
    _interactive = newP.interactive;
    effectDirty = YES;
  }
  if (oldP.tintColorHex != newP.tintColorHex) {
    _tintColorHex = RCTNSStringFromString(newP.tintColorHex);
    effectDirty = YES;
  }
  if (oldP.cornerRadius != newP.cornerRadius) {
    _cornerRadius = newP.cornerRadius;
    self.layer.cornerRadius = _cornerRadius;
    _effectView.layer.cornerRadius = _cornerRadius;
  }
  if (effectDirty) {
    [self refreshEffect];
    [self refreshTap];
  }

  [super updateProps:props oldProps:oldProps];
}

// MARK: - Layout

/* 每次 layout 无条件重申圆角 + clip + effectView frame。
   动机：+ 按钮的 UIMenu（iOS 26 context menu）弹出后，系统对 composer 所在层做 dim/morph 快照，
   dismiss 回来时圆角会被丢一帧（"圆角没了、等一下才恢复"）。圆角是静态 prop，updateProps 只在值
   变化时才写 layer，menu 关闭不会重设。
   关键：不能用 `if (self.layer.cornerRadius != _cornerRadius)` 跳过——UIMenu 的 morph 动画作用在
   presentation layer 上，model layer 的 cornerRadius 保持不变，`!=` 检查永远为假 → 重申被跳过、
   直角残留。改成无条件写：morph-back 每一帧 layout 都把 cornerRadius 重新提交到模型层（并触发
   presentation 层重算），回来的每一帧就是圆角，消除闪烁。self / effectView 两层都写，masksToBounds
   兜住 glass 材质填充，顺带把 effectView.frame 对齐 bounds 防错位。 */
- (void)layoutSubviews {
  [super layoutSubviews];
  self.layer.cornerRadius = _cornerRadius;
  self.layer.masksToBounds = YES;
  _effectView.layer.cornerRadius = _cornerRadius;
  _effectView.layer.masksToBounds = YES;
  _effectView.frame = self.bounds;
}

// MARK: - Glass effect + tap setup

- (void)refreshEffect {
  if (@available(iOS 26.0, *)) {
    UIGlassEffect *glass = [UIGlassEffect effectWithStyle:UIGlassEffectStyleRegular];
    glass.interactive = _interactive;
    UIColor *tint = _bgc_uiColorFromHex(_tintColorHex);
    if (tint != nil) glass.tintColor = tint;
    _effectView.effect = glass;
  } else {
    /* iOS < 26：保留 effectView 但 effect = nil（透明 container）。callsite 若要 fallback
       visual 应当走 JS 自绘背景。 */
    _effectView.effect = nil;
  }
}

/* tap 识别 + onPress emit。cancelsTouchesInView = NO 让 touch 继续传到 children（比如
   wrap 一个 TextInput 时 keyboard 还能弹出来）。
   delegate.shouldRecognizeSimultaneouslyWith → YES 让本 recognizer 跟内部子 view 的手势
   并发识别——典型场景：wrap UITextView 时，UITextView 内部一组 selection 手势（双击选词 /
   三击选行 / 长按 magnifier / 拖选）跟我们的 outer tap 没有 requireToFail 关系；如果不走
   simultaneous，outer tap recognize 完会 force-fail UITextView 那一组，用户感受到的就是
   "选择不稳定 / 偶尔双击不出选词"。simultaneous=YES 后两边 recognizer 独立竞争状态机，
   UITextView 选择手势完全恢复。 */
- (void)refreshTap {
  if (_tapRecognizer != nil) {
    [_effectView removeGestureRecognizer:_tapRecognizer];
    _tapRecognizer = nil;
  }
  if (_interactive) {
    _tapRecognizer = [[UITapGestureRecognizer alloc] initWithTarget:self
                                                             action:@selector(handleTap)];
    _tapRecognizer.cancelsTouchesInView = NO;
    _tapRecognizer.delegate = self;
    [_effectView addGestureRecognizer:_tapRecognizer];
  }
}

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer
       shouldRecognizeSimultaneouslyWithGestureRecognizer:
           (UIGestureRecognizer *)otherGestureRecognizer {
  return YES;
}

/* 仅当 tap 命中"非交互区域"（卡片本身的 padding / 空白）时本 recognizer 才接 touch；
   命中子 UITextView / UIControl (UIButton 等) 时直接 NO →让那些子组件用自己默认的 tap 语义
   处理（光标落到点击位置 / 触发按钮 action），onPress 不会被多余触发。
   典型场景：composer 卡片里 wrap 一个 UITextView + 一个绝对定位 + 按钮——文字区 tap 让
   UITextView 自己处理 cursor placement / selection，+ 上 tap 让 UIButton 自己跑 action，
   只有 padding 空白处 tap 才触发 onGlassPress（callsite 通常用来 focus 输入 / 跳到末尾）。 */
- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer
       shouldReceiveTouch:(UITouch *)touch {
  UIView *v = touch.view;
  while (v != nil && v != self) {
    if ([v isKindOfClass:[UITextView class]] || [v isKindOfClass:[UIControl class]]) {
      return NO;
    }
    v = v.superview;
  }
  return YES;
}

- (void)handleTap {
  if (auto eventEmitter =
          std::static_pointer_cast<const BouncyGlassCardEventEmitter>(_eventEmitter)) {
    eventEmitter->onGlassPress({});
  }
}

// MARK: - Child mounting

/* React 子 view mount 到 effectView.contentView 而非 self——这样系统 interactive glass
   按下时的 scale 会带着 children 一起形变（contentView 是 UIVisualEffectView 的标准
   公开 API，给 client 放 subview 的地方）。
   先 super.mountChild 让 Fabric 完整登记 child；再 addSubview 到 contentView 让 UIKit
   重新 parent 它。unmount 时同理：若 child 在 contentView 里就直接 remove，不走 super
   （super 会 assert child 在 self.currentContainerView 里）。 */
- (void)mountChildComponentView:(UIView<RCTComponentViewProtocol> *)childComponentView
                          index:(NSInteger)index {
  [super mountChildComponentView:childComponentView index:index];
  [_effectView.contentView addSubview:childComponentView];
}

- (void)unmountChildComponentView:(UIView<RCTComponentViewProtocol> *)childComponentView
                            index:(NSInteger)index {
  if (childComponentView.superview == _effectView.contentView) {
    [childComponentView removeFromSuperview];
  } else {
    [super unmountChildComponentView:childComponentView index:index];
  }
}

@end

Class<RCTComponentViewProtocol> BouncyGlassCardCls(void) {
  return BouncyGlassCardComponentView.class;
}
