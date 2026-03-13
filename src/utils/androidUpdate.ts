/**
 * Android 应用内更新：下载 APK 到本地、调起系统安装。
 * 下载与安装分两步：下载完成后由用户决定何时点击「重启并更新」。
 */
import { Platform, NativeModules } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';

const { fs } = ReactNativeBlobUtil;

export type DownloadResult = { path: string };

/**
 * 将 APK 下载到应用缓存目录，返回本地路径。支持进度回调。
 */
export async function downloadApk(
  downloadUrl: string,
  filename: string,
  onProgress?: (percent: number) => void
): Promise<DownloadResult> {
  const dir = fs.dirs.CacheDir;
  const path = `${dir}/${filename}`;
  const response = await ReactNativeBlobUtil.config({ path })
    .fetch('GET', downloadUrl)
    .progress((received, total) => {
      if (total > 0 && typeof onProgress === 'function') {
        const percent = Math.round((received / total) * 100);
        onProgress(Math.min(100, percent));
      }
    });
  if (response.respInfo.status !== 200) {
    throw new Error(`下载失败: HTTP ${response.respInfo.status}`);
  }
  return { path: response.path() };
}

/**
 * 调起系统安装界面安装已下载的 APK（仅 Android）。
 * 需 REQUEST_INSTALL_PACKAGES 权限；Android 7+ 需 FileProvider，由 react-native-install-apk 提供。
 */
export function installApk(apkPath: string): Promise<void> {
  if (Platform.OS !== 'android') {
    return Promise.reject(new Error('仅支持 Android'));
  }
  const InstallApk = NativeModules.InstallApk;
  if (!InstallApk || typeof InstallApk.install !== 'function') {
    return Promise.reject(new Error('安装模块不可用'));
  }
  return Promise.resolve(InstallApk.install(apkPath));
}
