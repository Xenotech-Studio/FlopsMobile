/**
 * 附件应用内下载（不跳浏览器）。
 * - Android：交给系统 DownloadManager 存进「下载」目录，状态栏出下载通知，完成后可在文件管理器看到。
 * - iOS：先下到沙盒 Documents，再弹系统分享/保存菜单（可「存储到文件」/AirDrop/分享给 app）。
 * 依赖 react-native-blob-util（已作为 react-native-pdf 的 peer 引入）。
 */
import { Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';

/** 去掉路径分隔等不安全字符，保底名 attachment */
function sanitizeFilename(name?: string): string {
  const n = (name ?? '').trim().replace(/[/\\:*?"<>|]/g, '_');
  return n || 'attachment';
}

export async function downloadAttachment(url: string, filename?: string): Promise<void> {
  const safeName = sanitizeFilename(filename);

  if (Platform.OS === 'android') {
    await ReactNativeBlobUtil.config({
      addAndroidDownloads: {
        useDownloadManager: true,
        notification: true,
        title: safeName,
        description: '附件下载',
        mediaScannable: true,
        path: `${ReactNativeBlobUtil.fs.dirs.DownloadDir}/${safeName}`,
      },
    }).fetch('GET', url);
    return;
  }

  // iOS：固定文件名落到 Documents（重复下载覆盖旧文件，避免越积越多），完成弹 options menu
  const path = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/${safeName}`;
  await ReactNativeBlobUtil.fs.unlink(path).catch(() => {});
  const res = await ReactNativeBlobUtil.config({ path }).fetch('GET', url);
  ReactNativeBlobUtil.ios.presentOptionsMenu(res.path());
}
