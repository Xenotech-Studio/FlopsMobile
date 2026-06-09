#import "EquationAttachment.h"
// iosMath（pod 'iosMath' 0.9.4）：用 MTMathUILabel 渲染 LaTeX，再把它的 layer 画进 UIImage。
// displayList.ascent/descent 给出数学基线信息，用来精确对齐到文字基线。
#import <iosMath/MTMathUILabel.h>
#import <iosMath/MTMathListDisplay.h>

@implementation EquationAttachment

- (instancetype)initWithTex:(NSString *)tex {
  if ((self = [super initWithData:nil ofType:nil])) {
    _tex = [tex copy] ?: @"";
    _fontSize = 16.0;
    _textColor = [UIColor labelColor];
    [self refreshImage];
  }
  return self;
}

- (void)refreshImage {
  NSString *latex = self.tex.length ? self.tex : @"";
  if (latex.length == 0) {
    UIImage *fb = [self fallbackImage:@"∅"];
    self.image = fb;
    self.bounds = CGRectMake(0, -(fb.size.height * 0.18), fb.size.width, fb.size.height);
    return;
  }

  // 行内模式(kMTMathUILabelModeText，对齐 web displayMode:false)
  MTMathUILabel *label = [[MTMathUILabel alloc] init];
  label.latex = latex;
  label.fontSize = self.fontSize;
  label.textColor = self.textColor ?: [UIColor labelColor];
  label.labelMode = kMTMathUILabelModeText;
  label.contentInsets = UIEdgeInsetsZero;

  CGSize fit = [label sizeThatFits:CGSizeMake(CGFLOAT_MAX, CGFLOAT_MAX)];
  if (label.error != nil || fit.width < 1 || fit.height < 1) {
    // 渲染失败（语法错 / 不支持的宏）→ 把 tex 源码当斜体文字画出来，不丢内容
    UIImage *fb = [self fallbackImage:latex];
    self.image = fb;
    self.bounds = CGRectMake(0, -(fb.size.height * 0.18), fb.size.width, fb.size.height);
    return;
  }

  CGSize sz = CGSizeMake(ceil(fit.width), ceil(fit.height));
  label.frame = CGRectMake(0, 0, sz.width, sz.height);
  [label setNeedsLayout];
  [label layoutIfNeeded];

  UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:sz];
  UIImage *image = [renderer imageWithActions:^(UIGraphicsImageRendererContext *_Nonnull ctx) {
    CGContextRef cg = ctx.CGContext;
    // iosMath 用 Core Text 的 y-up 坐标绘制，直接 renderInContext 会上下颠倒；先翻转 Y 校正。
    CGContextTranslateCTM(cg, 0, sz.height);
    CGContextScaleCTM(cg, 1.0, -1.0);
    [label.layer renderInContext:cg];
  }];
  self.image = image;

  /* 基线对齐：attachment.bounds.origin.y = 图底相对文字 baseline 的偏移（负 = 下移）。
     用 displayList.descent（数学基线以下高度）放到 baseline 下方，公式基线即与文字基线对齐。
     displayList 在 layoutIfNeeded 后才有；取不到则退回 18% 经验值。 */
  CGFloat descent = label.displayList ? label.displayList.descent : sz.height * 0.18;
  self.bounds = CGRectMake(0, -descent, sz.width, sz.height);
}

/** 兜底：把字符串以斜体灰字画成一张图（公式渲染失败时占位，不丢内容） */
- (UIImage *)fallbackImage:(NSString *)text {
  UIFont *base = [UIFont systemFontOfSize:self.fontSize];
  UIFontDescriptor *desc =
      [base.fontDescriptor fontDescriptorWithSymbolicTraits:UIFontDescriptorTraitItalic];
  UIFont *font = desc ? [UIFont fontWithDescriptor:desc size:self.fontSize] : base;
  NSDictionary *attrs = @{
    NSFontAttributeName: font,
    NSForegroundColorAttributeName: (self.textColor ?: [UIColor labelColor]),
  };
  CGSize textSize = [text sizeWithAttributes:attrs];
  CGFloat padX = 2.0;
  CGSize total = CGSizeMake(ceil(textSize.width) + padX * 2, ceil(textSize.height));
  UIGraphicsBeginImageContextWithOptions(total, NO, 0);
  [text drawAtPoint:CGPointMake(padX, 0) withAttributes:attrs];
  UIImage *img = UIGraphicsGetImageFromCurrentImageContext();
  UIGraphicsEndImageContext();
  return img;
}

@end
