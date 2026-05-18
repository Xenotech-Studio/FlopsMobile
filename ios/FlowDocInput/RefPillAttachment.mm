#import "RefPillAttachment.h"

@implementation RefPillAttachment

- (instancetype)initWithRefKey:(NSString *)refKey
                       mention:(NSString *)mention
                         title:(NSString *)title
                     isPointer:(BOOL)isPointer {
  if ((self = [super init])) {
    _refKey = [refKey copy];
    _mention = [mention copy];
    _title = [title copy];
    _isPointer = isPointer;
    _backgroundColor = [UIColor colorWithWhite:0.92 alpha:1.0];
    _textColor = [UIColor colorWithWhite:0.35 alpha:1.0];
    _fontSize = 14.0;
    _maxLabelTextWidth = 140.0;
    [self refreshImage];
  }
  return self;
}

/** 显示文本：优先用 mention 去掉首字符 "@"；fallback title */
- (NSString *)displayLabel {
  NSString *m = self.mention ?: @"";
  if ([m hasPrefix:@"@"]) m = [m substringFromIndex:1];
  if (m.length == 0) m = self.title ?: @"";
  return m;
}

- (void)refreshImage {
  NSString *label = [self displayLabel];
  UIFont *font = [UIFont systemFontOfSize:self.fontSize];
  /* paddingH 收紧到 5：pill 内可见内容跟 chip 左边缘更近，单 pill 起头一行时
     看起来跟下面纯文本行的缩进差不那么大。
     paddingV 加到 4：让 chip 上下更宽松，跟用户消息气泡的视觉密度更接近。 */
  CGFloat paddingH = 5.0;
  CGFloat paddingV = 4.0;
  CGFloat iconGap = 3.0;

  /* 用 SF Symbol "doc.text" 替代原来的 📄 emoji：单色、跟 textColor 同色、按
     pill 字号缩放，比 emoji 干净。systemImageNamed: 拿到的 image 自动 template；
     用 imageWithTintColor: 上色后绘制。 */
  UIImage *iconImage = nil;
  if (@available(iOS 13.0, *)) {
    UIImageSymbolConfiguration *iconCfg =
        [UIImageSymbolConfiguration configurationWithPointSize:self.fontSize
                                                        weight:UIImageSymbolWeightRegular];
    UIImage *base = [UIImage systemImageNamed:@"doc.text" withConfiguration:iconCfg];
    if (base) {
      iconImage =
          [base imageWithTintColor:self.textColor renderingMode:UIImageRenderingModeAlwaysOriginal];
    }
  }
  CGSize iconSize = iconImage ? iconImage.size : CGSizeZero;

  /* 视觉截短：pill 内 [icon + gap + label] 的渲染宽度上限。超出就用 "…" 替换
     label 末尾若干字符。仅影响显示；mention_text / refKey / NSAttributedString 里的占位
     字符不变，所以 round-trip 编辑 / mention 子串匹配都跟全长版本完全一致。
     上限值由 self.maxLabelTextWidth 控制（默认 140pt，<=0 关）。 */
  NSDictionary<NSAttributedStringKey, id> *textAttrs = @{
    NSFontAttributeName: font,
    NSForegroundColorAttributeName: self.textColor,
  };
  CGFloat iconBlockWidth = iconImage ? iconSize.width + iconGap : 0;
  CGFloat labelNaturalWidth = [label sizeWithAttributes:textAttrs].width;
  NSString *renderedLabel = label;
  if (self.maxLabelTextWidth > 0 &&
      labelNaturalWidth > self.maxLabelTextWidth - iconBlockWidth) {
    CGFloat labelBudget = self.maxLabelTextWidth - iconBlockWidth;
    if (labelBudget < 20.0) labelBudget = 20.0;
    NSString *ellipsis = @"…";
    CGFloat ellipsisWidth = [ellipsis sizeWithAttributes:textAttrs].width;
    CGFloat shrinkTo = labelBudget - ellipsisWidth;
    if (shrinkTo < 0) shrinkTo = 0;
    NSMutableString *acc = [NSMutableString string];
    /* 用 enumerateSubstringsInRange:options:NSStringEnumerationByComposedCharacterSequences:
       让 emoji / 复合字形按整体处理，不会切到代理对中间 */
    __block CGFloat accW = 0;
    [label enumerateSubstringsInRange:NSMakeRange(0, label.length)
                              options:NSStringEnumerationByComposedCharacterSequences
                           usingBlock:^(NSString * _Nullable substring,
                                        NSRange substringRange,
                                        NSRange enclosingRange,
                                        BOOL * _Nonnull stop) {
      (void)substringRange;
      (void)enclosingRange;
      CGFloat w = [substring sizeWithAttributes:textAttrs].width;
      if (accW + w > shrinkTo) {
        *stop = YES;
        return;
      }
      [acc appendString:substring];
      accW += w;
    }];
    renderedLabel = [acc stringByAppendingString:ellipsis];
  }

  CGSize labelSize = [renderedLabel sizeWithAttributes:textAttrs];
  CGFloat contentWidth = iconBlockWidth + ceil(labelSize.width);
  CGFloat contentHeight = ceil(MAX(iconSize.height, labelSize.height));
  CGSize totalSize = CGSizeMake(contentWidth + paddingH * 2,
                                 contentHeight + paddingV * 2);

  UIGraphicsBeginImageContextWithOptions(totalSize, NO, 0);

  // 圆角背景
  CGRect bgRect = CGRectMake(0, 0, totalSize.width, totalSize.height);
  UIBezierPath *bg = [UIBezierPath bezierPathWithRoundedRect:bgRect
                                                cornerRadius:totalSize.height / 2.0];
  [self.backgroundColor setFill];
  [bg fill];

  // Icon（垂直居中）
  CGFloat cursorX = paddingH;
  if (iconImage) {
    CGFloat iconY = (totalSize.height - iconSize.height) / 2.0;
    [iconImage drawInRect:CGRectMake(cursorX, iconY, iconSize.width, iconSize.height)];
    cursorX += iconSize.width + iconGap;
  }
  // 文字（垂直居中）
  CGFloat labelY = (totalSize.height - labelSize.height) / 2.0;
  [renderedLabel drawAtPoint:CGPointMake(cursorX, labelY) withAttributes:textAttrs];

  UIImage *image = UIGraphicsGetImageFromCurrentImageContext();
  UIGraphicsEndImageContext();

  self.image = image;
  /* bounds.origin.y 是 attachment 底-左相对 baseline 的偏移（正 y 向上）。
     paddingV=4、icon + label ≈ 17pt @ 16pt font → pill 总高 ~25pt；
     偏移 -6 → 顶 +19 / 底 -6，pill 光学中心 ≈ 6.5 跟 16pt 文本中心 ~6 几乎重合。 */
  self.bounds = CGRectMake(0, -paddingV - 2, totalSize.width, totalSize.height);
}

- (CGRect)attachmentBoundsForTextContainer:(NSTextContainer *)textContainer
                       proposedLineFragment:(CGRect)lineFrag
                              glyphPosition:(CGPoint)position
                             characterIndex:(NSUInteger)charIndex {
  return self.bounds;
}

@end
