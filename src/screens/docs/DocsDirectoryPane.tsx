/**
 * DocsDirectoryPane —— 文档目录树的共享「面板外壳」。
 *
 * 把「树 + 单层背景 + 顶/底渐变遮罩 + 浮动 header」这套 chrome 收成一份，手机抽屉目录与
 * iPad 第二侧栏都用它，避免两端各拼一遍（header 内容由各自按平台传入：手机=汉堡；iPad=汉堡+标题）。
 * 单层背景由外层容器供色（本面板自身透明），树内容上下留出遮罩带高度 → 滚动贯穿顶/底渐变。
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import type { SharedValue } from 'react-native-reanimated';
import type { FlowDocTreeItem } from '../../api';
import { BlurHeaderBackground } from '../../components/BlurHeaderBackground';
import { DocsSidebar } from './DocsSidebar';

/** hex(#rrggbb) → rgba（底部长缓渐变遮罩用）。 */
function hexToRgba(hex: string, a: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return `rgba(0,0,0,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

export type DocsDirectoryPaneProps = {
  items: FlowDocTreeItem[];
  selectedId: string | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  onRefresh: () => void;
  onSelect: (item: FlowDocTreeItem) => void;
  /** 顶部安全区/纯色高度（= insets.top + 8）。 */
  topInset: number;
  /** 顶部 header 带高度（内容上 inset，首项滚到 header 渐变下）。 */
  headerHeight: number;
  /** 底部渐变带高度（内容下 inset）。 */
  footerHeight: number;
  /** 渐变/单层基色（外层容器底色，遮罩与之融合）。 */
  gradientBaseHex: string;
  /** 浮动 header 内容（汉堡/标题等，由调用方按平台拼）。 */
  header: React.ReactNode;
  /** 选中高亮随手机 dismiss 渐隐（手机传，iPad 不传 → 高亮恒亮）。 */
  selectionTx?: SharedValue<number>;
  dismissFrom?: number;
  dismissTo?: number;
};

export function DocsDirectoryPane({
  items,
  selectedId,
  loading,
  refreshing,
  error,
  onRefresh,
  onSelect,
  topInset,
  headerHeight,
  footerHeight,
  gradientBaseHex,
  header,
  selectionTx,
  dismissFrom,
  dismissTo,
}: DocsDirectoryPaneProps) {
  return (
    <View style={styles.fill}>
      {/* 树铺满；透明 → 单层背景由外层供色；内容上下留遮罩带高度 → 滚动贯穿顶/底渐变。 */}
      <DocsSidebar
        items={items}
        selectedId={selectedId}
        loading={loading}
        refreshing={refreshing}
        error={error}
        onRefresh={onRefresh}
        onSelect={onSelect}
        backgroundColor="transparent"
        selectionTx={selectionTx}
        dismissFrom={dismissFrom}
        dismissTo={dismissTo}
        contentTopInset={headerHeight}
        contentBottomInset={footerHeight}
      />

      {/* 底部长缓渐变（从顶端就掉透明度、无纯色平台）。 */}
      <View style={[styles.bottomFade, { height: footerHeight }]} pointerEvents="none">
        <LinearGradient
          style={StyleSheet.absoluteFill}
          colors={[
            hexToRgba(gradientBaseHex, 0),
            hexToRgba(gradientBaseHex, 0.08),
            hexToRgba(gradientBaseHex, 0.22),
            hexToRgba(gradientBaseHex, 0.45),
            hexToRgba(gradientBaseHex, 0.98),
          ]}
          locations={[0, 0.25, 0.5, 0.75, 1]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
        />
      </View>

      {/* 顶部渐变带 + 浮动 header；box-none 让空白处滚动穿透给下方树。 */}
      <View style={[styles.topBar, { paddingTop: topInset }]} pointerEvents="box-none">
        <BlurHeaderBackground
          style={StyleSheet.absoluteFill}
          topSolidHeight={topInset}
          gradientBaseHex={gradientBaseHex}
        />
        {header}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bottomFade: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
});
