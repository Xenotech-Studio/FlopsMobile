#!/usr/bin/env node
/**
 * yarn dev [ios|android] [real] ["<Simulator Name>"] [--quick]: start Metro + run app.
 * --quick: 跳过清理 cache（不传 --reset-cache）。
 * 端口被占用时自动递增到下一可用端口，不再交互确认。
 * real (空格分隔，跟在 platform 后)：
 *   - android real：优先选第一台 USB/wifi 真机（adb，排除 emulator-*），未找到报错
 *   - ios real：找第一台连接的 iPhone/iPad（xcrun xctrace），未找到报错
 * 模拟器名（任意非 platform/real/--quick 的位置参数，含空格请加引号）：
 *   - 仅 iOS 模拟器生效，覆盖 rn-dev.config.json 的 ios.simulator。
 *     例：yarn dev ios "iPhone 16 Pro"
 * Platform: 1) yarn dev <ios|android>  2) rn-dev.config.json (per OS)  3) OS default.
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const concurrently = require('concurrently');

const projectRoot = path.resolve(__dirname, '..');
const configPath = path.join(projectRoot, 'rn-dev.config.json');
const DEFAULT_METRO_PORT = 8081;

function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const onDone = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(300);
    socket.on('connect', () => onDone(true));
    socket.on('timeout', () => onDone(false));
    socket.on('error', () => onDone(false));
    socket.connect(port, '127.0.0.1');
  });
}

function findFreePort(startFrom) {
  return (async () => {
    for (let p = startFrom; p < 65535; p++) {
      if (!(await isPortInUse(p))) return p;
    }
    return null;
  })();
}

function resolveMetroPort() {
  return isPortInUse(DEFAULT_METRO_PORT).then((inUse) => {
    if (!inUse) return DEFAULT_METRO_PORT;
    console.log(`[dev] 端口 ${DEFAULT_METRO_PORT} 已被占用，自动寻找下一可用端口…`);
    return findFreePort(DEFAULT_METRO_PORT + 1).then((port) => {
      if (port == null) {
        console.error('[dev] 未找到可用端口。\n');
        process.exit(1);
      }
      console.log(`[dev] 使用端口 ${port}\n`);
      return port;
    });
  });
}

function getDefaultSdkPath() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Android', 'sdk');
  }
  if (process.platform === 'linux') {
    return path.join(home, 'Android', 'Sdk');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || home, 'Android', 'Sdk');
  }
  return null;
}

function getSdkDirFromLocalProperties() {
  const localProp = path.join(projectRoot, 'android', 'local.properties');
  if (!fs.existsSync(localProp)) return null;
  try {
    const content = fs.readFileSync(localProp, 'utf8');
    const m = content.match(/sdk\.dir=(.+)/);
    if (m) {
      const dir = m[1].trim().replace(/^["']|["']$/g, '').replace(/\\/g, path.sep);
      return dir;
    }
  } catch (_) {}
  return null;
}

function ensureAndroidSdkConfigured() {
  const sdkDir =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    getSdkDirFromLocalProperties() ||
    getDefaultSdkPath();
  if (!sdkDir || !fs.existsSync(sdkDir)) {
    console.error('\n[android] Android SDK 未配置。');
    console.error('请任选其一：');
    console.error('  1) 设置环境变量 ANDROID_HOME（推荐）');
    console.error('     例如在 ~/.zshrc 中添加：');
    console.error('     export ANDROID_HOME=$HOME/Library/Android/sdk');
    console.error('     export PATH=$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH');
    console.error('  2) 在 android/local.properties 中设置 sdk.dir=你的SDK路径');
    console.error('');
    process.exit(1);
  }
}

function getPlatformFromConfig() {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const conf = JSON.parse(raw);
    const byOs = conf.platform;
    if (byOs && typeof byOs === 'object') {
      const p = byOs[process.platform]; // darwin, win32, linux
      if (p === 'ios' || p === 'android') return p;
    }
  } catch (_) {}
  return null;
}

const argv = process.argv.slice(2);
const quick = argv.includes('--quick');
/* 入参形式：
 *   yarn dev ios
 *   yarn dev android
 *   yarn dev ios real        (空格分隔)
 *   yarn dev android real    (空格分隔)
 *   yarn dev ios:real        (兼容老的冒号形式)
 *   yarn dev android:real    (兼容)
 * 内部统一规范化成 'ios' / 'android' / 'ios:real' / 'android:real' 传给 run-app.js。 */
const VALID_PLATFORMS = ['ios', 'android'];
const platformArg = argv.find((a) =>
  VALID_PLATFORMS.includes(a) || a === 'ios:real' || a === 'android:real'
);
const wantReal = argv.includes('real');
/* 模拟器名：第一个「既不是 platform token、也不是 real / --quick / 冒号形式」的位置参数。
 * 含空格的名字（如 "iPhone 16 Pro"）shell 会作为单个 argv 传进来。仅 iOS 模拟器用，透传给 run-app.js。 */
const simulatorName =
  argv.find(
    (a) =>
      !a.startsWith('-') &&
      a !== 'real' &&
      a !== platformArg &&
      !VALID_PLATFORMS.includes(a) &&
      a !== 'ios:real' &&
      a !== 'android:real'
  ) || null;
const configPlatform = getPlatformFromConfig();
const isDarwin = process.platform === 'darwin';
const osDefault = isDarwin ? 'ios' : 'android';

let target;
if (platformArg === 'ios:real' || platformArg === 'android:real') {
  // 老形式冒号已经带 real 后缀
  target = platformArg;
} else {
  const platform = platformArg || configPlatform || osDefault;
  target = wantReal ? `${platform}:real` : platform;
}

if (target === 'android' || target === 'android:real') {
  ensureAndroidSdkConfigured();
}

const runAppScript = path.resolve(__dirname, 'run-app.js');

resolveMetroPort().then((port) => {
  const cacheFlag = quick ? '' : ' --reset-cache';
  const { result } = concurrently(
    [
      { command: `react-native start --port ${port}${cacheFlag}`, name: 'metro' },
      {
        command: `node ${JSON.stringify(runAppScript)} ${target} ${port}${
          simulatorName ? ` ${JSON.stringify(simulatorName)}` : ''
        }`,
        name: target,
      },
    ],
    {
      prefix: 'name',
      prefixLength: 8,
    }
  );

  result
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
});
