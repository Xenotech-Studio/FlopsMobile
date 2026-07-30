/**
 * 设备信标（beacon）上报 —— AppState → 服务端设备级在线目录。**四端统一系统的移动端。**
 *
 * **iOS + Android 都跑**、**设备级**（device_id = {platform}_{clientInstanceId}），独立于推送权限。
 * 喂养 remote_mic 的 /phones（Android 因此首次进设备列表）；APNs 推送抑制也改读这份设备级 presence
 * （旧的 iOS 用户级 PresenceReporter / /api/push/apns/presence 已删）。
 *
 * 行为：
 * - 有 session 即上报（不依赖推送权限 / APNs）。
 * - 前台：立即 ping{state:foreground} + 每 30s 心跳（服务端记录 TTL 75s，2.5 拍容差）。
 * - 转后台（background）：默认 **leave**（移动端后台即丢 inbox SSE → 不再 SSE 可达，立刻从在线集合
 *   消失；iOS 仍可经 APNs 唤醒，Android 则从 /phones 消失 —— 诚实反映不可达）。**例外：播报模式开着时
 *   不 leave**，心跳继续保活（服务端每拍置 state=online、broadcast_mode 保持 true）—— 锁屏后台仍在放
 *   TTS，靠后台音频会话让 JS 定时器存活，桌面端喇叭图标不熄、turn_done 推送可达；播报一旦被关掉，下一
 *   拍心跳自查后 leave。
 * - inactive（键盘弹出 / 下拉控制中心 / 来电 / 应用切换预览等 iOS 瞬时态）：**不 leave**、不停心跳 ——
 *   并非真离开，否则每弹一次键盘就 ping→leave 抖动误删记录。真进后台会紧跟一个 background 收尾。
 * - 登出 / 卸载：leave。
 */
import { useEffect, useRef } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { useSession } from '../context/SessionContext';
import { beaconPing, beaconLeave, type BeaconPlatform } from '../api/beacon';
import { getBeaconDeviceId } from '../utils/clientInstanceId';
import { getBroadcastMode } from '../audio/ttsRealtime';
import { getDeviceIdentity, iosDisplayName } from './apnsClient';

const HEARTBEAT_MS = 30 * 1000;

type BeaconIdentity = {
  deviceId: string;
  platform: BeaconPlatform;
  deviceName: string;
  idfv: string;
};

/** 厂商名常全小写（如「samsung」/「xiaomi」）—— 首字母大写成「Samsung」/「Xiaomi」。 */
function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Android 设备名：零依赖走 Platform.constants（Manufacturer/Brand + Model）。
 *
 * ⚠️ Android 没有 iOS 那种「营销名」系统 API。Build.MODEL 对 Pixel / OnePlus 常已是营销名（如
 * 「Pixel 8 Pro」），但**三星 / 小米多为内部型号码**（如三星「SM-S928B」、小米「23127PN0CC」）——
 * 想转成「Galaxy S24 Ultra」这类营销名，只能内置 Google 设备目录（supported_devices.csv，数万条），
 * 非零依赖，暂不做。这里给出零依赖能拿到的最干净组合：厂商（首字母大写）+ 型号，型号已含厂商则不重复。
 *
 * dev build（com.flopsmobile.dev）与 release（com.flopsmobile）是两个独立 install，各自的 AsyncStorage →
 * 不同 android_<uuid>，presence 里各留一条（Android 无 identifierForVendor 去重）。给 dev 的展示名加
 * 「 (DEV)」后缀，一眼区分同机的两条记录。
 */
function androidDeviceName(): string {
  const c = (Platform.constants || {}) as {
    Model?: string;
    Brand?: string;
    Manufacturer?: string;
  };
  const model = (c.Model || '').trim();
  const brand = titleCase((c.Manufacturer || c.Brand || '').trim());
  const base = !model
    ? brand || 'Android'
    : !brand || model.toLowerCase().startsWith(brand.toLowerCase())
      ? model
      : `${brand} ${model}`;
  return __DEV__ ? `${base} (DEV)` : base;
}

async function resolveIdentity(): Promise<BeaconIdentity> {
  const deviceId = await getBeaconDeviceId();
  if (Platform.OS === 'ios') {
    const id = await getDeviceIdentity();
    return {
      deviceId,
      platform: 'ios',
      deviceName: iosDisplayName(id.deviceName),
      idfv: id.identifierForVendor || '',
    };
  }
  return { deviceId, platform: 'android', deviceName: androidDeviceName(), idfv: '' };
}

export function BeaconReporter(): null {
  const { session, serverBaseUrl } = useSession();
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const identityRef = useRef<BeaconIdentity | null>(null);

  useEffect(() => {
    if (!session) return;

    let cancelled = false;

    const stopHeartbeat = () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };

    const ensureIdentity = async (): Promise<BeaconIdentity | null> => {
      if (identityRef.current) return identityRef.current;
      const ident = await resolveIdentity();
      if (cancelled) return null;
      identityRef.current = ident;
      return ident;
    };

    const ping = async (state: 'foreground' | 'background') => {
      const ident = await ensureIdentity();
      if (!ident || cancelled) return;
      void beaconPing(serverBaseUrl, session.access_token, {
        device_id: ident.deviceId,
        platform: ident.platform,
        device_name: ident.deviceName,
        state,
        identifier_for_vendor: ident.idfv || undefined,
        broadcast_mode: getBroadcastMode(), // 每拍心跳都带上当前播报开关，让 presence 常与本地同步
      });
    };

    // 下线不受 cancelled 拦（cleanup 时也要发出去）：用已缓存身份即时 leave；缓存缺失才解析一次。
    const leave = async () => {
      const ident = identityRef.current || (await resolveIdentity().catch(() => null));
      if (!ident) return;
      void beaconLeave(serverBaseUrl, session.access_token, ident.deviceId);
    };

    // 心跳：立即打一拍 + 每 HEARTBEAT_MS 续拍（服务端每拍置 state=online、刷新 last_seen）。
    const startHeartbeat = (state: 'foreground' | 'background') => {
      stopHeartbeat();
      void ping(state);
      heartbeatRef.current = setInterval(() => {
        // 后台保活拍：播报被关掉（如后台 TTS 自动停）就别再把设备留成 online —— 停拍并干净下线。
        if (state === 'background' && !getBroadcastMode()) {
          stopHeartbeat();
          void leave();
          return;
        }
        void ping(state);
      }, HEARTBEAT_MS);
    };

    const apply = (status: AppStateStatus) => {
      if (status === 'active') {
        startHeartbeat('foreground');
      } else if (status === 'background') {
        // 默认真进后台就下线（丢 inbox SSE → 不再可达，诚实从在线集合消失）。
        // 例外：播报模式开着 —— 锁屏后台仍在放 TTS，不 leave、心跳继续保活（state=online、
        // broadcast_mode=true），桌面端喇叭图标不熄、turn_done 推送可达。靠后台音频会话让 JS 定时器存活；
        // 播报一旦关掉，下一拍心跳自查后 leave；进程被挂起/杀掉则服务端 TTL 75s 兜底过期。
        if (getBroadcastMode()) {
          startHeartbeat('background');
        } else {
          stopHeartbeat();
          void leave();
        }
      }
      // 'inactive'：iOS 瞬时态（键盘 / 控制中心 / 来电 / 切换预览），app 仍在前台、JS 定时器照跑。
      // 不 leave、不停心跳 —— 记录靠继续的心跳保活；真离开时紧跟的 'background' 才收尾。若罕见地
      // 长期停在 inactive，进程被挂起后心跳自然停，服务端 TTL 75s 兜底过期。
    };

    apply(AppState.currentState);
    const sub = AppState.addEventListener('change', apply);

    return () => {
      cancelled = true;
      stopHeartbeat();
      sub.remove();
      void leave();
    };
  }, [session, serverBaseUrl]);

  return null;
}
