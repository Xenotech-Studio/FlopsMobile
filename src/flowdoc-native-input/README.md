# FlowDoc Native Input

In-app Fabric native component: editable rich text with **atomic ref-pill** inline objects.

Implemented for FlopsMobile (option A: code lives in `ios/FlowDocInput/` and
`android/app/src/main/java/com/flopsmobile/flowdocinput/`).

参考实现：
[software-mansion/react-native-enriched](https://github.com/software-mansion/react-native-enriched)
（image attachment 那条路径，原子 inline object 模式）。我们不依赖它的代码，只参考做法。

## 架构

| 层 | 文件 | 职责 |
|---|---|---|
| **JS codegen spec** | [spec/FlowDocInputViewNativeComponent.ts](spec/FlowDocInputViewNativeComponent.ts) | Fabric 接口定义。Props / Commands / Events |
| **JS React 包装** | [FlowDocInput.tsx](FlowDocInput.tsx) | 把 codegen native component 包成顺手的 React API |
| **JS Slate 适配** | [FlowDocSlateAdapter.tsx](FlowDocSlateAdapter.tsx) | Slate paragraph `Descendant[]` ↔ native FlowDocContent |
| **iOS UIKit 层** | [../../../ios/FlowDocInput/FlowDocInputView.{h,mm}](../../../ios/FlowDocInput/FlowDocInputView.mm) | UITextView 包装；业务逻辑都在这一层 |
| **iOS atomic pill** | [../../../ios/FlowDocInput/RefPillAttachment.{h,mm}](../../../ios/FlowDocInput/RefPillAttachment.mm) | NSTextAttachment 子类。一个 pill = NSAttributedString 里一个 U+FFFC，自然原子 |
| **iOS Fabric 桥** | [../../../ios/FlowDocInput/FlowDocInputViewComponentView.{h,mm}](../../../ios/FlowDocInput/FlowDocInputViewComponentView.mm) | Prop / command / event 翻译；非常薄 |
| **Android EditText 层** | [../../../android/app/src/main/java/com/flopsmobile/flowdocinput/FlowDocInputView.kt](../../../android/app/src/main/java/com/flopsmobile/flowdocinput/FlowDocInputView.kt) | EditText 子类，业务逻辑都在这一层 |
| **Android atomic pill** | [../../../android/app/src/main/java/com/flopsmobile/flowdocinput/RefPillSpan.kt](../../../android/app/src/main/java/com/flopsmobile/flowdocinput/RefPillSpan.kt) | ReplacementSpan 子类。一个 pill = Spannable 里一个 U+FFFC 字符上挂一段 1-char 宽度的 span，自然原子 |
| **Android ViewManager** | [../../../android/app/src/main/java/com/flopsmobile/flowdocinput/FlowDocInputViewManager.kt](../../../android/app/src/main/java/com/flopsmobile/flowdocinput/FlowDocInputViewManager.kt) | Fabric ViewManager；声明 props、转发 commands |

## 第一次跑起来要做的事

```bash
cd /Users/steven/Projects/FlowSeries/Flops/FlopsMobile

# 1) 让 RN codegen 解析我们的 JS spec 并生成 C++/Kotlin 接口头文件 + delegate 类
#    这一步会被 pod install 自动触发
cd ios && pod install && cd ..

# 2) iOS：rebuild
yarn ios

# 3) Android：rebuild（Gradle 会从 jsSrcsDir 拉 spec 重新 codegen）
yarn android
```

如果 iOS 报"找不到 RCTFlowDocInputViewViewProtocol / FlowDocInputViewComponentDescriptor"
等头文件，说明 codegen 没跑过。`pod install` 期间应当看到打印
`[Codegen] Generating Native Code from JS Spec`。

如果 Android 报"找不到 FlowDocInputViewManagerInterface / FlowDocInputViewManagerDelegate"，
同样是 codegen 没跑。检查 `package.json` 的 `codegenConfig.android.javaPackageName`
（当前为 `com.flopsmobile.flowdocinput`），以及 spec 文件位置（当前为
`src/flowdoc-native-input/spec/`）。

## 测试入口

Profile → "Slate-RN Spike (dev)" (仅 `__DEV__` 显示)。屏内：

- 顶部一个可编辑富文本框（默认带 1 个 pill 在中间）
- 底部按钮：`insertPill` 在当前光标插入一个动态 pill；`removeLast` 删掉最近插入的；`focus` 编程式聚焦
- 中间区显示最近一次 `onChange` 的 Slate children JSON

## 重点验证（人工）

1. **基础输入**：中文 / 英文 / emoji 都能正常打
2. **光标跨 pill**：左右方向键 / 点击 pill 两侧 → 光标跳过 pill 一整块
3. **退格删 pill**：把光标放在 pill 之后，按一次退格 → 整个 pill 消失
4. **跨 pill 选区**：长按拖动跨越 pill → 选区把 pill 一起包进去
5. **粘贴包含 pill 的选区**：剪切 → 粘贴 → pill 应该跟着过去（注意：当前序列化只走 plain text，
   剪贴板 pill 会丢失，TODO 见下）
6. **IME × pill**：中文输入法在 pill 旁边连续打字，看是否串字 / 跳光标
7. **暗色主题**：切换主题，pill 颜色应跟着 `pillBackgroundColor` / `pillTextColor` prop 变

## 已知缺失（v1 没做）

- **多 block / 多 paragraph**：当前只支持单 paragraph。文档级 spike 留给后续 Slate 上层
- **marks**（bold / italic / inline-code / color）：当前只有 plain text + pill。要做的话扩展
  iOS 的 NSAttributedString attribute、Android 的 CharacterStyle span 即可
- **粘贴/剪贴板带 pill**：粘贴时 pill 不参与 clipboard。需在 iOS `canPerformAction:` 拦截
  copy/paste，自定义 NSPasteboard 格式；Android 同样要拦 `onTextContextMenuItem`
- **Undo / Redo**：v1 不接，靠系统默认。原子 pill 在 Android 默认 undo 表现良好；
  iOS 需要自己写 `UIUndoManager` 钩子
- **IME composition × pill 边界**：iOS / Android 都没做特殊保护。如果实测发现拼音串
  到 pill 后面，需要在 `textView:shouldChangeTextInRange:` (iOS) 和
  InputConnection setComposingText (Android) 拦截
- **`lineHeight` prop**：定义了但实现是 no-op（iOS）/ 仅 setLineHeight（Android），
  对 pill 行高反作用不一定对
- **选区 ↔ Slate path 反向映射**：FlowDocSlateAdapter 当前只同步 content，
  不同步 selection。Slate 那侧 selection 在用户编辑期间会不准
- **Maestro / 自动化测试**：完全没有
