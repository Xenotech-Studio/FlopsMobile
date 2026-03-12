/**
 * 与 TaskFilterSheet 一致：Android 不用系统 Switch，用自定义长条轨道 + 白圆 thumb。
 * 任务详情页与筛选 sheet 共用此组件。
 */
import React from 'react';
import { View, Pressable, Switch, StyleSheet, Platform } from 'react-native';
import { shadowToggleThumb } from '../theme/shadows';

const DEFAULT_TRACK_OFF = '#d1d5db';
const DEFAULT_TRACK_ON = '#34c759';

type Props = {
  value: boolean;
  onValueChange: (v: boolean) => void;
  trackColorOff?: string;
  trackColorOn?: string;
};

export function IOSStyleSwitch({
  value,
  onValueChange,
  trackColorOff = DEFAULT_TRACK_OFF,
  trackColorOn = DEFAULT_TRACK_ON,
}: Props) {
  if (Platform.OS === 'android') {
    return (
      <Pressable
        onPress={() => onValueChange(!value)}
        style={[
          styles.track,
          {
            backgroundColor: value ? trackColorOn : trackColorOff,
            justifyContent: value ? 'flex-end' : 'flex-start',
          },
        ]}
        accessibilityRole="switch"
        accessibilityState={{ checked: value }}
      >
        <View style={styles.thumb} />
      </Pressable>
    );
  }
  return (
    <Switch
      value={value}
      onValueChange={onValueChange}
      trackColor={{ false: trackColorOff, true: trackColorOn }}
      thumbColor="#fff"
    />
  );
}

const styles = StyleSheet.create({
  track: {
    width: 51,
    height: 31,
    borderRadius: 16,
    padding: 2,
    flexDirection: 'row',
    alignItems: 'center',
    ...Platform.select({
      ios: {},
      android: { elevation: 0 },
    }),
  },
  thumb: {
    width: 27,
    height: 27,
    borderRadius: 14,
    backgroundColor: '#fff',
    ...shadowToggleThumb,
  },
});
