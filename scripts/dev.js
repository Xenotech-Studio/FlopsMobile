#!/usr/bin/env node
/**
 * yarn dev [ios|android] [--quick]: start Metro + run app.
 * --quick: 跳过清理 cache（不传 --reset-cache）、端口被占用时跳过确认直接使用下一可用端口。
 * Platform: 1) yarn dev ios / yarn dev android  2) rn-dev.config.json (per OS)  3) OS default.
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const readline = require('readline');
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

function askUseOtherPort() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('\n[dev] 端口 8081 已被占用。是否改用其他端口？(Y/n) ', (answer) => {
      rl.close();
      const trimmed = (answer || '').trim().toLowerCase();
      if (trimmed === 'n' || trimmed === 'no') {
        console.error('已取消。可先结束占用端口的进程：lsof -i :8081\n');
        process.exit(1);
      }
      resolve();
    });
  });
}

function resolveMetroPort(skipPortConfirm) {
  return isPortInUse(DEFAULT_METRO_PORT).then((inUse) => {
    if (!inUse) return DEFAULT_METRO_PORT;
    const next = () =>
      findFreePort(DEFAULT_METRO_PORT + 1).then((port) => {
        if (port == null) {
          console.error('[dev] 未找到可用端口。\n');
          process.exit(1);
        }
        console.log(`[dev] 使用端口 ${port}\n`);
        return port;
      });
    if (skipPortConfirm) return next();
    return askUseOtherPort().then(next);
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

function ensureAndroidSdkConfigured() {
  const sdkDir = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || getDefaultSdkPath();
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
const argOverride = argv.find((a) => a === 'ios' || a === 'android'); // yarn dev ios | yarn dev ios --quick
const configPlatform = getPlatformFromConfig();
const isDarwin = process.platform === 'darwin';
const osDefault = isDarwin ? 'ios' : 'android';

const target = (argOverride === 'ios' || argOverride === 'android')
  ? argOverride
  : (configPlatform || osDefault);

if (target === 'android') {
  ensureAndroidSdkConfigured();
}

const runAppScript = path.resolve(__dirname, 'run-app.js');

resolveMetroPort(quick).then((port) => {
  const cacheFlag = quick ? '' : ' --reset-cache';
  const { result } = concurrently(
    [
      { command: `react-native start --port ${port}${cacheFlag}`, name: 'metro' },
      { command: `node ${JSON.stringify(runAppScript)} ${target} ${port}`, name: target },
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
