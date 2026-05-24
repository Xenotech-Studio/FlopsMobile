/**
 * 顶角漂浮返回按钮：HeaderCircleButton 的 thin wrapper，默认 chevron-back / chevron.backward
 * + 调 navigation.goBack()。
 *
 * 适用于 detail / chat 类页面（顶栏左上角）。settings / 用量页这种 header 行 chevron 不用
 * 此组件，保持原扁平 icon 设计。
 */
import React, { useCallback } from 'react';
import { useNavigation } from '@react-navigation/native';
import { HeaderCircleButton } from './HeaderCircleButton';

type Props = {
  /** 覆盖默认 goBack 行为（少见，比如要先 unsaved-changes 提示） */
  onPress?: () => void;
  disabled?: boolean;
};

export function HeaderBackButton({ onPress, disabled }: Props) {
  const navigation = useNavigation();
  const handlePress = useCallback(() => {
    if (onPress) {
      onPress();
      return;
    }
    if (navigation.canGoBack()) {
      navigation.goBack();
    }
  }, [onPress, navigation]);

  return (
    <HeaderCircleButton
      ionicon="chevron-back"
      sfSymbol="chevron.backward"
      iconSize={24}
      onPress={handlePress}
      disabled={disabled}
    />
  );
}
