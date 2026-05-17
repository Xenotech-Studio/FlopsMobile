/**
 * FlowDocInputView
 *
 * Plain UIKit 层的可编辑富文本框：内部一个 UITextView + 一个 placeholder UILabel。
 * 支持以 NSTextAttachment 形式插入「原子 pill」，pill 在 NSAttributedString 里占一个
 * Object Replacement Character (U+FFFC)；光标跨越 / 退格删除走系统的原生原子语义。
 *
 * Fabric 层（FlowDocInputViewComponentView）只负责 prop / command / event 桥接，
 * 业务逻辑都在这里。这样保持 Fabric 层薄，便于未来跨架构复用。
 */
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@class FlowDocInputView;

@protocol FlowDocInputViewDelegate <NSObject>
@optional
- (void)flowDocInputView:(FlowDocInputView *)v
    didChangeContentJson:(NSString *)contentJson
                pillCount:(NSInteger)pillCount;
- (void)flowDocInputView:(FlowDocInputView *)v
 didChangeSelectionStart:(NSInteger)start
                     end:(NSInteger)end;
- (void)flowDocInputView:(FlowDocInputView *)v didPressPillWithRefKey:(NSString *)refKey;
- (void)flowDocInputViewDidFocus:(FlowDocInputView *)v;
- (void)flowDocInputViewDidBlur:(FlowDocInputView *)v;
@end

@interface FlowDocInputView : UIView

@property (nonatomic, weak) id<FlowDocInputViewDelegate> delegate;

// MARK: styling
@property (nonatomic, copy, nullable) NSString *placeholder;
@property (nonatomic, strong) UIColor *placeholderColor;
@property (nonatomic, strong) UIColor *textColor;
@property (nonatomic, strong) UIColor *pillBackgroundColor;
@property (nonatomic, strong) UIColor *pillTextColor;
@property (nonatomic, assign) CGFloat fontSize;
@property (nonatomic, assign) CGFloat customLineHeight;  // 0 = system default
@property (nonatomic, assign) BOOL editable;

// MARK: imperative commands
- (void)setInitialContentJson:(NSString *)json;
- (void)setContentJson:(NSString *)json;
- (void)insertPillWithRefKey:(NSString *)refKey
                     mention:(NSString *)mention
                       title:(NSString *)title
                   isPointer:(BOOL)isPointer;
- (void)removePillWithRefKey:(NSString *)refKey;
/** 对当前选区加 mark：mark = "bold" / "italic" / "code" / "color"；
 *  color 用 value 传 hex（"#RRGGBB"），其它 mark value 传空。 */
- (void)applyMark:(NSString *)mark value:(NSString *)value;
/** 移除当前选区上对应 mark 的全部痕迹 */
- (void)removeMark:(NSString *)mark;
- (void)focusInput;
- (void)blurInput;

// MARK: state introspection
- (NSString *)currentContentJson;
- (NSInteger)currentPillCount;
- (NSRange)currentSelection;

@end

NS_ASSUME_NONNULL_END
