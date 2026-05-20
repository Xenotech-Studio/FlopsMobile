/**
 * 本机 K_user 的 AsyncStorage 持久化。
 *
 * - 与 web SDK 的 localStorage 行为一致：base64 字符串
 * - key 命名沿用 RN session/theme 风格：'@FlopsMobile/kUser'
 * - 不持久 plaintext password 或 KDK；这些只在 login 瞬间存在于内存
 * - 取到空字符串 / null = "本机没有 K_user"，UI 可据此判断是否能创建加密对话
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY_KUSER = '@FlopsMobile/kUser';

export async function getStoredKUser(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(STORAGE_KEY_KUSER);
  } catch {
    return null;
  }
}

export async function setStoredKUser(kUserBase64: string): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY_KUSER, kUserBase64);
  } catch {
    // 写不进去就算了；下次登录还会再补一份
  }
}

export async function clearStoredKUser(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY_KUSER);
  } catch {
    // ignore
  }
}

export async function hasStoredKUser(): Promise<boolean> {
  const v = await getStoredKUser();
  return typeof v === 'string' && v.length > 0;
}
