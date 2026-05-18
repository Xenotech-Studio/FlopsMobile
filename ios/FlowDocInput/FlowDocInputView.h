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
/** 内容尺寸变化（用于 JS 端做 height 自适应）。仅在 size 真变了才回调，避免抖动。 */
- (void)flowDocInputView:(FlowDocInputView *)v didChangeContentSize:(CGSize)size;
/** 用户按 Enter（且 enterCreatesBlock=YES）；JS 端按 offset 把 contentJson 拆成两半 */
- (void)flowDocInputView:(FlowDocInputView *)v
   didRequestSplitWithContentJson:(NSString *)contentJson
                           offset:(NSInteger)offset;
/** 用户在块首（光标 offset=0）按退格；JS 端把当前 contentJson 合并到上一块 */
- (void)flowDocInputView:(FlowDocInputView *)v
   didRequestMergeBackwardWithContentJson:(NSString *)contentJson;
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
@property (nonatomic, copy, nullable) NSString *fontFamily;  // nil / 空串 = 系统字体
@property (nonatomic, assign) CGFloat customLineHeight;  // 0 = system default
@property (nonatomic, assign) BOOL editable;
/** Enter 当作"拆 block"语义：默认 YES；code 块设 NO 以保留多行 */
@property (nonatomic, assign) BOOL enterCreatesBlock;

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
/** 编程式聚焦 + 把光标摆到指定逻辑字符 offset；offset < 0 表示放末尾 */
- (void)focusInputAtOffset:(NSInteger)offset;
- (void)blurInput;

// MARK: state introspection
- (NSString *)currentContentJson;
- (NSInteger)currentPillCount;
- (NSRange)currentSelection;

/** Fabric 实例复用准备：清掉所有内部状态，下次 mount 可以重新应用 initialContent */
- (void)resetForRecycle;

@end

NS_ASSUME_NONNULL_END
