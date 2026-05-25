#!/usr/bin/env node
/**
 * Waits for Metro to be ready, then runs react-native run-ios or run-android.
 * Used by yarn dev so the app launches after the packager is up.
 * iOS: reads rn-dev.config.json "ios.simulator" for --simulator "Device Name".
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const target = process.argv[2] || 'ios'; // ios | android | android:real
const METRO_PORT = parseInt(process.argv[3] || process.env.METRO_PORT || '8081', 10);
const POLL_INTERVAL_MS = 800;
const METRO_WAIT_TIMEOUT_MS = 60000;

/**
 * 通过 adb devices 找第一个非模拟器设备（serial 不以 emulator- 开头）。
 * @returns {string|null} 设备 id 或 null
 */
function getFirstRealAndroidDevice() {
  try {
    const out = execSync('adb devices', { encoding: 'utf8' });
    const lines = out.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('List of devices')) continue;
      const serial = trimmed.split(/\s+/)[0];
      if (serial && !serial.startsWith('emulator-')) return serial;
    }
  } catch (_) {}
  return null;
}

function getIosSimulator() {
  try {
    const configPath = path.resolve(__dirname, '..', 'rn-dev.config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const conf = JSON.parse(raw);
    const name = conf.ios && conf.ios.simulator;
    if (typeof name === 'string' && name.trim()) return name.trim();
  } catch (_) {}
  return null;
}

/**
 * iOS 防御性清理：删 ios/ 目录下所有 .DS_Store。
 *
 * 缘起：RN 0.84 的 prebuilt RNDeps 用 [CP-User] script phase 在 Debug/Release
 * variant 之间 swap xcframework，用 `rmdir` 清空中间目录。任何残留的 .DS_Store
 * （Finder 偷塞 / 别的工具留下的）都会让"空目录"实际不空，rmdir 失败，整次
 * xcodebuild 挂掉（典型报错 `ENOTEMPTY: directory not empty, rmdir
 * 'ReactNativeDependencies.xcframework/Headers'`）。
 *
 * 最常见场景：跑过一次 Release archive（如 yarn build ios testflight）之后再
 * 切回 Debug 用 yarn dev ios。下次 swap variant 时 stale .DS_Store 就会绊脚。
 *
 * 用 macOS 自带的 find 一行删干净，零依赖、毫秒级。失败也只是 warn，不阻断 build。
 */
function cleanupIosDSStore() {
  try {
    const iosDir = path.resolve(__dirname, '..', 'ios');
    if (!fs.existsSync(iosDir)) return;
    execSync(`find "${iosDir}" -name .DS_Store -type f -delete`, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    console.warn(`[ios] 清理 .DS_Store 失败（继续 build）：${e.message}`);
  }
}

/**
 * iOS 防御性清理 #2：如果 Podfile.lock 比上次 build 输出还新（说明 pod install 在
 * 上次 build 之后跑过），强制 nuke 整个 DerivedData。
 *
 * 缘起：增量加 native Fabric pod（如 BouncyGlassCard）后，CocoaPods 复用缓存的
 * React-Fabric prebuilt 库，但新 pod 的 codegen 引入了 vtable 引用 debug-only symbol
 * （getDebugName / getDebugProps / Sealable::ensureUnsealed 等），被缓存的 React-Fabric
 * 不暴露 → linker 报"Undefined symbols for architecture arm64"几十个，看不懂。
 * 手动 nuke DerivedData + Pods 重建一次就好。
 *
 * 判断逻辑：比较 Podfile.lock 的 mtime 跟 DerivedData 里 Build/Products 目录的 mtime——
 * 后者代表上次构建产物时间。lock 比它新 = pod install 之后没成功 build 过 = 应该 nuke。
 * 第一次 build（DerivedData 不存在）也不 nuke，让首次 build 正常跑。
 */
function maybeNukeDerivedDataAfterPodInstall() {
  const lockPath = path.resolve(__dirname, '..', 'ios', 'Podfile.lock');
  if (!fs.existsSync(lockPath)) return;

  const dd = path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
  if (!fs.existsSync(dd)) return;

  let flopsBuildDirs;
  try {
    flopsBuildDirs = fs.readdirSync(dd).filter((n) => n.startsWith('FlopsMobile-'));
  } catch {
    return;
  }
  if (flopsBuildDirs.length === 0) return; // 首次构建，没 DerivedData

  const lockMtime = fs.statSync(lockPath).mtimeMs;
  let latestBuildMtime = 0;
  for (const e of flopsBuildDirs) {
    const productsPath = path.join(dd, e, 'Build', 'Products');
    if (fs.existsSync(productsPath)) {
      const m = fs.statSync(productsPath).mtimeMs;
      if (m > latestBuildMtime) latestBuildMtime = m;
    }
  }

  if (latestBuildMtime === 0) return; // 有 DerivedData 但没 Build/Products，也算首次
  if (lockMtime <= latestBuildMtime) return; // lock 比构建产物老，没 pod install 过，跳过

  console.log(
    '[ios] Podfile.lock 比上次构建产物新（pod install 之后没成功 build 过），nuke DerivedData 防 Fabric 缓存 symbol 错乱…'
  );
  for (const e of flopsBuildDirs) {
    const p = path.join(dd, e);
    try {
      execSync(`rm -rf "${p}"`);
      console.log(`[ios]   deleted ${p}`);
    } catch (err) {
      console.warn(`[ios]   delete ${p} failed: ${err.message}`);
    }
  }
}

/**
 * iOS 防御性清理 #3：如果 React-Core-prebuilt 的 React.xcframework 模拟器 slice 是空的，
 * 自动跑 `pod install` 重新拉回来。
 *
 * 缘起：RNDeps 的 variant swap 脚本（Debug/Release 切换）在 build 中断 / 上次构建报错时
 * 会把 React.xcframework 切空（ios-arm64_x86_64-simulator/* 目录被清掉）但没复原。下次
 * build 直接报 `React.xcframework/ios-arm64_x86_64-simulator/*: No such file or directory`,
 * 看起来很吓人实则只需要 pod install 一下就好。
 *
 * 这个函数自动检测 + 自动修。检查 simulator slice 目录是否存在且非空；空就 pod install。
 */
function maybeRepairReactXcframework() {
  const sliceDir = path.resolve(
    __dirname,
    '..',
    'ios',
    'Pods',
    'React-Core-prebuilt',
    'React.xcframework',
    'ios-arm64_x86_64-simulator',
  );
  let needsRepair = false;
  if (!fs.existsSync(sliceDir)) {
    needsRepair = true;
  } else {
    try {
      const entries = fs.readdirSync(sliceDir);
      if (entries.length === 0) needsRepair = true;
    } catch {
      needsRepair = true;
    }
  }
  if (!needsRepair) return;

  console.log(
    '[ios] React.xcframework 模拟器 slice 为空（上次 build 被 RNDeps variant swap 切空了没复原），自动 pod install 修复…'
  );
  const iosDir = path.resolve(__dirname, '..', 'ios');
  try {
    execSync('pod install', { cwd: iosDir, stdio: 'inherit' });
    console.log('[ios] pod install 完成，React.xcframework 已恢复');
  } catch (err) {
    console.error(
      `[ios] pod install 失败：${err.message}\n` +
        '请手动 `cd ios && pod install` 后重试。'
    );
    process.exit(1);
  }
}

function waitForMetro() {
  const url = `http://127.0.0.1:${METRO_PORT}/`;
  const deadline = Date.now() + METRO_WAIT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const tryOnce = () => {
      fetch(url).then(() => resolve(true)).catch(() => {
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tryOnce, POLL_INTERVAL_MS);
      });
    };
    tryOnce();
  });
}

function run() {
  const env = { ...process.env };
  if (target === 'ios') {
    env.RCT_NO_LAUNCH_PACKAGER = '1';
  }

  const runTarget = target === 'android:real' ? 'android' : target;
  const args = ['react-native', `run-${runTarget}`];
  if (target === 'ios') {
    cleanupIosDSStore();
    maybeRepairReactXcframework();
    maybeNukeDerivedDataAfterPodInstall();
    args.push('--mode', 'Debug');
    const simulator = getIosSimulator();
    if (simulator) {
      args.push('--simulator', simulator);
    }
  }
  if (runTarget === 'android') {
    // build.gradle debug 使用 applicationIdSuffix ".dev"；CLI 不会自动合并，需与 Gradle 一致否则 am start 包名错误
    args.push('--no-packager', '--port', String(METRO_PORT), '--appIdSuffix', 'dev');
    if (target === 'android:real') {
      const deviceId = getFirstRealAndroidDevice();
      if (!deviceId) {
        console.error('\n[android:real] 未检测到真机。请连接设备并开启 USB 调试，或使用 yarn dev android 跑模拟器。');
        process.exit(1);
      }
      args.push('--device', deviceId);
      console.log(`[android:real] 使用真机: ${deviceId}`);
    }
  }

  const child = spawn('npx', args, {
    stdio: 'inherit',
    env,
    shell: true,
  });
  child.on('exit', (code, signal) => {
    process.exit(code !== null ? code : signal ? 1 : 0);
  });
}

(async () => {
  process.stdout.write(`[${target}] 等待 Metro 就绪 (${METRO_PORT})...`);
  const ready = await waitForMetro();
  if (!ready) {
    console.error(`\n[${target}] 超时：Metro 未在 ${METRO_WAIT_TIMEOUT_MS / 1000} 秒内响应，请确认 dev server 已启动。`);
    process.exit(1);
  }
  console.log(' 就绪');
  run();
})();
