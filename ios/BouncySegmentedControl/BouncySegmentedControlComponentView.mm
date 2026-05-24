#import "BouncySegmentedControlComponentView.h"

#import <React/RCTConversions.h>
#import <react/renderer/components/FlopsMobileSpec/ComponentDescriptors.h>
#import <react/renderer/components/FlopsMobileSpec/EventEmitters.h>
#import <react/renderer/components/FlopsMobileSpec/Props.h>
#import <react/renderer/components/FlopsMobileSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

/* Native UISegmentedControl 包装。iOS 26+ 自动 Liquid Glass material + 系统选段动画，
   不需要任何额外配置。我们只负责：
   - 解析 JSON segments（id + title? + sfSymbolName?）→ 调 setTitle: / setImage: / 或
     attributed string（image attachment + title）支持图标 + 文字同段
   - 双向同步 selectedIndex
   - valueChanged → emit onSegmentChange({ index }) */

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

@interface BouncySegmentedControlComponentView () <RCTBouncySegmentedControlViewProtocol>
@end

@implementation BouncySegmentedControlComponentView {
  UISegmentedControl *_segCtrl;
  NSString *_segmentsJson;
  NSString *_tintColorHex;
  /* 记录当前 selectedIndex，每次 segments 重建后用它 re-apply。
     必要原因：spec default selectedIndex=0，初始 render 时 JS 也常常传 0，updateProps 的
     prop diff 会跳过 applySelectedIndex:；但 UISegmentedControl 刚被 removeAllSegments+
     重新 insert 后默认是 UISegmentedControlNoSegment，没有任何选中态。 */
  NSInteger _selectedIndex;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<BouncySegmentedControlComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    static const auto defaultProps = std::make_shared<const BouncySegmentedControlProps>();
    _props = defaultProps;
    _selectedIndex = 0;

    _segCtrl = [[UISegmentedControl alloc] init];
    _segCtrl.frame = self.bounds;
    _segCtrl.autoresizingMask =
        UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    [_segCtrl addTarget:self
                 action:@selector(handleValueChanged)
       forControlEvents:UIControlEventValueChanged];
    [self addSubview:_segCtrl];
  }
  return self;
}

- (void)prepareForRecycle {
  [super prepareForRecycle];
  [_segCtrl removeAllSegments];
  _segmentsJson = nil;
  _tintColorHex = nil;
  _selectedIndex = 0;
  static const auto defaultProps = std::make_shared<const BouncySegmentedControlProps>();
  _props = defaultProps;
}

// MARK: - Props

- (void)updateProps:(const Props::Shared &)props oldProps:(const Props::Shared &)oldProps {
  const auto &oldP = *std::static_pointer_cast<const BouncySegmentedControlProps>(_props);
  const auto &newP = *std::static_pointer_cast<const BouncySegmentedControlProps>(props);

  if (oldP.segmentsJson != newP.segmentsJson) {
    [self applySegmentsJson:RCTNSStringFromString(newP.segmentsJson)];
  }
  if (oldP.tintColorHex != newP.tintColorHex) {
    [self applyTintColorHex:RCTNSStringFromString(newP.tintColorHex)];
  }
  if (oldP.selectedIndex != newP.selectedIndex) {
    [self applySelectedIndex:newP.selectedIndex];
  }

  [super updateProps:props oldProps:oldProps];
}

// MARK: - Segments rebuild

/* segmentsJson schema:
     [
       {"id": "chats",    "title": "Chats",    "sfSymbolName": "bubble.left.and.bubble.right"},
       {"id": "tasks",    "title": "Tasks",    "sfSymbolName": "list.bullet"},
       ...
     ]
   id 字段当前 native 端不用（onSegmentChange 上报 index，由 JS 端映射到 id）。
   title + sfSymbolName 都给 → attributed string with image attachment（图标 + 文字同段）。
   只给 title → setTitle:。只给 sfSymbolName → setImage:。 */
- (void)applySegmentsJson:(NSString *)json {
  if ([_segmentsJson isEqualToString:json]) return;
  _segmentsJson = [json copy];

  [_segCtrl removeAllSegments];

  if (json.length == 0) return;

  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  NSError *err = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&err];
  if (err != nil || ![parsed isKindOfClass:[NSArray class]]) {
    NSLog(@"[BouncySegCtrl] segmentsJson parse failed: %@ json=%@", err, json);
    return;
  }
  NSArray *items = (NSArray *)parsed;

  for (NSUInteger i = 0; i < items.count; i++) {
    id raw = items[i];
    if (![raw isKindOfClass:[NSDictionary class]]) continue;
    NSDictionary *item = (NSDictionary *)raw;
    NSString *title = item[@"title"];
    NSString *sfSymbolName = item[@"sfSymbolName"];
    BOOL hasTitle = [title isKindOfClass:[NSString class]] && title.length > 0;
    BOOL hasSymbol = [sfSymbolName isKindOfClass:[NSString class]] && sfSymbolName.length > 0;
    UIImage *symbolImg = nil;
    if (hasSymbol) {
      symbolImg = [UIImage systemImageNamed:sfSymbolName];
    }

    /* UISegmentedControl 在单 segment 里 image 和 title 二选一（系统设计限制）。
       约定：title 给了优先用 title（4 个 tab 文字本来就清楚），无 title 再 fallback image。 */
    if (hasTitle) {
      [_segCtrl insertSegmentWithTitle:title atIndex:i animated:NO];
    } else if (symbolImg != nil) {
      [_segCtrl insertSegmentWithImage:symbolImg atIndex:i animated:NO];
    } else {
      // 既无 title 也无 image，跳过避免空段占位
      continue;
    }
  }
  /* 重建 segments 后默认 selectedSegmentIndex = UISegmentedControlNoSegment，得用之前
     缓存的 _selectedIndex 恢复选中态——否则首次 render 是无选中。 */
  [self applySelectedIndex:_selectedIndex];
}

- (void)applyTintColorHex:(NSString *)hex {
  if ([_tintColorHex isEqualToString:hex]) return;
  _tintColorHex = [hex copy];
  UIColor *c = _bsc_uiColorFromHex(hex);
  if (c != nil) {
    _segCtrl.selectedSegmentTintColor = c;
  } else {
    _segCtrl.selectedSegmentTintColor = nil;
  }
}

- (void)applySelectedIndex:(NSInteger)idx {
  _selectedIndex = idx;
  if (idx < 0 || idx >= _segCtrl.numberOfSegments) {
    _segCtrl.selectedSegmentIndex = UISegmentedControlNoSegment;
    return;
  }
  if (_segCtrl.selectedSegmentIndex != idx) {
    _segCtrl.selectedSegmentIndex = idx;
  }
}

// MARK: - Event

- (void)handleValueChanged {
  NSInteger idx = _segCtrl.selectedSegmentIndex;
  if (idx < 0) return;
  if (auto eventEmitter = std::static_pointer_cast<const BouncySegmentedControlEventEmitter>(
          _eventEmitter)) {
    eventEmitter->onSegmentChange({.index = static_cast<int>(idx)});
  }
}

@end

// codegen 通过 componentProvider 拿到这个 class
Class<RCTComponentViewProtocol> BouncySegmentedControlCls(void) {
  return BouncySegmentedControlComponentView.class;
}
