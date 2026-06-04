#!/usr/bin/env node
/**
 * yarn dev [ios|android] [real] ["<Simulator Name>"] [--quick]: start Metro + run app.
 * --quick: 跳过清理 cache（不传 --reset-cache）。
 * 端口被占用时自动递增到下一可用端口，不再交互确认。
 * real (空格分隔，跟在 platform 后)：
 *   - android real：优先选第一台 USB/wifi 真机（adb，排除 emulator-*），未找到报错
 *   - ios real：找连接的 iOS 真机（xcrun xctrace），优先 iPhone、没 iPhone 才用 iPad，未找到报错
 * ipad / iphone（替代 platform token）：等价于 ios:real，但按设备类型过滤真机。
 *   - yarn dev ipad   → 找第一台连接的 iPad（隐含 real，无需再写 real）
 *   - yarn dev iphone → 找第一台连接的 iPhone（隐含 real）
 *   （模拟器不区分类型：要指定模拟器直接用 yarn dev ios "<Simulator Name>"。）
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

/* 端口可用性检测：用「实际 try-listen 绑定」而非 connect 探测。
 * 原因：connect 探测（连不上=空闲）只能看「现在有没有 listener」，从探测到 Metro 真正 listen
 * 之间有几秒窗口——两个 yarn dev 同时跑会都探测到 8081 空闲、都去用，第二个 Metro listen 才失败。
 * try-listen 绑成功立刻释放并返回 true：既准确识别「已被占用」，窗口也比 connect 小得多。 */
function canBindPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false)); // EADDRINUSE 等 → 不可用
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    /* 不指定 host：绑到通配地址（IPv6 :: + IPv4 0.0.0.0），跟 Metro 实际监听一致。
       之前绑 '127.0.0.1'（仅 IPv4）会误判：Metro 监听 ':::8081'（IPv6 通配），IPv4 检测能绑成功
       → 误以为空闲 → 第二个 dev 也用 8081 → Metro 绑 IPv6 时 EADDRINUSE。 */
    server.listen(port);
  });
}

function findFreePort(startFrom) {
  return (async () => {
    for (let p = startFrom; p < 65535; p++) {
      if (await canBindPort(p)) return p;
    }
    return null;
  })();
}

function resolveMetroPort() {
  /* 起始端口加一点随机抖动：两个 dev 几乎同秒启动时，从不同端口开始找，进一步降低撞车概率。
   * 8081 默认仍优先（单开时端口稳定）；只有 8081 被占才进抖动搜索。 */
  return canBindPort(DEFAULT_METRO_PORT).then((free) => {
    if (free) return DEFAULT_METRO_PORT;
    console.log(`[dev] 端口 ${DEFAULT_METRO_PORT} 已被占用，自动寻找下一可用端口…`);
    const jitterStart = DEFAULT_METRO_PORT + 1 + Math.floor(Math.random() * 8);
    return findFreePort(jitterStart).then((port) => {
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
/* ipad / iphone 是 iOS 真机的「设备类型」别名：隐含 ios:real，并按类型过滤连接的真机。
 * 透传给 run-app.js 的是环境变量 FLOPS_IOS_DEVICE_KIND（'ipad' / 'iphone'）。 */
const deviceKindArg = argv.find((a) => a === 'ipad' || a === 'iphone') || null;
const platformArg = argv.find((a) =>
  VALID_PLATFORMS.includes(a) || a === 'ios:real' || a === 'android:real'
);
const wantReal = argv.includes('real');
/* 引号位置参数：第一个「既不是 platform token、也不是 real / --quick / 冒号形式」的参数。
 * 含空格的名字（如 "iPhone 16 Pro"）shell 会作为单个 argv 传进来。两用，透传给 run-app.js：
 *   - 模拟器模式（yarn dev ios "iPhone 16 Pro"）：当模拟器名。
 *   - 真机模式（yarn dev iphone "Steven" / yarn dev ios real "Haowen"）：当真机名子串过滤，
 *     区分同类型多台真机（两台 iPhone 各跑一个 dev）。 */
const simulatorName =
  argv.find(
    (a) =>
      !a.startsWith('-') &&
      a !== 'real' &&
      a !== platformArg &&
      a !== deviceKindArg &&
      a !== 'ipad' &&
      a !== 'iphone' &&
      !VALID_PLATFORMS.includes(a) &&
      a !== 'ios:real' &&
      a !== 'android:real'
  ) || null;
const configPlatform = getPlatformFromConfig();
const isDarwin = process.platform === 'darwin';
const osDefault = isDarwin ? 'ios' : 'android';

let target;
if (deviceKindArg) {
  // yarn dev ipad / iphone：隐含 iOS 真机，类型靠 FLOPS_IOS_DEVICE_KIND 过滤。
  target = 'ios:real';
} else if (platformArg === 'ios:real' || platformArg === 'android:real') {
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

/* iOS 真机类型过滤透传给 run-app.js。concurrently 启动的子进程继承父进程 env，
 * 所以在这里设到 process.env 即可（run-app.js 读 FLOPS_IOS_DEVICE_KIND）。 */
if (deviceKindArg) {
  process.env.FLOPS_IOS_DEVICE_KIND = deviceKindArg;
}

/* 把本 dev 会话的 pid 透传给 run-app.js，用作「设备占用锁」的 owner pid。
 * run-app 是短命进程（装完 app 就退出），不能用它的 pid 当锁主——它退出锁就失效、设备被误判空闲。
 * dev.js 活整个会话（Metro 在跑），用它的 pid 当锁主：会话活着 = 设备被占；会话死 = 锁自动失效。 */
process.env.FLOPS_DEV_SESSION_PID = String(process.pid);

resolveMetroPort().then((port) => {
  const cacheFlag = quick ? '' : ' --reset-cache';
  const { result, commands } = concurrently(
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
      /* run-app 装完 app 就成功退出（不是常驻），所以不能 on 'success'——那会顺手杀掉 Metro。
         只在某条命令失败时联动清理。killOthersOn 是新 API（killOthers 已废弃）。 */
      killOthersOn: ['failure'],
      restartTries: 0,
    }
  );

  /* 关键：dev.js 退出时（无论什么原因）把 concurrently 起的子进程（尤其常驻的 Metro）一并杀掉，
     不留僵尸 Metro 占端口 / 不留孤儿 dev 进程。
     覆盖所有退出路径：
       - SIGINT  = Ctrl-C
       - SIGTERM = kill / 编辑器停止
       - SIGHUP  = 关终端窗口 / shell 退出（这条是产生孤儿的主因——之前没处理，
                   关窗口时 dev.js 收不到/没处理 SIGHUP，子进程脱离终端被 launchd 收养成孤儿）
       - exit    = 兜底，任何正常/异常退出都再清一次 */
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      commands.forEach((c) => c.kill('SIGTERM'));
    } catch (_) {}
  };
  const onSignalExit = (code) => () => {
    cleanup();
    process.exit(code);
  };
  process.on('SIGINT', onSignalExit(130));
  process.on('SIGTERM', onSignalExit(143));
  process.on('SIGHUP', onSignalExit(129));
  process.on('exit', cleanup); // 同步兜底：进程真正退出前最后清一次

  /* 父进程死亡看门狗：信号不一定可靠（尤其暴力关终端 / 父被 SIGKILL 时子收不到 SIGHUP），
     这是兜底——轮询自己的 ppid，一旦变成 1（= 原 shell 死了、被 launchd 收养 = 我成了孤儿），
     立刻 cleanup + 退出。这正是之前那个 ppid=1 孤儿 dev 进程的场景，看门狗能主动自杀清掉。 */
  const startPpid = process.ppid;
  const orphanWatch = setInterval(() => {
    if (process.ppid !== startPpid || process.ppid === 1) {
      cleanup();
      process.exit(129);
    }
  }, 2000);
  orphanWatch.unref(); // 不让看门狗本身阻止进程正常退出

  result
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
});
