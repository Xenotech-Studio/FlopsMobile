/**
 * 推送通知偏好（本地持久化）。
 *
 * - `push_enabled`：用户在「账户 → 通知」分组里的总开关。
 *   默认 `false`（首次安装不打扰），用户主动开启后才会触发 iOS 权限框 + 注册 token。
 * - 与 iOS 系统权限是两个独立维度：用户可能 toggle on 但 iOS 权限被关闭，
 *   反过来也成立；UI 层应同时展示二者。
 *
 * 注意：本模块只持久化「用户偏好」，不缓存 device token；token 由
 * `FlopsPushModule.sharedCachedToken`（原生层）和服务端 Redis 各自负责。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PUSH_ENABLED = 'flops:settings:push_enabled';

export async function getPushEnabled(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(KEY_PUSH_ENABLED);
    return v === '1';
  } catch {
    return false;
  }
}

export async function setPushEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_PUSH_ENABLED, enabled ? '1' : '0');
  } catch {
    // AsyncStorage 写失败不致命：下次 app 启动会按默认 off 处理，最差情况是用户需要重新开 toggle。
  }
}
