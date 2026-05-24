#import "BouncyButtonViewComponentView.h"

#import <React/RCTConversions.h>
#import <react/renderer/components/FlopsMobileSpec/ComponentDescriptors.h>
#import <react/renderer/components/FlopsMobileSpec/EventEmitters.h>
#import <react/renderer/components/FlopsMobileSpec/Props.h>
#import <react/renderer/components/FlopsMobileSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

/* 双轨实现：
 *
 * iOS 26+：托管一个真 UIButton + [UIButtonConfiguration glassButtonConfiguration]。
 *   Liquid Glass material 由系统渲染；按下时的 scale + 折光 + spring + bend 全部由
 *   系统的 interactive glass 自动处理——我们一行动画代码都不写。target-action 发我们
 *   的 onBouncyPress 事件。这是"让系统决定"的路子，跟 FlowTaskIOS（SwiftUI Toolbar
 *   Button）在视觉/触感上对齐。
 *   关键：React 子 view（icon Text）必须 mount 到 UIButton 内部，这样它们才会随
 *   interactive glass 一起被系统形变；否则只有玻璃底动、icon 不动会看起来错位。
 *
 * iOS < 26：保留原有手写实现——UIView + touchesBegan/Ended + usingSpringWithDamping
 *   缩放动画。没有 Liquid Glass material 可用，JS 侧也会保留白圈 + 阴影的视觉。 */

static const NSTimeInterval kPressDuration = 0.18;
static const CGFloat kPressBounce = 0.0;
static const NSTimeInterval kReleaseDuration = 0.5;
static const CGFloat kReleaseBounce = 0.35;

@interface BouncyButtonViewComponentView () <RCTBouncyButtonViewViewProtocol>
@end

@implementation BouncyButtonViewComponentView {
  // iOS 26+ glass 路径
  UIButton *_glassButton;
  // 当前正在用的 menu actions JSON（用来 diff，决定是否要重建 UIMenu）
  NSString *_menuActionsJson;
  // 当前 SF Symbol 配置（用来 diff，决定是否重建 UIImage）
  NSString *_sfSymbolName;
  CGFloat _sfSymbolPointSize;
  NSString *_sfSymbolColorHex;
  // 当前 native title 配置
  NSString *_nativeTitle;
  NSString *_nativeTitleColorHex;
  // 当前 spinner 状态
  BOOL _showsActivityIndicator;
  // iOS < 26 legacy 路径
  BOOL _pressing;
  CGFloat _pressScale;
  BOOL _bouncyDisabled;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<BouncyButtonViewComponentDescriptor>();
}

- (void)prepareForRecycle {
  [super prepareForRecycle];
  if (_glassButton) {
    _glassButton.enabled = YES;
    _glassButton.menu = nil;
    _glassButton.showsMenuAsPrimaryAction = NO;
    /* glass 路径：reset _glassButton + 所有 children 的 transform 到 identity
       （我们的新动画不动 self.layer，但动它们；recycle 要清干净）。 */
    _glassButton.layer.transform = CATransform3DIdentity;
    for (UIView *sub in self.subviews) {
      if (sub == _glassButton) continue;
      sub.layer.transform = CATransform3DIdentity;
    }
    /* self.layer.transform 也要 reset：callsite 可能给 React 加了 `transform: [{ translateY }]`
       (e.g. ProjectScreen Fab 用 translateY:8 补 UITabBar padding)，view 回收后 Fabric 给下
       一个 callsite (e.g. TodayScreen Fab 没 transform) 复用时不会主动清，导致 translateY
       串台到下个屏。 */
    self.layer.transform = CATransform3DIdentity;
    // SF Symbol image / title / spinner / tint 也要清，下个用例可能完全不同
    UIButtonConfiguration *cfg = _glassButton.configuration;
    cfg.image = nil;
    cfg.title = nil;
    cfg.attributedTitle = nil;
    cfg.showsActivityIndicator = NO;
    cfg.baseForegroundColor = nil;
    _glassButton.configuration = cfg;
  } else {
    self.layer.transform = CATransform3DIdentity;
    _pressing = NO;
  }
  _menuActionsJson = nil;
  _sfSymbolName = nil;
  _sfSymbolPointSize = 0;
  _sfSymbolColorHex = nil;
  _nativeTitle = nil;
  _nativeTitleColorHex = nil;
  _showsActivityIndicator = NO;
  _pressScale = 1.12;
  _bouncyDisabled = NO;
  static const auto defaultProps = std::make_shared<const BouncyButtonViewProps>();
  _props = defaultProps;
}

- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    static const auto defaultProps = std::make_shared<const BouncyButtonViewProps>();
    _props = defaultProps;
    _pressScale = 1.12;
    _bouncyDisabled = NO;
    _pressing = NO;

    if (@available(iOS 26.0, *)) {
      _glassButton = [UIButton buttonWithType:UIButtonTypeSystem];
      UIButtonConfiguration *cfg = [UIButtonConfiguration glassButtonConfiguration];
      /* 把 configuration 的内置 content padding 抹零——React 这边自己控制布局，glass
         material 是纯背景，不需要给 image/title 留 padding。 */
      cfg.contentInsets = NSDirectionalEdgeInsetsZero;
      /* 显式抹掉 configuration 可能附带的 image/title/tint 填充。glass material 只做
         透明玻璃背景，所有可视内容来自 React 子 view。否则 configuration 可能用默认
         label color 画一个深色 container 出来，跟 React 的 icon 叠出"两个圈"的错觉。 */
      cfg.image = nil;
      cfg.title = nil;
      cfg.attributedTitle = nil;
      cfg.baseBackgroundColor = nil;
      cfg.baseForegroundColor = nil;
      _glassButton.configuration = cfg;
      _glassButton.frame = self.bounds;
      _glassButton.autoresizingMask =
          UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
      /* 系统 interactive glass 默认只对玻璃 material 做 subtle 形变；icon 在 self 直接子
         view 层、没在 UIButton 内部，所以不跟着动。再挂一组 target-action 在 self.layer
         上做整体 scale spring——这样 icon + 玻璃一起放大缩小，跟"原生按钮整个鼓一下"
         一致。touch-down/drag-enter 放大，up/cancel/drag-exit 缩回。 */
      [_glassButton addTarget:self
                       action:@selector(handleGlassTouchDown)
             forControlEvents:UIControlEventTouchDown | UIControlEventTouchDragEnter];
      [_glassButton addTarget:self
                       action:@selector(handleGlassTouchUp)
             forControlEvents:UIControlEventTouchUpInside | UIControlEventTouchUpOutside |
                              UIControlEventTouchDragExit | UIControlEventTouchCancel];
      [_glassButton addTarget:self
                       action:@selector(handleGlassPress)
             forControlEvents:UIControlEventTouchUpInside];
      [self addSubview:_glassButton];
      NSLog(@"[BouncyButton] glass path init bounds=%@", NSStringFromCGRect(self.bounds));
    } else {
      self.userInteractionEnabled = YES;
      self.layer.anchorPoint = CGPointMake(0.5, 0.5);
      NSLog(@"[BouncyButton] legacy path init bounds=%@", NSStringFromCGRect(self.bounds));
    }
  }
  return self;
}

// MARK: - Props

- (void)updateProps:(const Props::Shared &)props oldProps:(const Props::Shared &)oldProps {
  const auto &oldViewProps = *std::static_pointer_cast<const BouncyButtonViewProps>(_props);
  const auto &newViewProps = *std::static_pointer_cast<const BouncyButtonViewProps>(props);

  if (oldViewProps.pressScale != newViewProps.pressScale) {
    _pressScale = newViewProps.pressScale > 0 ? newViewProps.pressScale : 1.12;
  }
  if (oldViewProps.bouncyDisabled != newViewProps.bouncyDisabled) {
    _bouncyDisabled = newViewProps.bouncyDisabled;
    if (_glassButton) {
      _glassButton.enabled = !_bouncyDisabled;
    }
  }
  if (oldViewProps.menuActionsJson != newViewProps.menuActionsJson) {
    if (_glassButton) {
      [self applyMenuActionsJson:RCTNSStringFromString(newViewProps.menuActionsJson)];
    }
  }
  if (oldViewProps.sfSymbolName != newViewProps.sfSymbolName ||
      oldViewProps.sfSymbolPointSize != newViewProps.sfSymbolPointSize ||
      oldViewProps.sfSymbolColorHex != newViewProps.sfSymbolColorHex) {
    if (_glassButton) {
      [self applySfSymbolName:RCTNSStringFromString(newViewProps.sfSymbolName)
                    pointSize:newViewProps.sfSymbolPointSize
                     colorHex:RCTNSStringFromString(newViewProps.sfSymbolColorHex)];
    }
  }
  if (oldViewProps.nativeTitle != newViewProps.nativeTitle ||
      oldViewProps.nativeTitleColorHex != newViewProps.nativeTitleColorHex) {
    if (_glassButton) {
      [self applyNativeTitle:RCTNSStringFromString(newViewProps.nativeTitle)
                    colorHex:RCTNSStringFromString(newViewProps.nativeTitleColorHex)];
    }
  }
  if (oldViewProps.showsActivityIndicator != newViewProps.showsActivityIndicator) {
    if (_glassButton) {
      [self applyShowsActivityIndicator:newViewProps.showsActivityIndicator];
    }
  }

  [super updateProps:props oldProps:oldProps];

  /* glass 模式下兜底：JS 那侧应该已经 strip 掉 bg/shadow 了，但万一 IS_IOS_LIQUID_GLASS
     检测没生效（Platform.Version 异常 / 模拟器不是 iOS 26 等），这里 native 再保险地把
     Fabric 已经应用到 self.layer 上的 bg / shadow / border 全清掉，让 glass material 独占视觉。 */
  if (_glassButton) {
    self.backgroundColor = [UIColor clearColor];
    self.layer.backgroundColor = [UIColor clearColor].CGColor;
    self.layer.shadowOpacity = 0;
    self.layer.shadowColor = nil;
    self.layer.borderWidth = 0;
    self.layer.borderColor = nil;
  }
}

// MARK: - Child mounting

/* glass 模式下 React 子 view 的策略：
 *
 * 让 super 走默认 mount（child 进 Fabric 的 currentContainerView，可能是 self 也可能是
 * 一个内部 _containerView），然后 bringSubviewToFront 把 child 顶到 _glassButton 上面
 * （z-order），并禁掉 child 的 user interaction 让 touch 自然落到下层 _glassButton。
 *
 * 不再尝试把 child 重新 addSubview 进 _glassButton——之前那个 trick 在 Debug 模拟器
 * 看着 ok，但 TestFlight Release build 实测上 icon 不跟 self.layer.transform 一起视觉
 * 缩放（怀疑是 Fabric 的 _containerView clipping / Release 变体里 RCTViewComponentView
 * 的 layer 结构跟 Debug 不一致，cascade 失效）。改成在 touch handler 里**显式 animate
 * 每个 non-_glassButton subview 的 layer.transform**，不依赖 cascade，所有 build config
 * 行为一致（详见 handleGlassTouchDown）。 */
- (void)mountChildComponentView:(UIView<RCTComponentViewProtocol> *)childComponentView
                          index:(NSInteger)index {
  [super mountChildComponentView:childComponentView index:index];
  if (_glassButton) {
    [self bringSubviewToFront:childComponentView];
    childComponentView.userInteractionEnabled = NO;
  }
}

// MARK: - Touch / event handling (glass path)

/* menu 模式下 iOS 26 的 UIButton + glass material 会自动做"按钮 morph 成菜单容器"
   的过渡动画——按下时按钮形态向菜单 anchor 方向延展，体感上像按钮"流"进菜单。
   我们手挂的 scale spring（self.layer.transform）会盖住这个 morph，所以 menu 模式
   下直接 skip。普通 onBouncyPress 模式才走 scale spring（系统玻璃自带的反馈太弱，
   用户验证过需要我们加大）。 */
- (BOOL)glassIsInMenuMode {
  return _glassButton != nil && _glassButton.menu != nil &&
         _glassButton.showsMenuAsPrimaryAction;
}

- (void)handleGlassTouchDown {
  if ([self glassIsInMenuMode]) {
    return;
  }
  [self animateGlassAndChildrenToScale:_pressScale
                              duration:kPressDuration
                                bounce:kPressBounce];
}

- (void)handleGlassTouchUp {
  if ([self glassIsInMenuMode]) {
    return;
  }
  [self animateGlassAndChildrenToScale:1.0
                              duration:kReleaseDuration
                                bounce:kReleaseBounce];
}

/* 显式动 _glassButton.layer + 所有其它 self.subviews 的 layer.transform——不依赖父→子
   cascade。原因详见 mountChildComponentView 上面的注释（Release build cascade 失效）。
   逐个 subview 显式 scale 后，无论 React children 是直接挂在 self 上还是被 Fabric 套了
   一层 _containerView（其内部会再 cascade），都能正确缩放；不会双重缩放，因为我们没
   动 self.layer.transform 本身（保持 identity）。 */
- (void)animateGlassAndChildrenToScale:(CGFloat)scale
                              duration:(NSTimeInterval)duration
                                bounce:(CGFloat)bounce {
  CGFloat damping = MAX(0.1, MIN(1.0, 1.0 - bounce));
  UIViewAnimationOptions opts = UIViewAnimationOptionAllowUserInteraction |
                                UIViewAnimationOptionBeginFromCurrentState;
  CATransform3D t = CATransform3DMakeScale(scale, scale, 1.0);
  [UIView animateWithDuration:duration
                        delay:0
       usingSpringWithDamping:damping
        initialSpringVelocity:0
                      options:opts
                   animations:^{
                     self->_glassButton.layer.transform = t;
                     for (UIView *sub in self.subviews) {
                       if (sub == self->_glassButton) continue;
                       sub.layer.transform = t;
                     }
                   }
                   completion:nil];
}

- (void)handleGlassPress {
  /* menu 模式下 UIButton 把 tap 转给 UIMenu 弹出（showsMenuAsPrimaryAction），onBouncyPress
     不应再发——发了 JS 那侧又会触发自绘 popover，跟原生 menu 重叠。
     menu actions 数组为空时就是普通按钮，正常 emit。 */
  if (_glassButton && _glassButton.menu != nil && _glassButton.showsMenuAsPrimaryAction) {
    return;
  }
  if (auto eventEmitter =
          std::static_pointer_cast<const BouncyButtonViewEventEmitter>(_eventEmitter)) {
    eventEmitter->onBouncyPress({});
  }
}

// MARK: - UIMenu wiring (glass path, iOS 26+)

/* 用 menuActionsJson 字符串重建 UIMenu。空字符串 / "[]" / 无效 JSON → 清掉 menu，回退到
   普通按钮（onBouncyPress 模式）。每个 UIAction 的 handler 通过弱引用 emit onMenuAction
   带上对应 actionId；不在 handler 里持有 self，避免 retain cycle。 */
- (void)applyMenuActionsJson:(NSString *)json {
  if ([_menuActionsJson isEqualToString:json]) {
    return;
  }
  _menuActionsJson = [json copy];

  if (!_glassButton) {
    return;
  }

  if (json.length == 0) {
    _glassButton.menu = nil;
    _glassButton.showsMenuAsPrimaryAction = NO;
    return;
  }

  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  NSError *err = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
  if (err != nil || ![parsed isKindOfClass:[NSArray class]]) {
    NSLog(@"[BouncyButton] menuActionsJson parse failed: %@ json=%@", err, json);
    _glassButton.menu = nil;
    _glassButton.showsMenuAsPrimaryAction = NO;
    return;
  }
  NSArray *items = (NSArray *)parsed;
  if (items.count == 0) {
    _glassButton.menu = nil;
    _glassButton.showsMenuAsPrimaryAction = NO;
    return;
  }

  __weak __typeof(self) weakSelf = self;
  NSMutableArray<UIAction *> *uiActions = [NSMutableArray arrayWithCapacity:items.count];
  for (id raw in items) {
    if (![raw isKindOfClass:[NSDictionary class]]) continue;
    NSDictionary *item = (NSDictionary *)raw;
    NSString *actionId = item[@"id"];
    NSString *title = item[@"title"];
    if (![actionId isKindOfClass:[NSString class]] || ![title isKindOfClass:[NSString class]]) {
      continue;
    }
    BOOL destructive = [item[@"destructive"] boolValue];
    BOOL disabled = [item[@"disabled"] boolValue];
    NSString *capturedId = [actionId copy];
    UIAction *uia = [UIAction actionWithTitle:title
                                        image:nil
                                   identifier:nil
                                      handler:^(__kindof UIAction *_Nonnull _action) {
                                        [weakSelf emitMenuActionId:capturedId];
                                      }];
    UIMenuElementAttributes attrs = 0;
    if (destructive) attrs |= UIMenuElementAttributesDestructive;
    if (disabled) attrs |= UIMenuElementAttributesDisabled;
    if (attrs != 0) uia.attributes = attrs;
    [uiActions addObject:uia];
  }

  if (uiActions.count == 0) {
    _glassButton.menu = nil;
    _glassButton.showsMenuAsPrimaryAction = NO;
    return;
  }

  _glassButton.menu = [UIMenu menuWithChildren:uiActions];
  _glassButton.showsMenuAsPrimaryAction = YES;
  /* 进 menu 模式：把任何残留的手挂 scale 重置回 identity，让系统 morph 的起点干净。
     非 menu 模式的动画现在动的是 _glassButton + 每个 child，不是 self.layer，所以这里
     也要清这些。 */
  _glassButton.layer.transform = CATransform3DIdentity;
  for (UIView *sub in self.subviews) {
    if (sub == _glassButton) continue;
    sub.layer.transform = CATransform3DIdentity;
  }
}

- (void)emitMenuActionId:(NSString *)actionId {
  if (auto eventEmitter =
          std::static_pointer_cast<const BouncyButtonViewEventEmitter>(_eventEmitter)) {
    eventEmitter->onMenuAction({.actionId = std::string([actionId UTF8String])});
  }
}

// MARK: - SF Symbol (glass path, iOS 26+)

/* hex "#RRGGBB" / "#AARRGGBB" → UIColor。空 / 无效 → nil（caller 用 nil 表示用系统默认）。 */
static UIColor *_bb_uiColorFromHex(NSString *hex) {
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

/* 把 SF Symbol 设进 UIButton.configuration.image。name 空 → 清掉 image（让 JS 子 view
   接管显示）。color hex 空 → 用系统默认（label color）。pointSize <= 0 → 默认 22。
   diff 走 ivar 比较：name / size / color 任一变才重建 UIImage（避免每渲染刷一遍图像）。 */
- (void)applySfSymbolName:(NSString *)name
                pointSize:(CGFloat)pointSize
                 colorHex:(NSString *)colorHex {
  if ([_sfSymbolName isEqualToString:name] && _sfSymbolPointSize == pointSize &&
      [_sfSymbolColorHex isEqualToString:colorHex]) {
    return;
  }
  _sfSymbolName = [name copy];
  _sfSymbolPointSize = pointSize;
  _sfSymbolColorHex = [colorHex copy];

  if (!_glassButton) return;

  UIButtonConfiguration *cfg = _glassButton.configuration;
  if (name.length == 0) {
    cfg.image = nil;
    cfg.baseForegroundColor = nil;
    _glassButton.configuration = cfg;
    return;
  }

  CGFloat sz = pointSize > 0 ? pointSize : 22;
  UIImageSymbolConfiguration *symCfg =
      [UIImageSymbolConfiguration configurationWithPointSize:sz];
  UIImage *img = [UIImage systemImageNamed:name withConfiguration:symCfg];
  if (img == nil) {
    NSLog(@"[BouncyButton] SF Symbol '%@' not found on this iOS version", name);
    cfg.image = nil;
    cfg.baseForegroundColor = nil;
    _glassButton.configuration = cfg;
    return;
  }
  cfg.image = img;
  UIColor *tint = _bb_uiColorFromHex(colorHex);
  cfg.baseForegroundColor = tint;
  _glassButton.configuration = cfg;
}

/* native title 写进 UIButton.configuration.title，文字成为按钮 native content。空字符串
   清掉 title。colorHex 控制 title 颜色（跟 SF Symbol image 共享 baseForegroundColor——
   两者同时存在时颜色一致；如果想分别着色未来再拆 attributedTitle）。 */
- (void)applyNativeTitle:(NSString *)title colorHex:(NSString *)colorHex {
  if ([_nativeTitle isEqualToString:title] && [_nativeTitleColorHex isEqualToString:colorHex]) {
    return;
  }
  _nativeTitle = [title copy];
  _nativeTitleColorHex = [colorHex copy];

  if (!_glassButton) return;

  UIButtonConfiguration *cfg = _glassButton.configuration;
  cfg.title = title.length > 0 ? title : nil;
  UIColor *tint = _bb_uiColorFromHex(colorHex);
  if (tint != nil) {
    cfg.baseForegroundColor = tint;
  }
  _glassButton.configuration = cfg;
}

/* iOS 16+ UIButton 内置 spinner：设 YES 系统自动用 UIActivityIndicatorView 取代 title/image。
   spinner 也是 button native content 的一部分，跟 button 一起 scale。 */
- (void)applyShowsActivityIndicator:(BOOL)shows {
  if (_showsActivityIndicator == shows) return;
  _showsActivityIndicator = shows;

  if (!_glassButton) return;

  UIButtonConfiguration *cfg = _glassButton.configuration;
  cfg.showsActivityIndicator = shows;
  _glassButton.configuration = cfg;
}

// MARK: - Hit testing (legacy path only)

- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
  if (_glassButton) {
    /* glass path：让 UIKit 走正常的 hitTest 链路，touch 自然落到 UIButton 上。
       glass material 的 interactive 反馈 + target-action 都由 UIButton 处理。 */
    return [super hitTest:point withEvent:event];
  }
  /* legacy path：截走任何落入 bounds 的 touch，避免 React 子 view（icon Text）
     截走 touch 让 self 的 touchesBegan 永远不跑。 */
  if (!self.userInteractionEnabled || self.hidden || self.alpha < 0.01) {
    return nil;
  }
  if ([self pointInside:point withEvent:event]) {
    return self;
  }
  return nil;
}

// MARK: - Animation (legacy path only)

- (void)animateToScale:(CGFloat)scale
              duration:(NSTimeInterval)duration
                bounce:(CGFloat)bounce {
  CGFloat damping = MAX(0.1, MIN(1.0, 1.0 - bounce));
  UIViewAnimationOptions opts = UIViewAnimationOptionAllowUserInteraction |
                                UIViewAnimationOptionBeginFromCurrentState;
  [UIView animateWithDuration:duration
                        delay:0
       usingSpringWithDamping:damping
        initialSpringVelocity:0
                      options:opts
                   animations:^{
                     self.layer.transform = CATransform3DMakeScale(scale, scale, 1.0);
                   }
                   completion:nil];
}

// MARK: - Touch handling (legacy path only — glass path uses UIButton target-action)

- (void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  if (_glassButton) {
    [super touchesBegan:touches withEvent:event];
    return;
  }
  if (_bouncyDisabled) {
    [super touchesBegan:touches withEvent:event];
    return;
  }
  _pressing = YES;
  [self animateToScale:_pressScale duration:kPressDuration bounce:kPressBounce];
}

- (void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  if (_glassButton) {
    [super touchesMoved:touches withEvent:event];
  }
  // legacy: 不动 — 哪怕手指拖到 view 边缘也保持放大状态
}

- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  if (_glassButton) {
    [super touchesEnded:touches withEvent:event];
    return;
  }
  if (!_pressing) {
    return;
  }
  _pressing = NO;
  UITouch *t = touches.anyObject;
  CGPoint p = [t locationInView:self];
  BOOL inside = [self pointInside:p withEvent:event];
  [self animateToScale:1.0 duration:kReleaseDuration bounce:kReleaseBounce];
  if (inside) {
    if (auto eventEmitter =
            std::static_pointer_cast<const BouncyButtonViewEventEmitter>(_eventEmitter)) {
      eventEmitter->onBouncyPress({});
    }
  }
}

- (void)touchesCancelled:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
  if (_glassButton) {
    [super touchesCancelled:touches withEvent:event];
    return;
  }
  if (!_pressing) {
    return;
  }
  _pressing = NO;
  [self animateToScale:1.0 duration:kReleaseDuration bounce:kReleaseBounce];
}

@end

// codegen 通过 componentProvider 拿到这个 class（与 package.json codegenConfig.ios 对齐）
Class<RCTComponentViewProtocol> BouncyButtonViewCls(void) {
  return BouncyButtonViewComponentView.class;
}
