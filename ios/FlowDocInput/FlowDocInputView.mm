#import "FlowDocInputView.h"
#import "RefPillAttachment.h"

/* UITextView 子类，专门用来 override -deleteBackward。
   iOS 系统在 textView 偏移 0 处按退格时 *不会* 触发 shouldChangeTextInRange:replacementText:
   （因为没有"左边的字符"可以删），所以无法在那里拦。-deleteBackward 是 UITextInput 协议方法，
   不管偏移位置都被调用，是块首退格的唯一可靠 hook。 */
@interface FlowDocInputTextView : UITextView
@property (nonatomic, copy, nullable) BOOL (^onDeleteBackwardAtStart)(void);
@end

@implementation FlowDocInputTextView
- (void)deleteBackward {
  NSRange sel = self.selectedRange;
  if (sel.location == 0 && sel.length == 0 && self.onDeleteBackwardAtStart) {
    BOOL consumed = self.onDeleteBackwardAtStart();
    if (consumed) return;
  }
  [super deleteBackward];
}
@end

@interface FlowDocInputView () <UITextViewDelegate, UIGestureRecognizerDelegate>
@property (nonatomic, strong) UITextView *textView;
@property (nonatomic, strong) UILabel *placeholderLabel;
/** 防止 setInitialContent 被多次应用（仅挂载时生效一次） */
@property (nonatomic, assign) BOOL initialContentApplied;
@end

@implementation FlowDocInputView {
  /** 上次上报给 JS 的内容尺寸；避免每帧都重复 emit 同样的值 */
  CGSize _lastReportedContentSize;
}

- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    _fontSize = 16.0;
    _customLineHeight = 0;
    _editable = YES;
    _enterCreatesBlock = YES;
    _pillMaxLabelTextWidth = 140.0;
    _textColor = [UIColor labelColor];
    _placeholderColor = [UIColor placeholderTextColor];
    _pillBackgroundColor = [UIColor colorWithWhite:0.92 alpha:1.0];
    _pillTextColor = [UIColor colorWithWhite:0.35 alpha:1.0];

    _textView = [[FlowDocInputTextView alloc] initWithFrame:self.bounds];
    __weak __typeof(self) weakSelf = self;
    ((FlowDocInputTextView *)_textView).onDeleteBackwardAtStart = ^BOOL{
      __strong __typeof(weakSelf) strong = weakSelf;
      if (!strong) return NO;
      if ([strong.delegate respondsToSelector:@selector(flowDocInputView:didRequestMergeBackwardWithContentJson:)]) {
        [strong.delegate flowDocInputView:strong
            didRequestMergeBackwardWithContentJson:[strong currentContentJson]];
        return YES;  // 由 JS 端处理合并，本地不删
      }
      return NO;
    };
    /* iOS 16+ UITextView 默认 TextKit 2，对 NSObliquenessAttributeName 等 legacy
       attribute 处理不一致；访问 .layoutManager 一次会触发 fallback 到 TextKit 1，
       让所有 NSAttributedString attribute 都按经典语义生效。这是官方文档的
       "use TextKit 1" 推荐做法（不显式调 API 切换，靠访问触发）。 */
    (void)_textView.layoutManager;
    _textView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    _textView.delegate = self;
    _textView.backgroundColor = [UIColor clearColor];
    _textView.scrollEnabled = NO;
    _textView.textContainerInset = UIEdgeInsetsZero;
    _textView.textContainer.lineFragmentPadding = 0;
    _textView.font = [UIFont systemFontOfSize:_fontSize];
    _textView.textColor = _textColor;
    [self addSubview:_textView];

    /* 把 UITextView 自带的所有 gestureRecognizer 都装上 delegate，让它们在命中 UIControl
       子树时 shouldReceiveTouch=NO —— UITextView frame 撑满 card 后，"+ 按钮" 等 sibling
       UIControl 会落在 textView 的 hit-test 范围内；不过滤的话 textView 的 tap 也会在 + 上
       fire（cursor 落到 + 几何投影到文本的位置），跟 + 自身 action 重叠。
       UITextView 在 mount 后/属性变化时会动态加 / 换 gesture recognizer，所以 init 这里挂
       一次，refreshTextViewGestureDelegates 在每次重要属性变化后再补挂一次（layoutSubviews
       里也补一次兜底）。 */
    [self refreshTextViewGestureDelegates];

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
  [self maybeEmitContentSizeChange];
  /* UITextView 在 layout 阶段可能动态增删 gesture recognizers（iOS 内部按需挂 selection /
     magnifier 等手势）。每次 layout 补挂一次 delegate 兜底新出现的 recognizer。 */
  [self refreshTextViewGestureDelegates];
}

// MARK: - UITextView gesture recognizer delegate setup

/* 把 textView.gestureRecognizers 里所有未设 delegate 的 recognizer 设成 self（如果原来
   有 delegate 就不动，避免破坏 UIKit 内部 selection 那套），然后我们的 delegate 方法
   `shouldReceiveTouch:` 会按 UIControl 子树过滤。
   只挂"未设 delegate"那批 recognizer 是关键 —— UITextView 自己内部的 selection recognizer
   有它自己的 delegate（UITextSelectionInteraction 等），把我们的 delegate 强塞会破坏选择
   逻辑。但 UITextView 顶层那个 cursor placement tap recognizer 通常无 delegate，可以接。 */
- (void)refreshTextViewGestureDelegates {
  for (UIGestureRecognizer *gr in self.textView.gestureRecognizers) {
    if (gr.delegate == nil) {
      gr.delegate = self;
    }
  }
}

/* tap 命中 + 按钮等 UIControl 子树时，让 textView 的 tap recognizer 跳过 — UIControl 自己
   接 tap action，不被 textView 抢去 placeCursor。 */
- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer
       shouldReceiveTouch:(UITouch *)touch {
  UIView *v = touch.view;
  while (v != nil && v != self) {
    if ([v isKindOfClass:[UIControl class]]) {
      return NO;
    }
    v = v.superview;
  }
  return YES;
}

/* 跟外层任何 recognizer 都允许并发 — 比如 BouncyGlassCard / BouncyButton 的 tap，跟我们
   UITextView 内部 selection 不冲突 */
- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer
       shouldRecognizeSimultaneouslyWithGestureRecognizer:
           (UIGestureRecognizer *)otherGestureRecognizer {
  return YES;
}

// MARK: - textContainerInsets

- (void)setTextContainerInsets:(UIEdgeInsets)insets {
  if (UIEdgeInsetsEqualToEdgeInsets(_textContainerInsets, insets)) return;
  _textContainerInsets = insets;
  self.textView.textContainerInset = insets;
  /* placeholder 跟 textView 共享内 padding 位置——参考 refreshPlaceholderLayout 里 padLeft /
     padTop 直接取 textContainerInset。这里 layout 一次让 placeholder 立刻跟着移。 */
  [self refreshPlaceholderLayout];
  /* textContainerInset 变化会改变可用 layout 区域 → 重新测内容尺寸 */
  [self maybeEmitContentSizeChange];
}

/** 算 textView 真实 content size 并向 delegate 上报；size 没变就不 emit，避免抖动 */
- (void)maybeEmitContentSizeChange {
  /* 关键：scrollEnabled=NO 的 UITextView 把 contentSize 维护得不靠谱（常返回 frame 大小）。
     用 sizeThatFits: 在当前宽度下重新测量，对应到内容自然 wrap 后所需高度。 */
  CGFloat width = self.bounds.size.width;
  if (width <= 0) return;
  CGSize fitting = [self.textView sizeThatFits:CGSizeMake(width, CGFLOAT_MAX)];
  CGSize newSize = CGSizeMake(width, ceil(fitting.height));
  if (CGSizeEqualToSize(newSize, _lastReportedContentSize)) return;
  _lastReportedContentSize = newSize;
  if ([self.delegate respondsToSelector:@selector(flowDocInputView:didChangeContentSize:)]) {
    [self.delegate flowDocInputView:self didChangeContentSize:newSize];
  }
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
  /* 故意 *不* 设 self.textView.textColor —— UITextView 的 textColor setter 是破坏性的：
     调用时会把 textStorage 里**所有** NSForegroundColorAttributeName 强制覆盖成 c，
     抹掉我们 attributesForMarks 显式设的 color mark（"红字" 之类）。
     我们的方案：attributesForMarks 始终给每一段文本显式写 fg（用户 color mark 或 fallback fg），
     UITextView 自身的 textColor 属性永远用不到，所以可以忽略不设。 */
}

- (void)setFontSize:(CGFloat)fontSize {
  _fontSize = fontSize;
  UIFont *font = [self baseFontOfSize:fontSize];
  self.textView.font = font;
  self.placeholderLabel.font = font;
  [self.textView.textStorage addAttribute:NSFontAttributeName
                                     value:font
                                     range:NSMakeRange(0, self.textView.textStorage.length)];
  [self refreshAllPillStyles];
}

- (void)setFontFamily:(NSString *)fontFamily {
  _fontFamily = [fontFamily copy];
  UIFont *font = [self baseFontOfSize:self.fontSize];
  self.textView.font = font;
  self.placeholderLabel.font = font;
  /* 已有内容里"显式带 code mark"的段保持 Menlo；其它段按新 family 重设。
     这里偷懒走一刀切：所有段都改成新 family；如果 code mark 的段被影响了，
     下次 emit/重渲染会通过 attributesForMarks 修回 Menlo。 */
  [self.textView.textStorage addAttribute:NSFontAttributeName
                                     value:font
                                     range:NSMakeRange(0, self.textView.textStorage.length)];
}

/** 根据当前 _fontFamily 拿"基准字体"（无 bold/italic/code 等 trait）。
    用法：1) attributesForMarks 的 baseFont 起点；2) 整个 view 的默认 font。 */
- (UIFont *)baseFontOfSize:(CGFloat)size {
  if (self.fontFamily.length > 0) {
    UIFont *f = [UIFont fontWithName:self.fontFamily size:size];
    if (f) return f;
  }
  return [UIFont systemFontOfSize:size];
}

- (void)setPillBackgroundColor:(UIColor *)c {
  _pillBackgroundColor = c;
  [self refreshAllPillStyles];
}

- (void)setPillTextColor:(UIColor *)c {
  _pillTextColor = c;
  [self refreshAllPillStyles];
}

- (void)setPillMaxLabelTextWidth:(CGFloat)w {
  _pillMaxLabelTextWidth = w;
  [self refreshAllPillStyles];
}

- (void)setEditable:(BOOL)editable {
  _editable = editable;
  self.textView.editable = editable;
  /* editable=NO 时（chat composer 在 agent 跑时）把 textView 的 userInteractionEnabled 关掉，
     让覆盖在 card 上的 RN 兄弟按钮（"停止"键）能收到 tap —— 它不是 UITextView 的子 view，
     gestureRecognizer:shouldReceiveTouch: 那套 UIControl 过滤够不到它，唯一可靠办法是让
     textView 整体不拦 touch、让 touch 穿透到上层 RN 按钮。
     副作用评估：本 composer textView scrollEnabled=NO（高度由 JS autoHeight 驱动），非编辑态
     既不能编辑也不需要滚动，关交互无功能损失；恢复 editable=YES 时重新打开。 */
  self.textView.userInteractionEnabled = editable;
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
      att.maxLabelTextWidth = self.pillMaxLabelTextWidth;
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
      att.maxLabelTextWidth = self.pillMaxLabelTextWidth;
      [att refreshImage];
      /* attachment 占位字符（U+FFFC）必须显式带 NSFontAttribute / NSForegroundColorAttributeName，
         否则光标删到紧贴 pill 之后时 UITextView 的 typingAttributes 继承自 pill 字符（无字号），
         接着输入的字会用系统默认小字号。 */
      NSMutableAttributedString *pillAtomic =
          [[NSMutableAttributedString alloc] initWithAttributedString:
               [NSAttributedString attributedStringWithAttachment:att]];
      UIFont *bodyFont = [self baseFontOfSize:self.fontSize];
      [pillAtomic addAttribute:NSFontAttributeName
                         value:bodyFont
                         range:NSMakeRange(0, pillAtomic.length)];
      [pillAtomic addAttribute:NSForegroundColorAttributeName
                         value:(self.textColor ?: [UIColor labelColor])
                         range:NSMakeRange(0, pillAtomic.length)];
      [attr appendAttributedString:pillAtomic];
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
  att.maxLabelTextWidth = self.pillMaxLabelTextWidth;
  [att refreshImage];

  UIFont *font = [self baseFontOfSize:self.fontSize];
  NSDictionary *textAttrs = @{NSFontAttributeName: font,
                              NSForegroundColorAttributeName: self.textColor ?: [UIColor labelColor]};

  NSMutableAttributedString *pillStr = [[NSMutableAttributedString alloc] init];
  /* attachment 字符也带正文 font / textColor —— 见上文 applyContentJson 的同款注释。
     删掉 pill 后续的空格时，光标会落到紧贴 pill 之后，typingAttributes 继承 pill 字符
     的属性；如果 pill 字符没字号，后续输入会变成系统默认小字号。 */
  NSMutableAttributedString *pillAtomic =
      [[NSMutableAttributedString alloc] initWithAttributedString:
           [NSAttributedString attributedStringWithAttachment:att]];
  [pillAtomic addAttribute:NSFontAttributeName
                     value:font
                     range:NSMakeRange(0, pillAtomic.length)];
  [pillAtomic addAttribute:NSForegroundColorAttributeName
                     value:(self.textColor ?: [UIColor labelColor])
                     range:NSMakeRange(0, pillAtomic.length)];
  [pillStr appendAttributedString:pillAtomic];
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

- (void)resetForRecycle {
  /* Fabric 把 ComponentView 实例放回池子时调；下次它被分配给一个"新"的 React 节点前，
     必须把 inputView 内部 *标志位* 清空（initialContentApplied 等），否则
     setInitialContent 会被跳过、新内容显示不出来。
     同时所有 styling state 也得跟 codegen 的 defaultProps 对齐——否则 updateProps 用
     "old == new" 判断时跳过 setter，inputView 真实状态还停在上次 mount 的值上，导致
     字号 / 颜色 / 字体族错位。
     注意：故意 *不* 清 textStorage——清空会让 UITextView 在被复用挂载的下一帧短暂
     呈现"空"状态（旧节点已 unmount → 新节点的 setInitialContent 还没落到这一帧上），
     视觉上就是后半段"闪一下"。保留旧内容则用户最多看到一瞬间的"旧文本"，
     当 setInitialContent 应用之后会被新内容覆盖，体感比闪更轻。 */
  self.initialContentApplied = NO;
  _lastReportedContentSize = CGSizeZero;

  // 跟 spec 里 `WithDefault<Double, 16>` 等保持一致
  self.fontSize = 16.0;
  self.fontFamily = nil;
  self.customLineHeight = 0;
  self.textColor = [UIColor labelColor];
  self.placeholderColor = [UIColor placeholderTextColor];
  self.pillBackgroundColor = [UIColor colorWithWhite:0.92 alpha:1.0];
  self.pillTextColor = [UIColor colorWithWhite:0.35 alpha:1.0];
  self.pillMaxLabelTextWidth = 140.0;
  self.placeholder = nil;
  self.editable = YES;
  self.enterCreatesBlock = YES;

  self.textView.selectedRange = NSMakeRange(0, 0);
}

- (void)focusInput {
  [self.textView becomeFirstResponder];
}

- (void)focusInputAtOffset:(NSInteger)offset {
  [self.textView becomeFirstResponder];
  if (offset < 0) return;
  NSUInteger len = self.textView.textStorage.length;
  NSUInteger pos = (NSUInteger)MAX((NSInteger)0, MIN((NSInteger)len, offset));
  self.textView.selectedRange = NSMakeRange(pos, 0);
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
  UIFont *baseFont = [self baseFontOfSize:self.fontSize];
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
  /* 程序式改 textStorage（insertPill / setContentJson / applyMark 等）不会触发
     -textViewDidChange，因此也不会走到 setNeedsLayout / layoutSubviews ——
     -maybeEmitContentSizeChange 不会 fire，JS 端 autoHeight 还停在改前高度，
     文本就被截断（pill 折行后看不到第二行 / 光标也消失）。
     在每次 content 变化后主动重布局，确保 -layoutSubviews 跑一遍。 */
  [self setNeedsLayout];
  [self layoutIfNeeded];
}

// MARK: - UITextViewDelegate

- (void)textViewDidChange:(UITextView *)textView {
  [self refreshPlaceholderLayout];
  [self emitContentChange];
  /* textViewDidChange 不一定触发 layoutSubviews，但内容变了往往高度也会变；
     主动 invalidate + 重测，让 didChangeContentSize 及时上报 */
  [self setNeedsLayout];
  [self layoutIfNeeded];
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
   不需要特殊拦截。IME composition × pill 边界的问题先放着，等真测到再特化。

   只拦 Enter：如果 enterCreatesBlock=YES，把 "\n" 转成 onSplitRequest 事件，
   让上层 JS 拆 block；本地不真插换行。 */
- (BOOL)textView:(UITextView *)textView
shouldChangeTextInRange:(NSRange)range
 replacementText:(NSString *)text {
  if (self.enterCreatesBlock && [text isEqualToString:@"\n"]) {
    if ([self.delegate respondsToSelector:@selector(flowDocInputView:didRequestSplitWithContentJson:offset:)]) {
      [self.delegate flowDocInputView:self
        didRequestSplitWithContentJson:[self currentContentJson]
                                offset:(NSInteger)range.location];
    }
    return NO;
  }
  return YES;
}

@end
