#import "FlowDocInputView.h"
#import "RefPillAttachment.h"

@interface FlowDocInputView () <UITextViewDelegate>
@property (nonatomic, strong) UITextView *textView;
@property (nonatomic, strong) UILabel *placeholderLabel;
/** 防止 setInitialContent 被多次应用（仅挂载时生效一次） */
@property (nonatomic, assign) BOOL initialContentApplied;
@end

@implementation FlowDocInputView

- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    _fontSize = 16.0;
    _customLineHeight = 0;
    _editable = YES;
    _textColor = [UIColor labelColor];
    _placeholderColor = [UIColor placeholderTextColor];
    _pillBackgroundColor = [UIColor colorWithWhite:0.92 alpha:1.0];
    _pillTextColor = [UIColor colorWithWhite:0.35 alpha:1.0];

    _textView = [[UITextView alloc] initWithFrame:self.bounds];
    _textView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    _textView.delegate = self;
    _textView.backgroundColor = [UIColor clearColor];
    _textView.scrollEnabled = NO;
    _textView.textContainerInset = UIEdgeInsetsZero;
    _textView.textContainer.lineFragmentPadding = 0;
    _textView.font = [UIFont systemFontOfSize:_fontSize];
    _textView.textColor = _textColor;
    [self addSubview:_textView];

    _placeholderLabel = [[UILabel alloc] init];
    _placeholderLabel.font = _textView.font;
    _placeholderLabel.textColor = _placeholderColor;
    _placeholderLabel.userInteractionEnabled = NO;
    _placeholderLabel.numberOfLines = 1;
    [self addSubview:_placeholderLabel];

    [self refreshPlaceholderLayout];
  }
  return self;
}

// MARK: - Layout

- (void)layoutSubviews {
  [super layoutSubviews];
  [self refreshPlaceholderLayout];
}

- (void)refreshPlaceholderLayout {
  CGFloat padLeft = self.textView.textContainerInset.left;
  CGFloat padTop = self.textView.textContainerInset.top;
  CGSize size = [self.placeholderLabel sizeThatFits:self.bounds.size];
  self.placeholderLabel.frame = CGRectMake(padLeft, padTop, size.width, size.height);
  self.placeholderLabel.hidden =
      self.textView.text.length > 0 || self.placeholder.length == 0;
}

// MARK: - Property setters

- (void)setPlaceholder:(NSString *)placeholder {
  _placeholder = [placeholder copy];
  self.placeholderLabel.text = _placeholder;
  [self setNeedsLayout];
}

- (void)setPlaceholderColor:(UIColor *)c {
  _placeholderColor = c;
  self.placeholderLabel.textColor = c;
}

- (void)setTextColor:(UIColor *)c {
  _textColor = c;
  self.textView.textColor = c;
  // 故意不覆盖 textStorage 里已存在的颜色——color mark（如 "红字"）应当保留；
  // textColor 只影响"未显式设置颜色"的新文本（通过 attributesForMarks 的 fg fallback）
}

- (void)setFontSize:(CGFloat)fontSize {
  _fontSize = fontSize;
  UIFont *font = [UIFont systemFontOfSize:fontSize];
  self.textView.font = font;
  self.placeholderLabel.font = font;
  [self.textView.textStorage addAttribute:NSFontAttributeName
                                     value:font
                                     range:NSMakeRange(0, self.textView.textStorage.length)];
  [self refreshAllPillStyles];
}

- (void)setPillBackgroundColor:(UIColor *)c {
  _pillBackgroundColor = c;
  [self refreshAllPillStyles];
}

- (void)setPillTextColor:(UIColor *)c {
  _pillTextColor = c;
  [self refreshAllPillStyles];
}

- (void)setEditable:(BOOL)editable {
  _editable = editable;
  self.textView.editable = editable;
}

- (void)refreshAllPillStyles {
  NSTextStorage *storage = self.textView.textStorage;
  [storage beginEditing];
  [storage enumerateAttribute:NSAttachmentAttributeName
                       inRange:NSMakeRange(0, storage.length)
                       options:0
                    usingBlock:^(id _Nullable value, NSRange range, BOOL *stop) {
    if ([value isKindOfClass:[RefPillAttachment class]]) {
      RefPillAttachment *att = (RefPillAttachment *)value;
      att.backgroundColor = self.pillBackgroundColor;
      att.textColor = self.pillTextColor;
      att.fontSize = MAX(10.0, self.fontSize - 2);
      [att refreshImage];
    }
  }];
  [storage endEditing];
}

// MARK: - Commands

- (void)setInitialContentJson:(NSString *)json {
  if (self.initialContentApplied) return;
  self.initialContentApplied = YES;
  [self applyContentJson:json moveCursorToEnd:NO emitChange:NO];
}

- (void)setContentJson:(NSString *)json {
  [self applyContentJson:json moveCursorToEnd:YES emitChange:YES];
}

- (void)applyContentJson:(NSString *)json
        moveCursorToEnd:(BOOL)toEnd
             emitChange:(BOOL)emit {
  NSData *data = [(json ?: @"[]") dataUsingEncoding:NSUTF8StringEncoding];
  NSError *err = nil;
  id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&err] : nil;
  if (![parsed isKindOfClass:[NSArray class]]) return;

  NSMutableAttributedString *attr = [[NSMutableAttributedString alloc] init];

  for (id item in (NSArray *)parsed) {
    if (![item isKindOfClass:[NSDictionary class]]) continue;
    NSString *type = item[@"type"];
    if ([type isEqualToString:@"text"]) {
      NSString *t = item[@"text"];
      if ([t isKindOfClass:[NSString class]] && t.length > 0) {
        NSDictionary *attrs = [self attributesForMarks:item[@"marks"]];
        [attr appendAttributedString:[[NSAttributedString alloc] initWithString:t
                                                                    attributes:attrs]];
      }
    } else if ([type isEqualToString:@"pill"]) {
      NSString *refKey = item[@"refKey"];
      if (![refKey isKindOfClass:[NSString class]]) continue;
      NSString *mention = [item[@"mention"] isKindOfClass:[NSString class]] ? item[@"mention"] : @"";
      NSString *title = [item[@"title"] isKindOfClass:[NSString class]] ? item[@"title"] : @"";
      BOOL isPointer = [item[@"isPointer"] boolValue];
      RefPillAttachment *att = [[RefPillAttachment alloc] initWithRefKey:refKey
                                                                  mention:mention
                                                                    title:title
                                                                isPointer:isPointer];
      att.backgroundColor = self.pillBackgroundColor;
      att.textColor = self.pillTextColor;
      att.fontSize = MAX(10.0, self.fontSize - 2);
      [att refreshImage];
      [attr appendAttributedString:[NSAttributedString attributedStringWithAttachment:att]];
    }
  }

  self.textView.attributedText = attr;
  if (toEnd) {
    self.textView.selectedRange = NSMakeRange(attr.length, 0);
  }
  [self refreshPlaceholderLayout];
  if (emit) [self emitContentChange];
}

- (void)insertPillWithRefKey:(NSString *)refKey
                     mention:(NSString *)mention
                       title:(NSString *)title
                   isPointer:(BOOL)isPointer {
  __block BOOL existing = NO;
  [self.textView.textStorage enumerateAttribute:NSAttachmentAttributeName
                                          inRange:NSMakeRange(0, self.textView.textStorage.length)
                                          options:0
                                       usingBlock:^(id _Nullable v, NSRange r, BOOL *stop) {
    if ([v isKindOfClass:[RefPillAttachment class]] &&
        [((RefPillAttachment *)v).refKey isEqualToString:refKey]) {
      existing = YES;
      *stop = YES;
    }
  }];
  if (existing) return;

  RefPillAttachment *att = [[RefPillAttachment alloc] initWithRefKey:refKey
                                                              mention:mention ?: @""
                                                                title:title ?: @""
                                                            isPointer:isPointer];
  att.backgroundColor = self.pillBackgroundColor;
  att.textColor = self.pillTextColor;
  att.fontSize = MAX(10.0, self.fontSize - 2);
  [att refreshImage];

  UIFont *font = [UIFont systemFontOfSize:self.fontSize];
  NSDictionary *textAttrs = @{NSFontAttributeName: font,
                              NSForegroundColorAttributeName: self.textColor ?: [UIColor labelColor]};

  NSMutableAttributedString *pillStr = [[NSMutableAttributedString alloc] init];
  [pillStr appendAttributedString:[NSAttributedString attributedStringWithAttachment:att]];
  [pillStr appendAttributedString:[[NSAttributedString alloc] initWithString:@" " attributes:textAttrs]];

  NSRange sel = self.textView.selectedRange;
  if (sel.location == NSNotFound) sel = NSMakeRange(self.textView.textStorage.length, 0);

  NSTextStorage *storage = self.textView.textStorage;
  [storage beginEditing];
  if (sel.length > 0) [storage deleteCharactersInRange:sel];
  [storage insertAttributedString:pillStr atIndex:sel.location];
  [storage endEditing];

  self.textView.selectedRange = NSMakeRange(sel.location + pillStr.length, 0);
  [self refreshPlaceholderLayout];
  [self emitContentChange];
}

- (void)removePillWithRefKey:(NSString *)refKey {
  NSTextStorage *storage = self.textView.textStorage;
  __block NSRange foundRange = NSMakeRange(NSNotFound, 0);
  [storage enumerateAttribute:NSAttachmentAttributeName
                       inRange:NSMakeRange(0, storage.length)
                       options:0
                    usingBlock:^(id _Nullable v, NSRange r, BOOL *stop) {
    if ([v isKindOfClass:[RefPillAttachment class]] &&
        [((RefPillAttachment *)v).refKey isEqualToString:refKey]) {
      foundRange = r;
      *stop = YES;
    }
  }];
  if (foundRange.location == NSNotFound) return;
  [storage beginEditing];
  [storage deleteCharactersInRange:foundRange];
  [storage endEditing];
  [self refreshPlaceholderLayout];
  [self emitContentChange];
}

- (void)applyMark:(NSString *)mark value:(NSString *)value {
  NSRange sel = self.textView.selectedRange;
  if (sel.length == 0) return;
  NSTextStorage *storage = self.textView.textStorage;
  [storage beginEditing];
  // 跳过 attachment（pill 范围）：marks 只作用于纯文本
  [storage enumerateAttribute:NSAttachmentAttributeName
                       inRange:sel
                       options:0
                    usingBlock:^(id _Nullable v, NSRange r, BOOL *stop) {
    if (v) return;
    [self mutateMark:mark value:value inRange:r storage:storage apply:YES];
  }];
  [storage endEditing];
  [self emitContentChange];
}

- (void)removeMark:(NSString *)mark {
  NSRange sel = self.textView.selectedRange;
  if (sel.length == 0) return;
  NSTextStorage *storage = self.textView.textStorage;
  [storage beginEditing];
  [storage enumerateAttribute:NSAttachmentAttributeName
                       inRange:sel
                       options:0
                    usingBlock:^(id _Nullable v, NSRange r, BOOL *stop) {
    if (v) return;
    [self mutateMark:mark value:@"" inRange:r storage:storage apply:NO];
  }];
  [storage endEditing];
  [self emitContentChange];
}

/** apply=YES：加上对应 mark 属性；apply=NO：移除。
 *  bold/italic：通过修改 NSFont 的 symbolic traits 实现，保留原字号
 *  code：换字族 + 加背景色（apply）/ 还原系统字体 + 去背景色（remove）
 *  color：覆盖 / 还原 foreground color */
- (void)mutateMark:(NSString *)mark
              value:(NSString *)value
            inRange:(NSRange)range
            storage:(NSTextStorage *)storage
              apply:(BOOL)apply {
  if (range.length == 0) return;
  if ([mark isEqualToString:@"bold"] || [mark isEqualToString:@"italic"]) {
    BOOL isItalic = [mark isEqualToString:@"italic"];
    UIFontDescriptorSymbolicTraits flag = isItalic
        ? UIFontDescriptorTraitItalic
        : UIFontDescriptorTraitBold;
    [storage enumerateAttribute:NSFontAttributeName
                         inRange:range
                         options:0
                      usingBlock:^(id _Nullable v, NSRange r, BOOL *stop) {
      UIFont *current = (UIFont *)v ?: [UIFont systemFontOfSize:self.fontSize];
      UIFontDescriptorSymbolicTraits traits = current.fontDescriptor.symbolicTraits;
      UIFontDescriptorSymbolicTraits newTraits = apply ? (traits | flag) : (traits & ~flag);
      UIFontDescriptor *desc = [current.fontDescriptor fontDescriptorWithSymbolicTraits:newTraits];
      UIFont *newFont = desc ? [UIFont fontWithDescriptor:desc size:current.pointSize] : current;
      [storage addAttribute:NSFontAttributeName value:newFont range:r];
    }];
    // italic 还要叠 NSObliquenessAttributeName 让 CJK 也能斜
    if (isItalic) {
      if (apply) {
        [storage addAttribute:NSObliquenessAttributeName value:@(0.2) range:range];
      } else {
        [storage removeAttribute:NSObliquenessAttributeName range:range];
      }
    }
  } else if ([mark isEqualToString:@"code"]) {
    if (apply) {
      UIFont *codeFont = [UIFont fontWithName:@"Menlo" size:self.fontSize] ?:
                         [UIFont systemFontOfSize:self.fontSize];
      [storage addAttribute:NSFontAttributeName value:codeFont range:range];
      [storage addAttribute:NSBackgroundColorAttributeName
                       value:[UIColor colorWithWhite:0.93 alpha:1.0]
                       range:range];
    } else {
      [storage addAttribute:NSFontAttributeName
                       value:[UIFont systemFontOfSize:self.fontSize]
                       range:range];
      [storage removeAttribute:NSBackgroundColorAttributeName range:range];
    }
  } else if ([mark isEqualToString:@"color"]) {
    if (apply) {
      UIColor *c = [self colorFromHexString:value];
      if (c) [storage addAttribute:NSForegroundColorAttributeName value:c range:range];
    } else {
      UIColor *defaultColor = self.textColor ?: [UIColor labelColor];
      [storage addAttribute:NSForegroundColorAttributeName value:defaultColor range:range];
    }
  }
}

- (void)focusInput {
  [self.textView becomeFirstResponder];
}

- (void)blurInput {
  [self.textView resignFirstResponder];
}

// MARK: - Marks → NSAttributedString attributes

/** marks 字典 → NSAttributedString attributes（如 marks 为 nil 则只返回基础 font+color）
 *  - bold / italic：通过 UIFontDescriptor 拼 traits，避免直接换字族
 *  - code：换 Menlo 字体 + 浅灰底
 *  - color：覆盖 foregroundColor */
- (NSDictionary<NSAttributedStringKey, id> *)attributesForMarks:(nullable id)marksDict {
  UIColor *fg = self.textColor ?: [UIColor labelColor];
  UIFont *baseFont = [UIFont systemFontOfSize:self.fontSize];
  if (![marksDict isKindOfClass:[NSDictionary class]]) {
    return @{NSFontAttributeName: baseFont, NSForegroundColorAttributeName: fg};
  }
  NSDictionary *marks = (NSDictionary *)marksDict;
  BOOL bold = [marks[@"bold"] boolValue];
  BOOL italic = [marks[@"italic"] boolValue];
  BOOL code = [marks[@"code"] boolValue];
  NSString *colorStr = [marks[@"color"] isKindOfClass:[NSString class]] ? marks[@"color"] : nil;

  UIFont *font = baseFont;
  if (code) {
    font = [UIFont fontWithName:@"Menlo" size:self.fontSize] ?: baseFont;
  } else if (bold || italic) {
    UIFontDescriptorSymbolicTraits traits = 0;
    if (bold) traits |= UIFontDescriptorTraitBold;
    if (italic) traits |= UIFontDescriptorTraitItalic;
    UIFontDescriptor *desc = [baseFont.fontDescriptor fontDescriptorWithSymbolicTraits:traits];
    if (desc) font = [UIFont fontWithDescriptor:desc size:self.fontSize];
  }

  NSMutableDictionary<NSAttributedStringKey, id> *attrs = [NSMutableDictionary dictionary];
  attrs[NSFontAttributeName] = font;
  UIColor *parsedColor = colorStr ? [self colorFromHexString:colorStr] : nil;
  attrs[NSForegroundColorAttributeName] = parsedColor ?: fg;
  if (code) {
    attrs[NSBackgroundColorAttributeName] = [UIColor colorWithWhite:0.93 alpha:1.0];
  }
  /* iOS 系统中文字体不带 italic 字形；font trait 改不到 CJK。NSObliquenessAttributeName
     用仿射变换斜切文字（约 1/4 弧度 ≈ 14°），不依赖字族，对所有字符都生效。
     和 font trait 一起用：英文走真斜体字形，中文走变换斜切。 */
  if (italic) {
    attrs[NSObliquenessAttributeName] = @(0.2);
  }
  return attrs;
}

/** 反向：根据一段 text 上的 attributes，推断出 marks 字典；纯文本返回 nil */
- (nullable NSDictionary *)marksFromAttributes:(NSDictionary<NSAttributedStringKey, id> *)attrs {
  if (attrs.count == 0) return nil;
  UIFont *font = attrs[NSFontAttributeName];
  UIColor *fg = attrs[NSForegroundColorAttributeName];
  UIColor *bg = attrs[NSBackgroundColorAttributeName];

  BOOL bold = NO, italic = NO, code = NO;
  if (font) {
    UIFontDescriptorSymbolicTraits traits = font.fontDescriptor.symbolicTraits;
    bold = (traits & UIFontDescriptorTraitBold) != 0;
    italic = (traits & UIFontDescriptorTraitItalic) != 0;
    NSString *familyLC = font.familyName.lowercaseString ?: @"";
    code = [familyLC containsString:@"menlo"] || [familyLC containsString:@"courier"] ||
           [familyLC containsString:@"mono"];
  }
  // italic 也可能仅通过 NSObliquenessAttributeName 表达（CJK 走变换斜切的场景）
  NSNumber *obliqueness = attrs[NSObliquenessAttributeName];
  if (!italic && obliqueness && [obliqueness doubleValue] > 0) italic = YES;
  NSString *colorHex = nil;
  if (fg && ![self color:fg isApproximatelyEqualTo:self.textColor ?: [UIColor labelColor]]) {
    colorHex = [self hexStringFromColor:fg];
  }

  if (!bold && !italic && !code && !colorHex && !bg) return nil;

  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  if (bold) out[@"bold"] = @YES;
  if (italic) out[@"italic"] = @YES;
  if (code) out[@"code"] = @YES;
  if (colorHex) out[@"color"] = colorHex;
  return out;
}

- (nullable UIColor *)colorFromHexString:(NSString *)hex {
  if (![hex isKindOfClass:[NSString class]]) return nil;
  NSString *s = [hex stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
  if ([s hasPrefix:@"#"]) s = [s substringFromIndex:1];
  if (s.length != 6 && s.length != 8) return nil;
  unsigned int rgb = 0;
  NSScanner *scanner = [NSScanner scannerWithString:s];
  if (![scanner scanHexInt:&rgb]) return nil;
  CGFloat r, g, b, a = 1.0;
  if (s.length == 8) {
    r = ((rgb >> 24) & 0xFF) / 255.0;
    g = ((rgb >> 16) & 0xFF) / 255.0;
    b = ((rgb >> 8) & 0xFF) / 255.0;
    a = (rgb & 0xFF) / 255.0;
  } else {
    r = ((rgb >> 16) & 0xFF) / 255.0;
    g = ((rgb >> 8) & 0xFF) / 255.0;
    b = (rgb & 0xFF) / 255.0;
  }
  return [UIColor colorWithRed:r green:g blue:b alpha:a];
}

- (NSString *)hexStringFromColor:(UIColor *)color {
  CGFloat r, g, b, a;
  if (![color getRed:&r green:&g blue:&b alpha:&a]) return @"#000000";
  return [NSString stringWithFormat:@"#%02X%02X%02X", (int)(r * 255), (int)(g * 255), (int)(b * 255)];
}

- (BOOL)color:(UIColor *)a isApproximatelyEqualTo:(UIColor *)b {
  CGFloat ar, ag, ab, aa, br, bg, bb, ba;
  if (![a getRed:&ar green:&ag blue:&ab alpha:&aa]) return NO;
  if (![b getRed:&br green:&bg blue:&bb alpha:&ba]) return NO;
  return fabs(ar - br) < 0.01 && fabs(ag - bg) < 0.01 && fabs(ab - bb) < 0.01;
}

// MARK: - State introspection

- (NSRange)currentSelection {
  return self.textView.selectedRange;
}

- (NSString *)currentContentJson {
  /* 扫两层属性：
     1. 先看 NSAttachmentAttribute（pill 在不在）
     2. 再看 NSFont / NSForegroundColor / NSBackgroundColor（marks 是什么）
     遇到 marks 不同的相邻段，要切成不同 text part。 */
  NSMutableArray *items = [NSMutableArray array];
  NSTextStorage *storage = self.textView.textStorage;
  NSUInteger i = 0;
  NSUInteger len = storage.length;

  while (i < len) {
    NSRange effective;
    NSDictionary *attrs = [storage attributesAtIndex:i effectiveRange:&effective];
    id attachment = attrs[NSAttachmentAttributeName];
    if ([attachment isKindOfClass:[RefPillAttachment class]]) {
      RefPillAttachment *att = (RefPillAttachment *)attachment;
      [items addObject:@{
        @"type": @"pill",
        @"refKey": att.refKey ?: @"",
        @"mention": att.mention ?: @"",
        @"title": att.title ?: @"",
        @"isPointer": @(att.isPointer),
      }];
    } else {
      NSString *chunk = [storage.string substringWithRange:effective];
      if (chunk.length > 0) {
        NSMutableDictionary *part = [NSMutableDictionary dictionary];
        part[@"type"] = @"text";
        part[@"text"] = chunk;
        NSDictionary *marks = [self marksFromAttributes:attrs];
        if (marks) part[@"marks"] = marks;
        [items addObject:part];
      }
    }
    i = effective.location + effective.length;
  }

  NSError *err = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:items options:0 error:&err];
  return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"[]";
}

- (NSInteger)currentPillCount {
  __block NSInteger count = 0;
  [self.textView.textStorage enumerateAttribute:NSAttachmentAttributeName
                                          inRange:NSMakeRange(0, self.textView.textStorage.length)
                                          options:0
                                       usingBlock:^(id _Nullable v, NSRange r, BOOL *stop) {
    if ([v isKindOfClass:[RefPillAttachment class]]) count++;
  }];
  return count;
}

- (void)emitContentChange {
  if ([self.delegate respondsToSelector:@selector(flowDocInputView:didChangeContentJson:pillCount:)]) {
    [self.delegate flowDocInputView:self
                didChangeContentJson:[self currentContentJson]
                            pillCount:[self currentPillCount]];
  }
}

// MARK: - UITextViewDelegate

- (void)textViewDidChange:(UITextView *)textView {
  [self refreshPlaceholderLayout];
  [self emitContentChange];
}

- (void)textViewDidChangeSelection:(UITextView *)textView {
  if ([self.delegate respondsToSelector:@selector(flowDocInputView:didChangeSelectionStart:end:)]) {
    NSRange sel = textView.selectedRange;
    [self.delegate flowDocInputView:self
            didChangeSelectionStart:(NSInteger)sel.location
                                end:(NSInteger)(sel.location + sel.length)];
  }
}

- (void)textViewDidBeginEditing:(UITextView *)textView {
  if ([self.delegate respondsToSelector:@selector(flowDocInputViewDidFocus:)]) {
    [self.delegate flowDocInputViewDidFocus:self];
  }
}

- (void)textViewDidEndEditing:(UITextView *)textView {
  if ([self.delegate respondsToSelector:@selector(flowDocInputViewDidBlur:)]) {
    [self.delegate flowDocInputViewDidBlur:self];
  }
}

/* attachment 自带的 U+FFFC 字符可以被普通 backspace 干掉（删 char = 删 attachment），
   不需要特殊拦截。IME composition × pill 边界的问题先放着，等真测到再特化。 */
- (BOOL)textView:(UITextView *)textView
shouldChangeTextInRange:(NSRange)range
 replacementText:(NSString *)text {
  return YES;
}

@end
