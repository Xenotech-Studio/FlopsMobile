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
  NSString *icon = @"📄"; // pointer / excerpt 当前先共用同一个，后续可分
  UIFont *font = [UIFont systemFontOfSize:self.fontSize];
  CGFloat paddingH = 8.0;
  CGFloat paddingV = 2.0;

  /* 视觉截短：pill 内文本（含 icon + 两空格 + label）的渲染宽度上限。超出就用 "…" 替换
     label 末尾若干字符。仅影响显示；mention_text / refKey / NSAttributedString 里的占位
     字符不变，所以 round-trip 编辑 / mention 子串匹配都跟全长版本完全一致。
     上限值由 self.maxLabelTextWidth 控制，view 把 prop 注入到每个 attachment 上；
     默认 140pt，<=0 关闭视觉截短（按自然宽渲染）。 */
  NSDictionary<NSAttributedStringKey, id> *textAttrs = @{NSFontAttributeName: font};
  NSString *displayPrefix = [NSString stringWithFormat:@"%@  ", icon];
  CGFloat prefixWidth = [displayPrefix sizeWithAttributes:textAttrs].width;
  CGFloat labelNaturalWidth = [label sizeWithAttributes:textAttrs].width;
  NSString *renderedLabel = label;
  if (self.maxLabelTextWidth > 0 &&
      labelNaturalWidth > self.maxLabelTextWidth - prefixWidth) {
    CGFloat labelBudget = self.maxLabelTextWidth - prefixWidth;
    if (labelBudget < 20.0) labelBudget = 20.0;
    NSString *ellipsis = @"…";
    CGFloat ellipsisWidth = [ellipsis sizeWithAttributes:textAttrs].width;
    CGFloat shrinkTo = labelBudget - ellipsisWidth;
    if (shrinkTo < 0) shrinkTo = 0;
    NSMutableString *acc = [NSMutableString string];
    /* 用 enumerateSubstringsInRange:options:NSStringEnumerationByComposedCharacterSequences:
       让 emoji / 复合字形按整体处理，不会切到代理对中间 */
    __block CGFloat accW = 0;
    __block NSUInteger cutLen = label.length;
    [label enumerateSubstringsInRange:NSMakeRange(0, label.length)
                              options:NSStringEnumerationByComposedCharacterSequences
                           usingBlock:^(NSString * _Nullable substring,
                                        NSRange substringRange,
                                        NSRange enclosingRange,
                                        BOOL * _Nonnull stop) {
      CGFloat w = [substring sizeWithAttributes:textAttrs].width;
      if (accW + w > shrinkTo) {
        cutLen = substringRange.location;
        *stop = YES;
        return;
      }
      [acc appendString:substring];
      accW += w;
    }];
    (void)cutLen;
    renderedLabel = [acc stringByAppendingString:ellipsis];
  }

  NSString *display = [displayPrefix stringByAppendingString:renderedLabel];
  CGSize textSize = [display sizeWithAttributes:textAttrs];
  CGSize totalSize = CGSizeMake(ceil(textSize.width) + paddingH * 2,
                                 ceil(textSize.height) + paddingV * 2);

  UIGraphicsBeginImageContextWithOptions(totalSize, NO, 0);

  // 圆角背景
  CGRect bgRect = CGRectMake(0, 0, totalSize.width, totalSize.height);
  UIBezierPath *bg = [UIBezierPath bezierPathWithRoundedRect:bgRect
                                                cornerRadius:totalSize.height / 2.0];
  [self.backgroundColor setFill];
  [bg fill];

  // 文字
  [display drawAtPoint:CGPointMake(paddingH, paddingV)
        withAttributes:@{
          NSFontAttributeName: font,
          NSForegroundColorAttributeName: self.textColor,
        }];

  UIImage *image = UIGraphicsGetImageFromCurrentImageContext();
  UIGraphicsEndImageContext();

  self.image = image;
  /* 把 bounds 的 y 向下偏一点，让 attachment 视觉上垂直居中于文字行
     而不是悬挂在 baseline 上 */
  self.bounds = CGRectMake(0, -paddingV - 2, totalSize.width, totalSize.height);
}

- (CGRect)attachmentBoundsForTextContainer:(NSTextContainer *)textContainer
                       proposedLineFragment:(CGRect)lineFrag
                              glyphPosition:(CGPoint)position
                             characterIndex:(NSUInteger)charIndex {
  return self.bounds;
}

@end
