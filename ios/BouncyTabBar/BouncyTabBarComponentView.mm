#import "BouncyTabBarComponentView.h"

#import <React/RCTConversions.h>
#import <react/renderer/components/FlopsMobileSpec/ComponentDescriptors.h>
#import <react/renderer/components/FlopsMobileSpec/EventEmitters.h>
#import <react/renderer/components/FlopsMobileSpec/Props.h>
#import <react/renderer/components/FlopsMobileSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

/* 独立 UITabBar 包装。iOS 26+ 自动获得：
 *   - Liquid Glass material（floating pill 形态，全宽自适应）
 *   - 系统切换动画 / 触感反馈
 *   - 每个 item 自动 "icon 上、title 下" stacked 布局
 *   - selectedItem 颜色随系统强调色（除非 selectedTintColorHex 覆盖）
 *
 * 我们只负责：JSON items → UITabBarItem 数组；selectedIndex 双向；delegate didSelectItem
 * → emit onTabSelect；selectedTintColorHex 覆盖 selected 色。 */

/* hex "#RRGGBB" / "#AARRGGBB" → UIColor。空 / 无效 → nil。复用 BouncyButton 同款逻辑。 */
static UIColor *_bsc_uiColorFromHex(NSString *hex) {
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

@interface BouncyTabBarComponentView () <RCTBouncyTabBarViewProtocol, UITabBarDelegate>
@end

@implementation BouncyTabBarComponentView {
  UITabBar *_tabBar;
  NSString *_itemsJson;
  /* 同 BouncySegmentedControl 的处理：缓存 selectedIndex，items 重建后 re-apply，
     防止"初始 selectedIndex=0 跟 default 相等，prop diff 跳 setter，items 重建后
     selectedItem 是 nil"。 */
  NSInteger _selectedIndex;
  /* icon SF point size + title font size 的缓存——任一变了都得重建 items（这俩值是
     在创建 UITabBarItem 时一次性 apply 上去的，没有运行时 setter）。 */
  CGFloat _iconPointSize;
  CGFloat _titleFontSize;
  /* selected tint hex（覆盖 selected icon + title 颜色）；空 = 系统蓝 tint 默认。
     也参与 sizeChanged 触发的 appearance 重建。 */
  NSString *_selectedTintColorHex;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<BouncyTabBarComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    static const auto defaultProps = std::make_shared<const BouncyTabBarProps>();
    _props = defaultProps;
    _selectedIndex = 0;
    _iconPointSize = 0;
    _titleFontSize = 0;

    _tabBar = [[UITabBar alloc] init];
    _tabBar.delegate = self;
    _tabBar.frame = self.bounds;
    _tabBar.autoresizingMask =
        UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    /* iPad 高度塌陷根因：iPad 是 horizontal regular size class，iOS 26 floating UITabBar 在
       regular 下走「退化/紧凑」布局（不是 iPhone 那种 floating pill）→ 高度被压扁。
       用 iOS 17+ traitOverrides 把内部 UITabBar 强制成 compact horizontalSizeClass，
       让它在 iPad 上也按 iPhone 的 floating pill 渲染。 */
    if (@available(iOS 17.0, *)) {
      _tabBar.traitOverrides.horizontalSizeClass = UIUserInterfaceSizeClassCompact;
    }
    /* 标准 UITabBar 默认有顶部 hairline；iOS 13+ 用 UITabBarAppearance 控制。我们这里
       不强行去线——iOS 26 Liquid Glass 模式下系统会接管整套外观；iOS 15..25 留默认。 */
    [self addSubview:_tabBar];
  }
  return self;
}

- (void)prepareForRecycle {
  [super prepareForRecycle];
  _tabBar.items = nil;
  _itemsJson = nil;
  _selectedIndex = 0;
  _iconPointSize = 0;
  _titleFontSize = 0;
  _selectedTintColorHex = nil;
  static const auto defaultProps = std::make_shared<const BouncyTabBarProps>();
  _props = defaultProps;
}

// MARK: - Props

- (void)updateProps:(const Props::Shared &)props oldProps:(const Props::Shared &)oldProps {
  const auto &oldP = *std::static_pointer_cast<const BouncyTabBarProps>(_props);
  const auto &newP = *std::static_pointer_cast<const BouncyTabBarProps>(props);

  /* iconPointSize / titleFontSize / selectedTintColorHex 任一变化都得重建 items + 重新
     生成 UITabBarAppearance（这三个值是在创建 UITabBarItem / 配置 appearance 时一次性
     apply 上去的，没有"运行时改"的 setter）。先缓存值，再用 forceRebuild 标志触发重建。 */
  BOOL sizeChanged = NO;
  if (oldP.iconPointSize != newP.iconPointSize) {
    _iconPointSize = newP.iconPointSize;
    sizeChanged = YES;
  }
  if (oldP.titleFontSize != newP.titleFontSize) {
    _titleFontSize = newP.titleFontSize;
    sizeChanged = YES;
  }
  if (oldP.selectedTintColorHex != newP.selectedTintColorHex) {
    _selectedTintColorHex = RCTNSStringFromString(newP.selectedTintColorHex);
    sizeChanged = YES;
  }
  if (oldP.itemsJson != newP.itemsJson || sizeChanged) {
    NSString *json = RCTNSStringFromString(newP.itemsJson);
    /* sizeChanged 时强制重建：itemsJson 可能没变，应清空缓存让 applyItemsJson 走完整路径 */
    if (sizeChanged) _itemsJson = nil;
    [self applyItemsJson:json];
  }
  if (oldP.selectedIndex != newP.selectedIndex) {
    [self applySelectedIndex:newP.selectedIndex];
  }

  [super updateProps:props oldProps:oldProps];
}

// MARK: - Items rebuild

/* itemsJson schema:
     [
       {"id":"chats","title":"Chats","sfSymbolName":"bubble.left.and.bubble.right"},
       {"id":"tasks","title":"Tasks","sfSymbolName":"list.bullet"},
       ...
     ]
   id 只给 JS 端用（onTabSelect 上报 index，JS 映射到 id）。title 必填。sfSymbolName 可选
   —— 没给的话 tab item 只有文字（iOS 默认会留出 icon 区位但空着）。 */
- (void)applyItemsJson:(NSString *)json {
  if ([_itemsJson isEqualToString:json]) return;
  _itemsJson = [json copy];

  if (json.length == 0) {
    _tabBar.items = nil;
    return;
  }

  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  NSError *err = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
  if (err != nil || ![parsed isKindOfClass:[NSArray class]]) {
    NSLog(@"[BouncyTabBar] itemsJson parse failed: %@ json=%@", err, json);
    _tabBar.items = nil;
    return;
  }
  NSArray *items = (NSArray *)parsed;

  NSMutableArray<UITabBarItem *> *built = [NSMutableArray arrayWithCapacity:items.count];
  for (NSUInteger i = 0; i < items.count; i++) {
    id raw = items[i];
    if (![raw isKindOfClass:[NSDictionary class]]) continue;
    NSDictionary *item = (NSDictionary *)raw;
    NSString *title = item[@"title"];
    NSString *sfSymbolName = item[@"sfSymbolName"];
    if (![title isKindOfClass:[NSString class]]) title = @"";

    UIImage *img = nil;
    if ([sfSymbolName isKindOfClass:[NSString class]] && sfSymbolName.length > 0) {
      if (_iconPointSize > 0) {
        UIImageSymbolConfiguration *symCfg =
            [UIImageSymbolConfiguration configurationWithPointSize:_iconPointSize];
        img = [UIImage systemImageNamed:sfSymbolName withConfiguration:symCfg];
      } else {
        img = [UIImage systemImageNamed:sfSymbolName];
      }
    }
    UITabBarItem *tbi =
        [[UITabBarItem alloc] initWithTitle:title image:img tag:(NSInteger)i];
    [built addObject:tbi];
  }
  _tabBar.items = built;

  /* UITabBarAppearance 应用 selected 色 + （可选）title 字体。
     iOS 26 Liquid Glass UITabBar 走系统外观体系：per-item 的 setTitleTextAttributes: /
     UIColor tint 都会被系统外观盖掉，必须通过 appearance API 才能改。stackedLayoutAppearance
     是 iOS 26 默认的 icon-上 / title-下 布局；另两个 layoutAppearance 也一并设、防 trait
     切换掉色。
     selected 色由 JS 通过 selectedTintColorHex 控制；空 = 系统默认蓝 tint。 */
  UIColor *selectedColor = _bsc_uiColorFromHex(_selectedTintColorHex);

  UITabBarItemAppearance *itemApp = [[UITabBarItemAppearance alloc] init];
  NSMutableDictionary *selectedAttrs = [NSMutableDictionary dictionary];
  if (selectedColor != nil) {
    itemApp.selected.iconColor = selectedColor;
    selectedAttrs[NSForegroundColorAttributeName] = selectedColor;
  }
  if (_titleFontSize > 0) {
    UIFont *font = [UIFont systemFontOfSize:_titleFontSize];
    selectedAttrs[NSFontAttributeName] = font;
    NSDictionary *normalAttrs = @{NSFontAttributeName : font};
    itemApp.normal.titleTextAttributes = normalAttrs;
    itemApp.disabled.titleTextAttributes = normalAttrs;
    itemApp.focused.titleTextAttributes = normalAttrs;
  }
  if (selectedAttrs.count > 0) {
    itemApp.selected.titleTextAttributes = selectedAttrs;
  }

  /* 不要 alloc init 一个新的 UITabBarAppearance——那会重置成默认 opaque 背景，把系统
     iOS 26 的 Liquid Glass material 盖掉。而是 copy 现有 standardAppearance（系统在
     iOS 26 上的初始 appearance 已经是 glass）然后只覆盖 item layout 部分。
     如果 standardAppearance 还没初始化（极少见），fallback init 才接受 opaque 默认。 */
  UITabBarAppearance *appearance =
      [_tabBar.standardAppearance copy] ?: [[UITabBarAppearance alloc] init];
  appearance.stackedLayoutAppearance = itemApp;
  appearance.inlineLayoutAppearance = itemApp;
  appearance.compactInlineLayoutAppearance = itemApp;
  _tabBar.standardAppearance = appearance;
  if (@available(iOS 15.0, *)) {
    _tabBar.scrollEdgeAppearance = appearance;
  }

  /* items 重设后 selectedItem 默认为 nil，得用缓存的 _selectedIndex re-apply */
  [self applySelectedIndex:_selectedIndex];
}

- (void)applySelectedIndex:(NSInteger)idx {
  _selectedIndex = idx;
  NSArray<UITabBarItem *> *items = _tabBar.items;
  if (items.count == 0) return;
  if (idx < 0 || idx >= (NSInteger)items.count) {
    _tabBar.selectedItem = nil;
    return;
  }
  UITabBarItem *target = items[idx];
  if (_tabBar.selectedItem != target) {
    _tabBar.selectedItem = target;
  }
}

// MARK: - UITabBarDelegate

- (void)tabBar:(UITabBar *)tabBar didSelectItem:(UITabBarItem *)item {
  NSInteger idx = [_tabBar.items indexOfObject:item];
  if (idx == NSNotFound) return;
  if (auto eventEmitter =
          std::static_pointer_cast<const BouncyTabBarEventEmitter>(_eventEmitter)) {
    eventEmitter->onTabSelect({.index = static_cast<int>(idx)});
  }
}

@end

Class<RCTComponentViewProtocol> BouncyTabBarCls(void) {
  return BouncyTabBarComponentView.class;
}
