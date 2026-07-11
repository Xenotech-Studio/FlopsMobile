/**
 * 附件下载。
 * - Android：交给系统 DownloadManager 存进「下载」目录，状态栏出下载通知，完成后可在文件管理器看到。
 * - iOS：先下到沙盒 Documents，再用 RN 核心 Share.share 弹系统分享菜单（存到文件 / AirDrop / 转发到其它 app）。
 * 依赖 react-native-blob-util（已作为 react-native-pdf 的 peer 引入）。
 *
 * ⚠️ URL scheme 必须是 http/https：Android 的 DownloadManager.enqueue() 对非 http/https URI 会抛
 * uncaught IllegalArgumentException（在原生后台线程，JS 层的 .catch 拦不住 → 直接杀进程崩溃）。
 * 因此下载前先 resolveDownloadUrl() 把相对路径拼成 server_base_url 的绝对 url；无法绝对化（其它
 * scheme 如 cos:// 或无 base 的相对路径）时不发起下载，Android 弹 Toast、iOS 静默失败。
 *
 * ⚠️ iOS 不用 react-native-blob-util 的 ios.presentOptionsMenu：它硬编码从 AppDelegate 取 window
 * 找 rootViewController，而本 app 是 UIScene 架构（window 挂在 SceneDelegate，AppDelegate 无 window），
 * 取到 nil → presentOptionsMenuFromRect:inView:nil 原生崩溃（且在 dispatch_sync(main) 里，JS 拦不住）。
 * 改用 RN 核心 Share（由 core 从正确的 scene window present），Share 失败（iPad 无 anchor 等）退回 Safari。
 */
import { Linking, Platform, Share, ToastAndroid } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';

/** 去掉路径分隔等不安全字符，保底名 attachment */
function sanitizeFilename(name?: string): string {
  const n = (name ?? '').trim().replace(/[/\\:*?"<>|]/g, '_');
  return n || 'attachment';
}

/**
 * 归一成可交给 DownloadManager 的绝对 http(s) url；无法归一时返回 null（调用方据此降级/提示）。
 * - 已是 http(s)：原样返回。
 * - 协议相对 `//host/path`：补 https:。
 * - 其它 scheme（cos:// / oss:// / file:// …）：无法绝对化 → null（否则 DownloadManager 会崩）。
 * - 相对路径：拼 baseUrl（server_base_url，normalizeServerUrl 后末尾带 /）；无合法 base 时 → null。
 */
function resolveDownloadUrl(url: string, baseUrl?: string): string | null {
  const u = (url ?? '').trim();
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return `https:${u}`;
  // 带 scheme 但非 http/https（cos:// 等）：无法转成可下载的 http(s) url
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return null;
  // 走到这里 = 相对路径，拼服务端 base
  const base = (baseUrl ?? '').trim();
  if (!base || !/^https?:\/\//i.test(base)) return null;
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const path = u.startsWith('/') ? u : `/${u}`;
  return `${b}${path}`;
}

export async function downloadAttachment(
  url: string,
  filename?: string,
  baseUrl?: string,
): Promise<void> {
  const resolved = resolveDownloadUrl(url, baseUrl);
  if (!resolved) {
    // 非 http/https 且无法绝对化：不发起下载，避免 Android DownloadManager 抛未捕获异常崩溃。
    if (Platform.OS === 'android') {
      ToastAndroid.show('暂不支持下载此文件', ToastAndroid.SHORT);
    }
    return;
  }

  const safeName = sanitizeFilename(filename);

  if (Platform.OS === 'android') {
    try {
      await ReactNativeBlobUtil.config({
        addAndroidDownloads: {
          useDownloadManager: true,
          notification: true,
          title: safeName,
          description: '附件下载',
          mediaScannable: true,
          path: `${ReactNativeBlobUtil.fs.dirs.DownloadDir}/${safeName}`,
        },
      }).fetch('GET', resolved);
    } catch {
      // enqueue 之外的 JS 侧 reject（网络/权限等）兜底提示，不冒泡
      ToastAndroid.show('下载失败', ToastAndroid.SHORT);
    }
    return;
  }

  // iOS：先下到沙盒 Documents（固定文件名，重复下载覆盖旧文件），再用 RN 核心 Share 弹系统分享菜单。
  // 不用 blob-util 的 presentOptionsMenu —— 它在本 app 的 UIScene 架构下会 anchor 到 nil view 原生崩溃。
  const path = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/${safeName}`;
  await ReactNativeBlobUtil.fs.unlink(path).catch(() => {});
  const res = await ReactNativeBlobUtil.config({ path }).fetch('GET', resolved);
  const localPath = res.path();
  try {
    await Share.share({ url: `file://${localPath}` });
  } catch {
    // Share 失败（iPad 无 anchor / 用户取消 / present 异常）：退回系统浏览器打开原链接
    await Linking.openURL(resolved).catch(() => {});
  }
}

/**
 * 附件在本地沙盒的固定落点（与 downloadToSandbox 落点一致）：Android 系统下载目录 / iOS 沙盒 Documents。
 * 下载写入与「是否已下载」检查都调它，保证 sanitizeFilename 归一后路径一致（否则退出重进会误判未下载）。
 */
export function getLocalPath(filename?: string): string {
  const safeName = sanitizeFilename(filename);
  const dir =
    Platform.OS === 'android'
      ? ReactNativeBlobUtil.fs.dirs.DownloadDir
      : ReactNativeBlobUtil.fs.dirs.DocumentDir;
  return `${dir}/${safeName}`;
}

/** 检查该附件是否已下载到本地：已存在返回其 localPath，否则返回 null。 */
export async function getDownloadedLocalPath(filename?: string): Promise<string | null> {
  const p = getLocalPath(filename);
  try {
    const exists = await ReactNativeBlobUtil.fs.exists(p);
    return exists ? p : null;
  } catch {
    return null;
  }
}

export type DownloadResult = { localPath: string };

/**
 * 下载到应用可见位置，通过 onProgress 实时报告 0-100 百分比。返回 { localPath }；
 * url 无法绝对化（非 http/https 相对/其它 scheme）时返回 null（Android 顺带 Toast 提示）。
 * 对齐 Desktop 的两段式下载：先 downloadToSandbox（出进度条），完成后再 shareLocalFile（点文件夹弹分享）。
 * - Android：手动流式下载到系统「下载」目录（useDownloadManager:false 才有 JS 进度回调），
 *   完成后 scanFile 注册到媒体库，让文件管理器可见。不自动弹分享。
 * - iOS：下载到沙盒 Documents。
 */
export async function downloadToSandbox(
  url: string,
  filename?: string,
  baseUrl?: string,
  onProgress?: (percent: number) => void,
): Promise<DownloadResult | null> {
  const resolved = resolveDownloadUrl(url, baseUrl);
  if (!resolved) {
    if (Platform.OS === 'android') {
      ToastAndroid.show('暂不支持下载此文件', ToastAndroid.SHORT);
    }
    return null;
  }

  const localPath = getLocalPath(filename);
  await ReactNativeBlobUtil.fs.unlink(localPath).catch(() => {});

  const task = ReactNativeBlobUtil.config({ path: localPath }).fetch('GET', resolved);
  if (onProgress) {
    task.progress({ interval: 100 }, (received: number | string, total: number | string) => {
      const r = Number(received);
      const t = Number(total);
      const pct = t > 0 ? Math.min(100, Math.max(0, Math.round((r / t) * 100))) : 0;
      onProgress(pct);
    });
  }
  const res = await task;
  const outPath = res.path() || localPath;

  if (Platform.OS === 'android') {
    // useDownloadManager:false 不会自动扫描；手动注册到媒体库让「下载」/文件管理器可见
    try {
      await ReactNativeBlobUtil.fs.scanFile([{ path: outPath }]);
    } catch {
      /* 扫描失败不影响下载结果 */
    }
  }
  onProgress?.(100);
  return { localPath: outPath };
}

/** 对已下载到本地的文件弹系统分享菜单（存到文件 / AirDrop / 转发到其它 app）；失败退回系统打开。 */
export async function shareLocalFile(localPath: string): Promise<void> {
  const fileUrl = localPath.startsWith('file://') ? localPath : `file://${localPath}`;
  try {
    await Share.share({ url: fileUrl });
  } catch {
    // Share 失败（iPad 无 anchor / present 异常）：退回系统打开
    await Linking.openURL(fileUrl).catch(() => {});
  }
}
