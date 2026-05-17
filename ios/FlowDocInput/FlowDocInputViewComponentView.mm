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
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<FlowDocInputViewComponentDescriptor>();
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

  if (oldViewProps.initialContent != newViewProps.initialContent) {
    [_inputView setInitialContentJson:RCTNSStringFromString(newViewProps.initialContent)];
  }
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
  if (oldViewProps.lineHeight != newViewProps.lineHeight) {
    [_inputView setCustomLineHeight:newViewProps.lineHeight];
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

@end

// 让 RN 在启动时通过 componentProvider 拿到这个 class（与 package.json codegenConfig.ios 对齐）
Class<RCTComponentViewProtocol> FlowDocInputViewCls(void) {
  return FlowDocInputViewComponentView.class;
}
