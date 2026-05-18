/**
 * RefPillAttachment
 *
 * NSTextAttachment 子类，承载一个 ref-pill 的语义数据 + 视觉渲染。
 * 在 NSAttributedString 里以一个 Object Replacement Character (U+FFFC) 占位；
 * cursor 跨越 / 退格删除走 NSAttributedString 的原生原子语义 —— 一字符一删，
 * 不需要单独的 traversal 代码。
 */
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface RefPillAttachment : NSTextAttachment

@property (nonatomic, copy, readonly) NSString *refKey;
@property (nonatomic, copy, readonly) NSString *mention;
@property (nonatomic, copy, readonly) NSString *title;
@property (nonatomic, assign, readonly) BOOL isPointer;

/** 视觉样式；改完调用 -refreshImage 重绘 */
@property (nonatomic, strong) UIColor *backgroundColor;
@property (nonatomic, strong) UIColor *textColor;
@property (nonatomic, assign) CGFloat fontSize;
/** 视觉截短上限（pt）：pill 文本（icon + 两空格 + label）渲染宽度超过这个就尾部换 "…"。
 *  设 <=0 关闭视觉截短。caller 由 FlowDocInputView.pillMaxLabelTextWidth 注入。 */
@property (nonatomic, assign) CGFloat maxLabelTextWidth;

- (instancetype)initWithRefKey:(NSString *)refKey
                       mention:(NSString *)mention
                         title:(NSString *)title
                     isPointer:(BOOL)isPointer NS_DESIGNATED_INITIALIZER;

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithData:(nullable NSData *)contentData ofType:(nullable NSString *)uti NS_UNAVAILABLE;

/** 按当前 background / text / fontSize / mention 重新绘制内部 UIImage */
- (void)refreshImage;

@end

NS_ASSUME_NONNULL_END
