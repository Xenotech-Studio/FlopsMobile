#import "FlowDocInputViewComponentView.h"
#import "FlowDocInputView.h"

#import <React/RCTConversions.h>
#import <react/renderer/components/FlopsMobileSpec/ComponentDescriptors.h>
#import <react/renderer/components/FlopsMobileSpec/EventEmitters.h>
#import <react/renderer/components/FlopsMobileSpec/Props.h>
#import <react/renderer/components/FlopsMobileSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

@interface FlowDocInputViewComponentView () <RCTFlowDocInputViewViewProtocol, FlowDocInputViewDelegate>
@end

@implementation FlowDocInputViewComponentView {
  FlowDocInputView *_inputView;
  /* 刚从回收池里被取出（prepareForRecycle 之后、下次 updateProps 之前）。
     用来强制重新下发 initialContent —— 见 updateProps 里的说明。 */
  BOOL _justRecycled;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<FlowDocInputViewComponentDescriptor>();
}

/* Fabric 把 host component 实例回池时调用。下次它被分配给新 React 节点前，
   清空 inputView 内部状态 + 把 _props 重置成 defaultProps，让后续 updateProps
   把 initialContent / fontSize 等 prop 视为"变化"重新应用。 */
- (void)prepareForRecycle {
  [super prepareForRecycle];
  [_inputView resetForRecycle];
  static const auto defaultProps = std::make_shared<const FlowDocInputViewProps>();
  _props = defaultProps;
  _justRecycled = YES;
}

- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    static const auto defaultProps = std::make_shared<const FlowDocInputViewProps>();
    _props = defaultProps;

    _inputView = [[FlowDocInputView alloc] initWithFrame:self.bounds];
    _inputView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    _inputView.delegate = self;
    self.contentView = _inputView;
  }
  return self;
}

// MARK: - Props

- (void)updateProps:(const Props::Shared &)props oldProps:(const Props::Shared &)oldProps {
  const auto &oldViewProps = *std::static_pointer_cast<const FlowDocInputViewProps>(_props);
  const auto &newViewProps = *std::static_pointer_cast<const FlowDocInputViewProps>(props);

  /* 重要：color / fontSize 等"会影响 attributesForMarks 计算结果"的 prop 必须在
     initialContent 之前应用——否则 setInitialContentJson 走的还是默认的 fg / fontSize，
     等到后续 prop 设新值时再去刷已存在文本就要打补丁。 */
  if (oldViewProps.textColor != newViewProps.textColor) {
    UIColor *c = RCTUIColorFromSharedColor(newViewProps.textColor);
    if (c) [_inputView setTextColor:c];
  }
  if (oldViewProps.pillBackgroundColor != newViewProps.pillBackgroundColor) {
    UIColor *c = RCTUIColorFromSharedColor(newViewProps.pillBackgroundColor);
    if (c) [_inputView setPillBackgroundColor:c];
  }
  if (oldViewProps.pillTextColor != newViewProps.pillTextColor) {
    UIColor *c = RCTUIColorFromSharedColor(newViewProps.pillTextColor);
    if (c) [_inputView setPillTextColor:c];
  }
  if (oldViewProps.fontSize != newViewProps.fontSize) {
    [_inputView setFontSize:newViewProps.fontSize];
  }
  if (oldViewProps.fontFamily != newViewProps.fontFamily) {
    [_inputView setFontFamily:RCTNSStringFromString(newViewProps.fontFamily)];
  }
  /* `|| _justRecycled`：刚被回收复用的 view，textStorage 仍残留上一个 React 节点的内容
     （resetForRecycle 故意不清，避免 doc 滚动复用时闪空一帧）。但若新节点的 initialContent
     恰好等于 codegen 默认值（空 composer = "[]"），old==new 会跳过 setter，残留文本就泄漏出来
     ——典型表现：看完文档返回，文档首块文本出现在空输入框里。回收后强制下发一次 initialContent：
     applyContentJson 用新内容整体替换 attributedText，"[]" 即清空，从根上消除泄漏；对 doc 块
     这种 initialContent 本就 != 默认值的场景行为不变（本来就会 apply），不引入额外闪烁。 */
  if (oldViewProps.initialContent != newViewProps.initialContent || _justRecycled) {
    [_inputView setInitialContentJson:RCTNSStringFromString(newViewProps.initialContent)];
  }
  _justRecycled = NO;
  if (oldViewProps.lineHeight != newViewProps.lineHeight) {
    [_inputView setCustomLineHeight:newViewProps.lineHeight];
  }
  if (oldViewProps.pillMaxLabelTextWidth != newViewProps.pillMaxLabelTextWidth) {
    [_inputView setPillMaxLabelTextWidth:newViewProps.pillMaxLabelTextWidth];
  }
  if (oldViewProps.placeholder != newViewProps.placeholder) {
    [_inputView setPlaceholder:RCTNSStringFromString(newViewProps.placeholder)];
  }
  if (oldViewProps.placeholderColor != newViewProps.placeholderColor) {
    UIColor *c = RCTUIColorFromSharedColor(newViewProps.placeholderColor);
    if (c) [_inputView setPlaceholderColor:c];
  }
  if (oldViewProps.editable != newViewProps.editable) {
    [_inputView setEditable:newViewProps.editable];
  }
  if (oldViewProps.enterCreatesBlock != newViewProps.enterCreatesBlock) {
    [_inputView setEnterCreatesBlock:newViewProps.enterCreatesBlock];
  }
  if (oldViewProps.textContainerInsetTop != newViewProps.textContainerInsetTop ||
      oldViewProps.textContainerInsetLeft != newViewProps.textContainerInsetLeft ||
      oldViewProps.textContainerInsetBottom != newViewProps.textContainerInsetBottom ||
      oldViewProps.textContainerInsetRight != newViewProps.textContainerInsetRight) {
    [_inputView setTextContainerInsets:UIEdgeInsetsMake(newViewProps.textContainerInsetTop,
                                                        newViewProps.textContainerInsetLeft,
                                                        newViewProps.textContainerInsetBottom,
                                                        newViewProps.textContainerInsetRight)];
  }

  [super updateProps:props oldProps:oldProps];
}

// MARK: - Commands

- (void)insertPill:(NSString *)refKey
            mention:(NSString *)mention
              title:(NSString *)title
          isPointer:(BOOL)isPointer {
  [_inputView insertPillWithRefKey:refKey mention:mention title:title isPointer:isPointer];
}

- (void)removePill:(NSString *)refKey {
  [_inputView removePillWithRefKey:refKey];
}

- (void)setContent:(NSString *)contentJson {
  [_inputView setContentJson:contentJson];
}

- (void)applyMark:(NSString *)mark value:(NSString *)value {
  [_inputView applyMark:mark value:value];
}

- (void)removeMark:(NSString *)mark {
  [_inputView removeMark:mark];
}

- (void)focus {
  [_inputView focusInput];
}

- (void)focusAtOffset:(NSInteger)offset {
  [_inputView focusInputAtOffset:offset];
}

- (void)blur {
  [_inputView blurInput];
}

- (void)handleCommand:(const NSString *)commandName args:(const NSArray *)args {
  RCTFlowDocInputViewHandleCommand(self, commandName, args);
}

// MARK: - FlowDocInputViewDelegate

- (void)flowDocInputView:(FlowDocInputView *)v
    didChangeContentJson:(NSString *)contentJson
                pillCount:(NSInteger)pillCount {
  if (auto eventEmitter =
          std::static_pointer_cast<const FlowDocInputViewEventEmitter>(_eventEmitter)) {
    eventEmitter->onChangeContent({
        .contentJson = std::string([contentJson UTF8String]),
        .pillCount = static_cast<int>(pillCount),
    });
  }
}

- (void)flowDocInputView:(FlowDocInputView *)v
 didChangeSelectionStart:(NSInteger)start
                     end:(NSInteger)end {
  if (auto eventEmitter =
          std::static_pointer_cast<const FlowDocInputViewEventEmitter>(_eventEmitter)) {
    eventEmitter->onChangeSelection({
        .start = static_cast<int>(start),
        .end = static_cast<int>(end),
    });
  }
}

- (void)flowDocInputView:(FlowDocInputView *)v didPressPillWithRefKey:(NSString *)refKey {
  if (auto eventEmitter =
          std::static_pointer_cast<const FlowDocInputViewEventEmitter>(_eventEmitter)) {
    eventEmitter->onPillPress({.refKey = std::string([refKey UTF8String])});
  }
}

- (void)flowDocInputViewDidFocus:(FlowDocInputView *)v {
  if (auto eventEmitter =
          std::static_pointer_cast<const FlowDocInputViewEventEmitter>(_eventEmitter)) {
    eventEmitter->onFocusNative({});
  }
}

- (void)flowDocInputViewDidBlur:(FlowDocInputView *)v {
  if (auto eventEmitter =
          std::static_pointer_cast<const FlowDocInputViewEventEmitter>(_eventEmitter)) {
    eventEmitter->onBlurNative({});
  }
}

- (void)flowDocInputView:(FlowDocInputView *)v didChangeContentSize:(CGSize)size {
  if (auto eventEmitter =
          std::static_pointer_cast<const FlowDocInputViewEventEmitter>(_eventEmitter)) {
    eventEmitter->onContentSizeChange({
        .width = static_cast<double>(size.width),
        .height = static_cast<double>(size.height),
    });
  }
}

- (void)flowDocInputView:(FlowDocInputView *)v
   didRequestSplitWithContentJson:(NSString *)contentJson
                           offset:(NSInteger)offset {
  if (auto eventEmitter =
          std::static_pointer_cast<const FlowDocInputViewEventEmitter>(_eventEmitter)) {
    eventEmitter->onSplitRequest({
        .contentJson = std::string([contentJson UTF8String]),
        .offset = static_cast<int>(offset),
    });
  }
}

- (void)flowDocInputView:(FlowDocInputView *)v
   didRequestMergeBackwardWithContentJson:(NSString *)contentJson {
  if (auto eventEmitter =
          std::static_pointer_cast<const FlowDocInputViewEventEmitter>(_eventEmitter)) {
    eventEmitter->onMergeBackwardRequest({
        .contentJson = std::string([contentJson UTF8String]),
    });
  }
}

@end

// 让 RN 在启动时通过 componentProvider 拿到这个 class（与 package.json codegenConfig.ios 对齐）
Class<RCTComponentViewProtocol> FlowDocInputViewCls(void) {
  return FlowDocInputViewComponentView.class;
}
