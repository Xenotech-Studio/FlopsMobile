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
  NSString *display = [NSString stringWithFormat:@"%@  %@", icon, label];
  UIFont *font = [UIFont systemFontOfSize:self.fontSize];

  CGSize textSize = [display sizeWithAttributes:@{NSFontAttributeName: font}];
  CGFloat paddingH = 8.0;
  CGFloat paddingV = 2.0;
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
