import React from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  Pressable,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from 'react-native-vector-icons/Ionicons';

type TaskFilterSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** 若需与 FlowTaskIOS 一致，可在此内渲染状态/时间/项目名等选项 */
  children?: React.ReactNode;
};

export function TaskFilterSheet({ visible, onClose, children }: TaskFilterSheetProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <View
          style={[
            styles.panel,
            {
              top: insets.top + 56,
              right: 16,
              minWidth: Math.min(width * 0.5, 200),
            },
          ]}
          onStartShouldSetResponder={() => true}
        >
          <View style={styles.header}>
            <Text style={styles.title}>筛选</Text>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <Ionicons name="close" size={22} color="#374151" />
            </TouchableOpacity>
          </View>
          {children != null ? children : (
            <Text style={styles.placeholder}>选项敬请期待</Text>
          )}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  panel: {
    position: 'absolute',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: { fontSize: 17, fontWeight: '600', color: '#111827' },
  placeholder: { fontSize: 14, color: '#9ca3af' },
});
