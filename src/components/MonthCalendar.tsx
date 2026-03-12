/**
 * 自定义月历视图：网格展示、选日、今日高亮、前后月切换。
 * 不依赖系统日期选择器，便于后续扩展（如每日任务数、圆点等）。
 */
import React, { useMemo, useCallback, useState, useEffect, useRef, startTransition } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  type ListRenderItemInfo,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

type CellDay = {
  date: Date;
  day: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
};

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 生成当月日历网格：最多 6 行 × 7 列；若最后一行全是下个月则只返回 5 行 */
function buildMonthGrid(
  viewYear: number,
  viewMonth: number,
  selected: Date,
  today: Date
): { cells: CellDay[]; rowCount: number } {
  const first = new Date(viewYear, viewMonth, 1);
  const startWeekday = first.getDay();
  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const cells: CellDay[] = [];

  const push = (date: Date, isCurrentMonth: boolean) => {
    cells.push({
      date: new Date(date.getFullYear(), date.getMonth(), date.getDate()),
      day: date.getDate(),
      isCurrentMonth,
      isToday: isSameDay(date, today),
      isSelected: isSameDay(date, selected),
    });
  };

  const prevMonth = viewMonth === 0 ? 11 : viewMonth - 1;
  const prevYear = viewMonth === 0 ? viewYear - 1 : viewYear;
  const prevDays = getDaysInMonth(prevYear, prevMonth);

  for (let i = startWeekday - 1; i >= 0; i--) {
    const d = new Date(prevYear, prevMonth, prevDays - i);
    push(d, false);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    push(new Date(viewYear, viewMonth, d), true);
  }
  const remaining = 42 - cells.length;
  for (let d = 1; d <= remaining; d++) {
    push(new Date(viewYear, viewMonth + 1, d), false);
  }
  const lastRowStart = 35;
  const lastRowHasCurrent = cells.slice(lastRowStart, 42).some((c) => c.isCurrentMonth);
  const rowCount = lastRowHasCurrent ? 6 : 5;
  return { cells, rowCount };
}

/** 仅返回该月需要几行（5 或 6），用于计算月份高度 */
function getRowCountForMonth(year: number, month: number): number {
  const first = new Date(year, month, 1);
  const startWeekday = first.getDay();
  const daysInMonth = getDaysInMonth(year, month);
  const nextMonthDays = 42 - startWeekday - daysInMonth;
  const lastRowAllNextMonth = nextMonthDays >= 7;
  return lastRowAllNextMonth ? 5 : 6;
}

export type MonthCalendarProps = {
  selectedDate: Date;
  onSelectDate: (date: Date) => void;
  /** 显式指定展示的月份（用于纵向滚动多个月时）；不传则用 selectedDate 所在月 */
  displayYear?: number;
  displayMonth?: number;
  /** 固定高度模式（用于 snap 列表）：网格行用 flex 填满，不再用 aspectRatio */
  fixedHeight?: number;
  /** 可选：某日是否有任务等，用于未来扩展圆点等 */
  getDayExtra?: (date: Date) => { hasTask?: boolean; count?: number } | null;
  /** 是否隐藏左右箭头（在滚动模式下可隐藏） */
  hideArrows?: boolean;
  /** 是否隐藏年月行（在滚动模式下由外层仅在拖拽时显示） */
  hideHeader?: boolean;
  /** 固定行高（与 fixedHeight 搭配）：每行不再 flex 平分，而是此高度，月份总高 = 星期行 + rowCount*rowHeight */
  rowHeight?: number;
};

export function MonthCalendar({
  selectedDate,
  onSelectDate,
  displayYear: propDisplayYear,
  displayMonth: propDisplayMonth,
  fixedHeight,
  getDayExtra,
  hideArrows = false,
  hideHeader = false,
  rowHeight: propRowHeight,
}: MonthCalendarProps) {
  const today = useMemo(() => new Date(), []);
  const viewYear = propDisplayYear ?? selectedDate.getFullYear();
  const viewMonth = propDisplayMonth ?? selectedDate.getMonth();

  const { cells: grid, rowCount } = useMemo(
    () => buildMonthGrid(viewYear, viewMonth, selectedDate, today),
    [viewYear, viewMonth, selectedDate, today]
  );

  const goPrevMonth = () => {
    if (viewMonth === 0) {
      onSelectDate(new Date(viewYear - 1, 11, Math.min(selectedDate.getDate(), 31)));
    } else {
      const daysInPrev = getDaysInMonth(viewYear, viewMonth - 1);
      onSelectDate(
        new Date(viewYear, viewMonth - 1, Math.min(selectedDate.getDate(), daysInPrev))
      );
    }
  };

  const goNextMonth = () => {
    if (viewMonth === 11) {
      onSelectDate(new Date(viewYear + 1, 0, Math.min(selectedDate.getDate(), 31)));
    } else {
      const daysInNext = getDaysInMonth(viewYear, viewMonth + 1);
      onSelectDate(
        new Date(viewYear, viewMonth + 1, Math.min(selectedDate.getDate(), daysInNext))
      );
    }
  };

  const monthTitle = `${viewYear}年${viewMonth + 1}月`;

  return (
    <View
      style={[
        styles.container,
        fixedHeight != null && { height: fixedHeight },
        fixedHeight != null && hideHeader && styles.containerCompact,
      ]}
    >
      {!hideHeader && (
        <View style={styles.header}>
          {hideArrows ? (
            <View style={styles.arrowBtn} />
          ) : (
            <TouchableOpacity onPress={goPrevMonth} style={styles.arrowBtn} hitSlop={8}>
              <Ionicons name="chevron-back" size={22} color="#374151" />
            </TouchableOpacity>
          )}
          <Text style={styles.monthTitle}>{monthTitle}</Text>
          {hideArrows ? (
            <View style={styles.arrowBtn} />
          ) : (
            <TouchableOpacity onPress={goNextMonth} style={styles.arrowBtn} hitSlop={8}>
              <Ionicons name="chevron-forward" size={22} color="#374151" />
            </TouchableOpacity>
          )}
        </View>
      )}
      <View style={styles.weekdayRow}>
        {WEEKDAYS.map((w) => (
          <Text key={w} style={styles.weekdayText}>
            {w}
          </Text>
        ))}
      </View>
      <View
        style={[
          styles.grid,
          fixedHeight != null && styles.gridFixed,
        ]}
      >
        {Array.from({ length: rowCount }, (_, row) => (
          <View
            key={row}
            style={[
              styles.row,
              fixedHeight != null && styles.rowFixed,
              propRowHeight != null && { height: propRowHeight, marginBottom: 0 },
            ]}
          >
            {grid.slice(row * 7, row * 7 + 7).map((cell, col) => {
              const extra = getDayExtra?.(cell.date);
              return (
                <TouchableOpacity
                  key={col}
                  style={[
                    styles.cell,
                    fixedHeight != null && styles.cellFixed,
                  ]}
                  onPress={() => onSelectDate(cell.date)}
                  activeOpacity={0.7}
                >
                  <View style={styles.cellInner}>
                    {cell.isSelected && (
                      <View
                        style={[
                          styles.cellCircle,
                          cell.isToday ? styles.cellCircleSelected : styles.cellCircleSelectedOther,
                        ]}
                      />
                    )}
                    <Text
                      style={[
                        styles.cellText,
                        !cell.isCurrentMonth && styles.cellTextOtherMonth,
                        cell.isToday && styles.cellTextToday,
                        cell.isSelected && styles.cellTextSelected,
                      ]}
                    >
                      {cell.day}
                    </Text>
                    {extra?.hasTask !== false && (extra?.count ?? 0) > 0 && (
                      <View style={styles.dot} />
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  containerCompact: {
    paddingTop: 0,
    paddingBottom: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  arrowBtn: { padding: 4 },
  monthTitle: { fontSize: 17, fontWeight: '600', color: '#111827' },
  weekdayRow: {
    flexDirection: 'row',
    marginBottom: 6,
  },
  weekdayText: {
    flex: 1,
    textAlign: 'center',
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '500',
  },
  grid: {},
  gridFixed: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  rowFixed: { flex: 1, marginBottom: 0 },
  cell: {
    flex: 1,
    aspectRatio: 1,
    justifyContent: 'center',
    alignItems: 'center',
    marginHorizontal: 2,
  },
  cellFixed: {},
  cellInner: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cellCircle: {
    position: 'absolute',
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  cellCircleSelected: {
    backgroundColor: '#3b82f6',
  },
  cellCircleSelectedOther: {
    backgroundColor: '#111827',
  },
  cellText: { fontSize: 15, color: '#111827', fontWeight: '500' },
  cellTextOtherMonth: { color: '#d1d5db' },
  cellTextSelected: { color: '#fff', fontWeight: '600' },
  cellTextToday: { color: '#3b82f6', fontWeight: '800' },
  dot: {
    position: 'absolute',
    bottom: 5,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#3b82f6',
  },
});

// --- 纵向滚动切换月份（snap），每行固定高度、月份高度随行数变化 ---

const MONTHS_RANGE = 24;
const CALENDAR_ROW_HEIGHT = 44;
const CALENDAR_WEEKDAY_HEIGHT = 28;
const CALENDAR_VERTICAL_PAD = 8;
const CALENDAR_TITLE_HEIGHT = 28;

function getMonthHeight(rowCount: number): number {
  return (
    CALENDAR_TITLE_HEIGHT +
    CALENDAR_VERTICAL_PAD +
    CALENDAR_WEEKDAY_HEIGHT +
    rowCount * CALENDAR_ROW_HEIGHT +
    CALENDAR_VERTICAL_PAD
  );
}

/** 当前可能的最大/最小月份高度，供父级预留或动画用 */
export const CALENDAR_MONTH_HEIGHT_MAX = getMonthHeight(6);
export const CALENDAR_MONTH_HEIGHT_MIN = getMonthHeight(5);

type MonthItem = { year: number; month: number };

function buildMonths(): MonthItem[] {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - MONTHS_RANGE, 1);
  const items: MonthItem[] = [];
  for (let i = 0; i < MONTHS_RANGE * 2 + 1; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    items.push({ year: d.getFullYear(), month: d.getMonth() });
  }
  return items;
}

const MONTHS_LIST = buildMonths();

const MONTH_HEIGHTS = MONTHS_LIST.map((item) =>
  getMonthHeight(getRowCountForMonth(item.year, item.month))
);
const CUMULATIVE_OFFSETS: number[] = [];
let sum = 0;
for (let i = 0; i < MONTH_HEIGHTS.length; i++) {
  CUMULATIVE_OFFSETS[i] = sum;
  sum += MONTH_HEIGHTS[i];
}

export type MonthCalendarScrollProps = {
  selectedDate: Date;
  onSelectDate: (date: Date) => void;
  getDayExtra?: (date: Date) => { hasTask?: boolean; count?: number } | null;
};

const SNAP_THRESHOLD = 8;

function getSnappedIndexFromScrollY(y: number): number {
  for (let i = 0; i < MONTH_HEIGHTS.length; i++) {
    const end = CUMULATIVE_OFFSETS[i] + MONTH_HEIGHTS[i];
    if (y < end) return i;
  }
  return MONTH_HEIGHTS.length - 1;
}

function isSameDayScroll(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function MonthCalendarScroll({
  selectedDate,
  onSelectDate,
  getDayExtra,
}: MonthCalendarScrollProps) {
  const initialIndex = useMemo(() => {
    const y = selectedDate.getFullYear();
    const m = selectedDate.getMonth();
    const i = MONTHS_LIST.findIndex((x) => x.year === y && x.month === m);
    return Math.max(0, i >= 0 ? i : MONTHS_RANGE);
  }, []);

  const [currentHeight, setCurrentHeight] = useState(() => MONTH_HEIGHTS[initialIndex]);
  const [optimisticDate, setOptimisticDate] = useState<Date | null>(null);
  const lastSnappedIndexRef = useRef(initialIndex);
  const displaySelected = optimisticDate ?? selectedDate;

  useEffect(() => {
    if (
      optimisticDate &&
      selectedDate &&
      isSameDayScroll(optimisticDate, selectedDate)
    ) {
      setOptimisticDate(null);
    }
  }, [selectedDate, optimisticDate]);

  const handleSelectDate = useCallback(
    (date: Date) => {
      setOptimisticDate(date);
      startTransition(() => {
        onSelectDate(date);
      });
    },
    [onSelectDate]
  );

  const onScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = e.nativeEvent.contentOffset.y;
      const idx = getSnappedIndexFromScrollY(y);
      setCurrentHeight(MONTH_HEIGHTS[idx]);
      if (idx !== lastSnappedIndexRef.current) {
        lastSnappedIndexRef.current = idx;
        const item = MONTHS_LIST[idx];
        const today = new Date();
        const isCurrentMonth =
          item.year === today.getFullYear() && item.month === today.getMonth();
        const dateToSelect = isCurrentMonth
          ? new Date(today.getFullYear(), today.getMonth(), today.getDate())
          : new Date(item.year, item.month, 1);
        setOptimisticDate(dateToSelect);
        onSelectDate(dateToSelect);
      }
    },
    [onSelectDate]
  );

  const getItemLayout = useCallback((_: unknown, index: number) => {
    return {
      length: MONTH_HEIGHTS[index],
      offset: CUMULATIVE_OFFSETS[index],
      index,
    };
  }, []);

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<MonthItem>) => {
      const h = MONTH_HEIGHTS[index];
      const calendarHeight = h - CALENDAR_TITLE_HEIGHT;
      return (
        <View style={{ height: h }}>
          <View style={scrollStyles.monthTitleWrap}>
            <Text style={scrollStyles.monthTitle}>
              {item.year}年{item.month + 1}月
            </Text>
          </View>
          <MonthCalendar
            displayYear={item.year}
            displayMonth={item.month}
            selectedDate={displaySelected}
            onSelectDate={handleSelectDate}
            fixedHeight={calendarHeight}
            rowHeight={CALENDAR_ROW_HEIGHT}
            getDayExtra={getDayExtra}
            hideArrows
            hideHeader
          />
        </View>
      );
    },
    [displaySelected, handleSelectDate, getDayExtra]
  );

  return (
    <View style={{ height: currentHeight }}>
      <FlatList<MonthItem>
        data={MONTHS_LIST}
        keyExtractor={(item) => `${item.year}-${item.month}`}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        initialScrollIndex={initialIndex}
        initialNumToRender={3}
        snapToOffsets={CUMULATIVE_OFFSETS}
        snapToAlignment="start"
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        onMomentumScrollEnd={onScrollEnd}
        onScrollEndDrag={onScrollEnd}
      />
    </View>
  );
}

const scrollStyles = StyleSheet.create({
  monthTitleWrap: {
    height: CALENDAR_TITLE_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
  },
  monthTitle: { fontSize: 17, fontWeight: '600', color: '#111827' },
});
