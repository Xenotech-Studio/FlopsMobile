#import "BouncyButtonViewComponentView.h"

#import <React/RCTConversions.h>
#import <objc/runtime.h>
#import <react/renderer/components/FlopsMobileSpec/ComponentDescriptors.h>
#import <react/renderer/components/FlopsMobileSpec/EventEmitters.h>
#import <react/renderer/components/FlopsMobileSpec/Props.h>
#import <react/renderer/components/FlopsMobileSpec/RCTComponentViewHelpers.h>

@class BouncyButtonViewComponentView;

/* 全局活跃 menu views 集合：menu 打开期间 BouncyButtonViewComponentView 自己 add 到这里；
 * UIApplication.sendEvent: 的 swizzle 看到任何 touch began 就遍历这个集合通知 dismiss。
 * weak 引用避免 view 被释放后悬挂；同一时刻 iOS UIMenu 也只能开一个，集合实际多半只有 1 元素。 */
static NSHashTable<BouncyButtonViewComponentView *> *gBBActiveMenuViews;

@interface BouncyButtonViewComponentView (BBMenuDismissPrivate)
- (void)bb_dismissFromSwizzle;
@end

/* swizzle UIApplication.sendEvent: —— 每个 UIEvent 都必经此方法（包括 touches / motion /
 * remote control）。menu 期间任何 touchPhaseBegan 立即 → dismiss。
 *
 * 为什么走 swizzle 而不是 gesture recognizer：试过把 BBAnyTouchRecognizer 挂在 app window
 * 上、加 UIWindowDidBecomeVisible/Hidden notification 装到 overlay window 上、放 canPrevent
 * 那一套——iOS 26 UIMenu 的 dismiss view 把 touch 拦在 view-level 内部，window-level
 * recognizer 不 fire；overlay window 实测也不发 Visible/Hidden notification。sendEvent 是
 * UIKit dispatch 入口、所有 event 必经，绕不过去。实机验证同毫秒 emit dismiss。 */
@interface UIApplication (BBMenuDismissSwizzle)
@end

@implementation UIApplication (BBMenuDismissSwizzle)

+ (void)load {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Method orig = class_getInstanceMethod([UIApplication class], @selector(sendEvent:));
    Method swiz = class_getInstanceMethod([UIApplication class], @selector(bb_swizzledSendEvent:));
    if (orig != NULL && swiz != NULL) {
      method_exchangeImplementations(orig, swiz);
    }
  });
}

- (void)bb_swizzledSendEvent:(UIEvent *)event {
  /* 先抓状态 —— 在调原始 sendEvent 之前判断"是否要触发 dismiss"。如果倒过来（先调原始
   * 再判断），原始那次 dispatch 里的 handleGlassTouchDown 会刚把 self 加到 gBBActiveMenuViews，
   * 我们的判断就把 menu 同一帧又 dismiss 了 —— FAB tap 自爆。 */
  BOOL shouldDismiss = NO;
  if (event.type == UIEventTypeTouches && gBBActiveMenuViews.count > 0) {
    for (UITouch *t in event.allTouches) {
      if (t.phase == UITouchPhaseBegan) {
        shouldDismiss = YES;
        break;
      }
    }
  }
  [self bb_swizzledSendEvent:event];  // 调原始（swap 后这个名字指向 original IMP）
  if (shouldDismiss) {
    /* 拷一份 snapshot 再遍历——dismiss 过程中 view 会 remove 自己，原集合不能直接迭代。 */
    NSArray<BouncyButtonViewComponentView *> *snap = [gBBActiveMenuViews allObjects];
    for (BouncyButtonViewComponentView *v in snap) {
      [v bb_dismissFromSwizzle];
    }
  }
}

@end

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
  // 当前 glass material tint + prominence（控制按钮 base color / 实色感）
  NSString *_glassTintColorHex;
  BOOL _glassProminent;
  // iOS < 26 legacy 路径
  BOOL _pressing;
  CGFloat _pressScale;
  BOOL _bouncyDisabled;
  // menu 生命周期：UIMenu 没公开 dismiss callback，自己维护"打开/关闭"状态机供 JS 联动。
  // dismiss 信号来源（任一先到都触发 finishMenuDismiss）：
  //   1. UIAction handler (用户选 item 时)
  //   2. UIApplication.sendEvent: swizzle (用户 menu 外 touch 时) — 快路径，~1 帧
  //   3. NSTimer poll 视图树 _UIContextMenu* class (非 touch dismiss 兜底，比如 app 切后台)
  BOOL _menuPresenting;
  NSTimer *_menuDismissPollTimer;
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
    /* 完整重建 cfg 回 regular glassButtonConfiguration —— 不能只清字段，因为上次用例如果是
       prominentGlassButtonConfiguration，cfg 类型本身就跟 ivar reset 后的 (_glassProminent=NO)
       不一致；后续 updateProps 里 applyGlassTint 的 diff 检查可能错判 "config 类型没变"，导致
       prominent cfg 残留 + 下次 mount 行为错乱 → 触发 crash。每次回收都重建 cfg 干净起步。 */
    if (@available(iOS 26.0, *)) {
      UIButtonConfiguration *cfg = [UIButtonConfiguration glassButtonConfiguration];
      cfg.contentInsets = NSDirectionalEdgeInsetsZero;
      cfg.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
      cfg.image = nil;
      cfg.title = nil;
      cfg.attributedTitle = nil;
      cfg.baseBackgroundColor = nil;
      cfg.baseForegroundColor = nil;
      cfg.showsActivityIndicator = NO;
      _glassButton.configuration = cfg;
    }
    _glassTintColorHex = nil;
    _glassProminent = NO;
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
  /* recycle 时若上一次 menu 还在 polling，得停了 timer + 清状态。
     emit dismiss 此时不发——view 已经从屏幕上拿走，下游 JS 也无意义。 */
  if (_menuDismissPollTimer) {
    [_menuDismissPollTimer invalidate];
    _menuDismissPollTimer = nil;
  }
  if (gBBActiveMenuViews) [gBBActiveMenuViews removeObject:self];
  _menuPresenting = NO;
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
      cfg.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
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
  if (oldViewProps.glassTintColorHex != newViewProps.glassTintColorHex ||
      oldViewProps.glassProminent != newViewProps.glassProminent) {
    if (_glassButton) {
      [self applyGlassTint:RCTNSStringFromString(newViewProps.glassTintColorHex)
                 prominent:newViewProps.glassProminent];
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

/* mountChildComponentView 在 glass 路径下调 bringSubviewToFront 把 child 推到 _glassButton
 * 之上，**破坏了 Fabric 跟踪的 (index → child) 对应关系**。super.unmountChildComponentView
 * 会断言 `self.currentContainerView.subviews[index] == child`，已经 reorder 必崩。
 * 这里 glass 路径直接 removeFromSuperview 跳过 super 的 assert；child 仍然是 self 的 subview，
 * 移除就是真正的卸载、Fabric 自己之后的 reconcile 也正确。
 * 之前 Fab/HeaderCircleButton 用 iosSfSymbol 走 native title 路径 shouldRenderChildren=false,
 * 根本没 React child 被 mount，所以没暴露这个 bug。folder tab 用 Text children 才触发。 */
- (void)unmountChildComponentView:(UIView<RCTComponentViewProtocol> *)childComponentView
                            index:(NSInteger)index {
  if (_glassButton && childComponentView.superview == self) {
    [childComponentView removeFromSuperview];
    return;
  }
  [super unmountChildComponentView:childComponentView index:index];
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
    /* menu 模式：scale spring 不跑（让系统 morph 接管视觉），但要 emit menu-will-show 让
       上层 JS 做联动（搜索框 morph 等）。touchDown 比 menu 实际可视稍早一帧，对 JS 那侧
       width 动画来说反而是个好起点——动画 200ms~ 跟 menu 同步弹起。 */
    [self emitMenuWillShowAndStartDismissWatcher];
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
  /* 按 sectionBreakBefore 把 actions 分成若干区段：>1 段时每段包成一个 displayInline 子菜单，
     iOS 在区段之间自动画分隔线；只有 1 段时退回扁平 children（视觉与不分段一致）。 */
  NSMutableArray<NSMutableArray<UIAction *> *> *groups = [NSMutableArray array];
  NSMutableArray<UIAction *> *currentGroup = [NSMutableArray array];
  [groups addObject:currentGroup];
  for (id raw in items) {
    if (![raw isKindOfClass:[NSDictionary class]]) continue;
    NSDictionary *item = (NSDictionary *)raw;
    NSString *actionId = item[@"id"];
    NSString *title = item[@"title"];
    if (![actionId isKindOfClass:[NSString class]] || ![title isKindOfClass:[NSString class]]) {
      continue;
    }
    if ([item[@"sectionBreakBefore"] boolValue] && currentGroup.count > 0) {
      currentGroup = [NSMutableArray array];
      [groups addObject:currentGroup];
    }
    BOOL destructive = [item[@"destructive"] boolValue];
    BOOL disabled = [item[@"disabled"] boolValue];
    NSString *capturedId = [actionId copy];
    /* image：SF Symbol 名 → UIImage（做菜单项左侧图标）。 */
    UIImage *actionImage = nil;
    NSString *imageName = item[@"image"];
    if ([imageName isKindOfClass:[NSString class]] && imageName.length > 0) {
      actionImage = [UIImage systemImageNamed:imageName];
    }
    UIAction *uia = [UIAction actionWithTitle:title
                                        image:actionImage
                                   identifier:nil
                                      handler:^(__kindof UIAction *_Nonnull _action) {
                                        [weakSelf emitMenuActionId:capturedId];
                                      }];
    UIMenuElementAttributes attrs = 0;
    if (destructive) attrs |= UIMenuElementAttributesDestructive;
    if (disabled) attrs |= UIMenuElementAttributesDisabled;
    if (attrs != 0) uia.attributes = attrs;
    /* state：'on' 显示 ✓、'mixed' 显示 -、其它/缺省为 off。用于把菜单项当开关。 */
    NSString *stateStr = item[@"state"];
    if ([stateStr isKindOfClass:[NSString class]]) {
      if ([stateStr isEqualToString:@"on"]) uia.state = UIMenuElementStateOn;
      else if ([stateStr isEqualToString:@"mixed"]) uia.state = UIMenuElementStateMixed;
    }
    [currentGroup addObject:uia];
  }

  /* 收集非空区段。 */
  NSMutableArray<NSArray<UIAction *> *> *sections = [NSMutableArray array];
  for (NSMutableArray<UIAction *> *g in groups) {
    if (g.count > 0) [sections addObject:g];
  }

  if (sections.count == 0) {
    _glassButton.menu = nil;
    _glassButton.showsMenuAsPrimaryAction = NO;
    return;
  }

  if (sections.count == 1) {
    _glassButton.menu = [UIMenu menuWithChildren:sections.firstObject];
  } else {
    NSMutableArray<UIMenu *> *inlineMenus = [NSMutableArray arrayWithCapacity:sections.count];
    for (NSArray<UIAction *> *g in sections) {
      [inlineMenus addObject:[UIMenu menuWithTitle:@""
                                             image:nil
                                        identifier:nil
                                           options:UIMenuOptionsDisplayInline
                                          children:g]];
    }
    _glassButton.menu = [UIMenu menuWithChildren:inlineMenus];
  }
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
  /* UIAction 触发即视为 menu dismiss——iOS UIMenu 选完一项后立即开始关闭动画，没有再 surface
     的窗口。dismiss-by-outside-tap 走 swizzle 路径瞬时；polling 兜底非 touch dismiss。 */
  [self finishMenuDismiss];
}

// MARK: - Menu lifecycle (will-show / did-dismiss)

/* JS 侧需要"菜单打开 / 关闭"两端信号来联动同行控件（典型场景：TodayScreen 右下 FAB 弹菜单
   时，左边搜索框 morph 成圆）。UIButton + showsMenuAsPrimaryAction 的 UIMenu 没公开
   present/dismiss callback，所以自己拼三条线（任一先到即关，后到走 _menuPresenting 首 if
   nop）：
   - will-show：handleGlassTouchDown 进入 menu 模式时主动 emit（touchDown 是 menu 即将弹的
     最早 hook，比实际可视早一帧；JS 200ms~ width 动画刚好跟弹层同步起来）。
   - did-dismiss：
     (a) UIAction handler emit 选中 + 立即视为关闭。
     (b) UIApplication.sendEvent: swizzle（顶部）：menu 期间任何 touch began → 同步 dismiss。
         主路径，~1 帧延迟，实机验证同毫秒 emit。试过 window-level recognizer 不 fire (iOS
         UIMenu dismiss view 把 touch 拦在 view-level)、试过 UIWindowDidBecomeVisible/Hidden
         notification 不发，最后落 swizzle。
     (c) NSTimer 周期性扫 key window 子树找 _UIContextMenu* class 没了即关闭。慢路径
         兜底（系统切前后台 / app 强制取消等非 touch dismiss）。200ms 间隔，CPU 几乎零。

   私有类名 string-contains 检查（(c)），避免直接调用私有 API（不调方法、不发 selector），
   符合 App Store 规则边界。无法识别 menu overlay 也不会卡死——polling 30s 超时兜底。 */
/* polling 是慢路径兜底，仅给非 touch dismiss（app 切前后台 / 系统强制取消 / app 自己
   setMenu:nil 等）保命。主路径是 sendEvent swizzle，dismiss 延迟基本同毫秒。
   200ms 够保守、CPU 几乎零开销。 */
static const NSTimeInterval kMenuDismissPollInterval = 0.2;
static const NSTimeInterval kMenuPollStartDelay = 0.25;  // 留时间让 menu 实际可视
static const NSTimeInterval kMenuMaxLifetime = 30.0;     // 兜底：menu 不可能开这么久

- (void)emitMenuWillShowAndStartDismissWatcher {
  if (_menuPresenting) return;
  _menuPresenting = YES;
  /* 注册到全局活跃 menu views——swizzled UIApplication.sendEvent 会查这个集合。
     hashtable 用 weak ref，self 释放时自动从集合移除（避免悬挂指针）。 */
  static dispatch_once_t hashOnce;
  dispatch_once(&hashOnce, ^{
    gBBActiveMenuViews = [NSHashTable weakObjectsHashTable];
  });
  [gBBActiveMenuViews addObject:self];
  if (auto eventEmitter =
          std::static_pointer_cast<const BouncyButtonViewEventEmitter>(_eventEmitter)) {
    eventEmitter->onMenuWillShow({});
  }
  /* polling 慢路径兜底（非 touch dismiss 用）。 */
  __weak __typeof(self) weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,
                               (int64_t)(kMenuPollStartDelay * NSEC_PER_SEC)),
                 dispatch_get_main_queue(),
                 ^{
    __strong __typeof(self) ss = weakSelf;
    if (!ss || !ss->_menuPresenting) return;
    [ss startMenuDismissPolling];
  });
}

- (void)startMenuDismissPolling {
  if (_menuDismissPollTimer) return;
  __weak __typeof(self) weakSelf = self;
  NSDate *startedAt = [NSDate date];
  _menuDismissPollTimer =
      [NSTimer scheduledTimerWithTimeInterval:kMenuDismissPollInterval
                                      repeats:YES
                                        block:^(NSTimer *_Nonnull timer) {
    __strong __typeof(self) ss = weakSelf;
    if (!ss || !ss->_menuPresenting) {
      [timer invalidate];
      return;
    }
    if (-[startedAt timeIntervalSinceNow] > kMenuMaxLifetime) {
      [ss finishMenuDismiss];
      return;
    }
    if (![ss isContextMenuOverlayPresentInAnyWindow]) {
      [ss finishMenuDismiss];
    }
  }];
}

- (BOOL)isContextMenuOverlayPresentInAnyWindow {
  if (@available(iOS 13.0, *)) {
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
      if (![scene isKindOfClass:[UIWindowScene class]]) continue;
      UIWindowScene *ws = (UIWindowScene *)scene;
      for (UIWindow *win in ws.windows) {
        if ([self viewSubtreeContainsContextMenuOverlay:win]) return YES;
      }
    }
  } else {
    /* iOS 12 不会走 glass 路径，理论上到不了这里；兜底走 keyWindow。 */
    UIWindow *win = UIApplication.sharedApplication.keyWindow;
    if (win && [self viewSubtreeContainsContextMenuOverlay:win]) return YES;
  }
  return NO;
}

- (BOOL)viewSubtreeContainsContextMenuOverlay:(UIView *)view {
  NSString *cls = NSStringFromClass([view class]);
  /* UIButton.menu (showsMenuAsPrimaryAction) 走 UIContextMenu 内部基础架构，overlay container
     的私有类名以 "_UIContextMenu" 起头（_UIContextMenuPlatterTransitionView /
     _UIContextMenuContainerView 等）。"EditMenu" 是 iOS 16+ UIEditMenuInteraction 的类前缀，
     UIButton menu 不走它，但放一起做兜底也无害。 */
  if ([cls hasPrefix:@"_UIContextMenu"] || [cls hasPrefix:@"_UIEditMenu"]) {
    return YES;
  }
  for (UIView *sub in view.subviews) {
    if ([self viewSubtreeContainsContextMenuOverlay:sub]) return YES;
  }
  return NO;
}

- (void)bb_dismissFromSwizzle {
  [self finishMenuDismiss];
}

- (void)finishMenuDismiss {
  if (!_menuPresenting) return;
  _menuPresenting = NO;
  [gBBActiveMenuViews removeObject:self];
  if (_menuDismissPollTimer) {
    [_menuDismissPollTimer invalidate];
    _menuDismissPollTimer = nil;
  }
  if (auto eventEmitter =
          std::static_pointer_cast<const BouncyButtonViewEventEmitter>(_eventEmitter)) {
    eventEmitter->onMenuDidDismiss({});
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

/* 切 glass 材质的着色 + prominent/regular 基础 config。
 *
 * 行为：
 *   - glassButtonConfiguration  (prominent=NO)：半透明玻璃，baseBackgroundColor 给玻璃淡淡 tint。
 *   - prominentGlassButtonConfiguration (prominent=YES)：更"实"的有色块，baseBackgroundColor
 *     是主体颜色（类似 Apple 自家 primary action 按钮）。
 *   - tintHex 为空：不上色，按对应 config 的默认（透明 / 系统色）。
 *
 * 切换 base config 会**整个替换** UIButtonConfiguration，所以这里要把已经 apply 过的 sfSymbol /
 * title / spinner / colors 全部从 ivar 重新写回新 config，否则切完之后这些 native content
 * 会丢。 */
- (void)applyGlassTint:(NSString *)tintHex prominent:(BOOL)prominent {
  /* 把 nil / "" 当同一个状态比较（recycle 后 ivar 是 nil，但 prop 默认是 ""）。 */
  NSString *normNew = tintHex ?: @"";
  NSString *normCur = _glassTintColorHex ?: @"";
  if ([normCur isEqualToString:normNew] && _glassProminent == prominent) return;
  _glassTintColorHex = [normNew copy];
  _glassProminent = prominent;

  if (!_glassButton) return;
  if (@available(iOS 26.0, *)) {
    UIButtonConfiguration *cfg = prominent
        ? [UIButtonConfiguration prominentGlassButtonConfiguration]
        : [UIButtonConfiguration glassButtonConfiguration];
    cfg.contentInsets = NSDirectionalEdgeInsetsZero;
    /* 强制 capsule cornerStyle：glass material（特别是 prominent variant）默认会用某种
       动态 / 较小的 cornerStyle，渲染出来的可视玻璃形状比 button bounds 小 → 「选中 tab
       看着比未选中的还矮」就是这个原因。capsule 让 glass material 跟随 bounds 走两端
       半圆，跟 React 那侧 borderRadius:18 视觉一致。Fab/HeaderCircle (width=height) 时
       capsule 等价于圆形也不影响。 */
    cfg.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
    /* tint：上到 baseBackgroundColor，prominent 模式下 = 主体色，regular 模式下 = 玻璃 tint */
    UIColor *bgColor = _bb_uiColorFromHex(tintHex);
    cfg.baseBackgroundColor = bgColor;
    /* 把之前 apply 过的 image / title / spinner / foreground tint 全部从 ivar 写回新 config —— 否则
       切 config 会丢这些 native content。 */
    if (_sfSymbolName.length > 0) {
      CGFloat sz = _sfSymbolPointSize > 0 ? _sfSymbolPointSize : 22;
      UIImageSymbolConfiguration *symCfg =
          [UIImageSymbolConfiguration configurationWithPointSize:sz];
      cfg.image = [UIImage systemImageNamed:_sfSymbolName withConfiguration:symCfg];
    }
    if (_nativeTitle.length > 0) cfg.title = _nativeTitle;
    UIColor *fg = _bb_uiColorFromHex(
        _sfSymbolColorHex.length > 0 ? _sfSymbolColorHex : _nativeTitleColorHex);
    cfg.baseForegroundColor = fg;
    cfg.showsActivityIndicator = _showsActivityIndicator;
    _glassButton.configuration = cfg;
  }
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
