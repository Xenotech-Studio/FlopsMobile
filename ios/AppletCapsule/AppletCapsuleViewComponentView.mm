#import "AppletCapsuleViewComponentView.h"

#import <react/renderer/components/FlopsMobileSpec/ComponentDescriptors.h>
#import <react/renderer/components/FlopsMobileSpec/EventEmitters.h>
#import <react/renderer/components/FlopsMobileSpec/Props.h>
#import <react/renderer/components/FlopsMobileSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

/* 全屏 Applet 右上角胶囊，纯 CALayer 绘制（一比一对齐桌面 AppView 的 phoneCapsule）。
 *
 * 结构：所有可视 layer 挂在 _container（一个独立 sublayer）上——不碰 self.layer 的 border /
 * cornerRadius / backgroundColor（那些归 RCTViewComponentView 按 RN style props 管，避免打架）。
 *   _container (圆角16 + 0.5边框 + masksToBounds)
 *     ├─ _leftBg / _rightBg  两半底色（按下对应半块加深）
 *     ├─ _dots[3]            左半三圆点
 *     ├─ _divider            中缝竖线
 *     └─ _ring + _ringDot    右半圆环（描边圈 + 中心实心点）
 *
 * 交互：touchesBegan 按落点判定左/右半 → 该半 bg 变暗；touchesEnded 若仍在同半内 → emit
 * onPressLeft / onPressRight。尺寸由 RN style（width 87 / height 32）决定，layout 全按 bounds 算。 */

// —— 视觉常量（pt）——
static const CGFloat kRadius = 16.0;
static const CGFloat kBorder = 0.5;
static const CGFloat kDotSize = 3.0;
static const CGFloat kDotGap = 3.0;
static const CGFloat kDividerW = 1.0;
static const CGFloat kDividerH = 18.0;
static const CGFloat kRingSize = 15.0;
static const CGFloat kRingStroke = 1.5;
static const CGFloat kRingDot = 6.5;

static CGColorRef _ac_black(CGFloat a) { return [UIColor colorWithWhite:0.0 alpha:a].CGColor; }
static CGColorRef _ac_white(CGFloat a) { return [UIColor colorWithWhite:1.0 alpha:a].CGColor; }

@interface AppletCapsuleViewComponentView () <RCTAppletCapsuleViewViewProtocol>
@end

@implementation AppletCapsuleViewComponentView {
  CALayer *_container;
  CALayer *_leftBg;
  CALayer *_rightBg;
  CALayer *_dots[3];
  CALayer *_divider;
  CALayer *_ring;
  CALayer *_ringDot;
  NSInteger _pressedSide;  // 0 无 / 1 左 / 2 右
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<AppletCapsuleViewComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    static const auto defaultProps = std::make_shared<const AppletCapsuleViewProps>();
    _props = defaultProps;
    _pressedSide = 0;
    self.userInteractionEnabled = YES;

    _container = [CALayer layer];
    _container.cornerRadius = kRadius;
    _container.borderWidth = kBorder;
    _container.borderColor = _ac_white(0.28);
    _container.masksToBounds = YES;
    [self.layer addSublayer:_container];

    _leftBg = [CALayer layer];
    _leftBg.backgroundColor = _ac_black(0.28);
    [_container addSublayer:_leftBg];
    _rightBg = [CALayer layer];
    _rightBg.backgroundColor = _ac_black(0.28);
    [_container addSublayer:_rightBg];

    for (int i = 0; i < 3; i++) {
      _dots[i] = [CALayer layer];
      _dots[i].backgroundColor = _ac_white(0.9);
      _dots[i].cornerRadius = kDotSize / 2.0;
      [_container addSublayer:_dots[i]];
    }

    _divider = [CALayer layer];
    _divider.backgroundColor = _ac_white(0.28);
    [_container addSublayer:_divider];

    _ring = [CALayer layer];
    _ring.backgroundColor = [UIColor clearColor].CGColor;
    _ring.borderWidth = kRingStroke;
    _ring.borderColor = _ac_white(0.9);
    _ring.cornerRadius = kRingSize / 2.0;
    [_container addSublayer:_ring];

    _ringDot = [CALayer layer];
    _ringDot.backgroundColor = _ac_white(0.9);
    _ringDot.cornerRadius = kRingDot / 2.0;
    [_container addSublayer:_ringDot];
  }
  return self;
}

- (void)layoutSubviews {
  [super layoutSubviews];
  const CGFloat w = self.bounds.size.width;
  const CGFloat h = self.bounds.size.height;
  if (w <= 0 || h <= 0) return;
  const CGFloat mid = w / 2.0;

  // 布局变更不做隐式动画（否则 resize/首帧会看到 layer 飘移）。
  [CATransaction begin];
  [CATransaction setDisableActions:YES];

  _container.frame = self.bounds;
  _leftBg.frame = CGRectMake(0, 0, mid, h);
  _rightBg.frame = CGRectMake(mid, 0, w - mid, h);

  // 左半三圆点：整组水平居中于左半，垂直居中
  const CGFloat dotsW = kDotSize * 3 + kDotGap * 2;
  const CGFloat dotsStartX = mid / 2.0 - dotsW / 2.0;
  const CGFloat dotY = h / 2.0 - kDotSize / 2.0;
  for (int i = 0; i < 3; i++) {
    _dots[i].frame = CGRectMake(dotsStartX + i * (kDotSize + kDotGap), dotY, kDotSize, kDotSize);
  }

  // 中缝竖线：绝对居中
  _divider.frame = CGRectMake(mid - kDividerW / 2.0, (h - kDividerH) / 2.0, kDividerW, kDividerH);

  // 右半圆环 + 中心点：居中于右半
  const CGFloat rcx = mid + (w - mid) / 2.0;
  _ring.frame = CGRectMake(rcx - kRingSize / 2.0, h / 2.0 - kRingSize / 2.0, kRingSize, kRingSize);
  _ringDot.frame = CGRectMake(rcx - kRingDot / 2.0, h / 2.0 - kRingDot / 2.0, kRingDot, kRingDot);

  [CATransaction commit];
}

// MARK: - Props（本组件无自定义 props，视觉全 native 定死；仍需实现以接住 RN style）

- (void)updateProps:(const Props::Shared &)props oldProps:(const Props::Shared &)oldProps {
  [super updateProps:props oldProps:oldProps];
}

- (void)prepareForRecycle {
  [super prepareForRecycle];
  _pressedSide = 0;
  [self applyPressedSide:0];
  static const auto defaultProps = std::make_shared<const AppletCapsuleViewProps>();
  _props = defaultProps;
}

// MARK: - Press feedback

- (NSInteger)sideForPoint:(CGPoint)p {
  return (p.x < self.bounds.size.width / 2.0) ? 1 : 2;
}

- (void)applyPressedSide:(NSInteger)side {
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  _leftBg.backgroundColor = (side == 1) ? _ac_black(0.5) : _ac_black(0.28);
  _rightBg.backgroundColor = (side == 2) ? _ac_black(0.5) : _ac_black(0.28);
  [CATransaction commit];
}

- (void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  UITouch *t = touches.anyObject;
  if (!t) {
    [super touchesBegan:touches withEvent:event];
    return;
  }
  _pressedSide = [self sideForPoint:[t locationInView:self]];
  [self applyPressedSide:_pressedSide];
}

- (void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  UITouch *t = touches.anyObject;
  if (!t || _pressedSide == 0) return;
  // 手指拖出胶囊 → 松开高亮（不取消 side，回到胶囊内仍可点亮 / 触发）
  BOOL inside = [self pointInside:[t locationInView:self] withEvent:event];
  [self applyPressedSide:inside ? _pressedSide : 0];
}

- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  UITouch *t = touches.anyObject;
  NSInteger started = _pressedSide;
  _pressedSide = 0;
  [self applyPressedSide:0];
  if (!t || started == 0) return;
  CGPoint p = [t locationInView:self];
  BOOL inside = [self pointInside:p withEvent:event];
  if (inside && [self sideForPoint:p] == started) {
    if (started == 1) {
      [self emitLeft];
    } else {
      [self emitRight];
    }
  }
}

- (void)touchesCancelled:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  _pressedSide = 0;
  [self applyPressedSide:0];
}

// MARK: - Events

- (void)emitLeft {
  if (auto emitter =
          std::static_pointer_cast<const AppletCapsuleViewEventEmitter>(_eventEmitter)) {
    emitter->onPressLeft({});
  }
}

- (void)emitRight {
  if (auto emitter =
          std::static_pointer_cast<const AppletCapsuleViewEventEmitter>(_eventEmitter)) {
    emitter->onPressRight({});
  }
}

@end

// codegen 通过 componentProvider 拿到这个 class（与 package.json codegenConfig.ios 对齐）
Class<RCTComponentViewProtocol> AppletCapsuleViewCls(void) {
  return AppletCapsuleViewComponentView.class;
}
