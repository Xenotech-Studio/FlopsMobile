/**
 * EquationAttachment
 *
 * NSTextAttachment 子类，承载一个行内 LaTeX 公式（element.tex）的源码 + 渲染图。
 * 渲染走 iosMath（MTMathImage）把 LaTeX 渲染成 UIImage，再作为 attachment 行内嵌入
 * NSAttributedString —— 跟 RefPillAttachment 一个套路（U+FFFC 占位、原子删/跨越）。
 */
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface EquationAttachment : NSTextAttachment

@property (nonatomic, copy, readonly) NSString *tex;

/** 视觉样式；改完调 -refreshImage 重绘 */
@property (nonatomic, strong) UIColor *textColor;
@property (nonatomic, assign) CGFloat fontSize;

- (instancetype)initWithTex:(NSString *)tex NS_DESIGNATED_INITIALIZER;

- (instancetype)init NS_UNAVAILABLE;
- (instancetype)initWithData:(nullable NSData *)contentData ofType:(nullable NSString *)uti NS_UNAVAILABLE;

/** 按当前 tex / textColor / fontSize 用 iosMath 重新渲染内部 UIImage + 调整基线 */
- (void)refreshImage;

@end

NS_ASSUME_NONNULL_END
