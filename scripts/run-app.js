#!/usr/bin/env node
/**
 * Waits for Metro to be ready, then runs react-native run-ios or run-android.
 * Used by yarn dev so the app launches after the packager is up.
 * iOS: --simulator "Device Name"，优先用 argv[4]（命令行传入），否则读 rn-dev.config.json "ios.simulator"。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const target = process.argv[2] || 'ios'; // ios | ios:real | android | android:real
const METRO_PORT = parseInt(process.argv[3] || process.env.METRO_PORT || '8081', 10);
/** 可选：命令行传入的 iOS 模拟器名（argv[4]），覆盖 rn-dev.config.json 的 ios.simulator。 */
const SIMULATOR_OVERRIDE = (process.argv[4] || '').trim() || null;
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
 * 把模拟器名解析成唯一 UDID。
 * 为什么不直接用 RN CLI 的 `--simulator <name>`：当系统里有多台同名模拟器（如两台 "iPhone 16 Pro"）
 * 或已有别的模拟器处于 Booted 状态时，CLI 的按名匹配会挑到已 booted 的那台（哪怕名字不符），导致装错机。
 * 改成精确匹配名字 → 拿 UDID → 传 `--udid`，CLI 必装到这台。同名多台时优先已 Booted 的，其次第一台。
 * @returns {{udid:string, booted:boolean}|null}
 */
function resolveSimulatorUdid(name) {
  try {
    const json = execSync('xcrun simctl list devices available --json', {
      encoding: 'utf8',
    });
    const data = JSON.parse(json);
    const matches = [];
    for (const runtime of Object.keys(data.devices || {})) {
      for (const dev of data.devices[runtime] || []) {
        // isAvailable 已被 --json available 过滤，这里只按名字精确匹配（避免 "16 Pro" 命中 "16 Pro Max"）
        if (dev.name === name) {
          matches.push({ udid: dev.udid, booted: dev.state === 'Booted' });
        }
      }
    }
    if (matches.length === 0) return null;
    return matches.find((m) => m.booted) || matches[0];
  } catch (_) {
    return null;
  }
}

/**
 * 用 devicectl 拿每台设备的连接方式（USB 插线 vs WiFi）。
 * xctrace 不区分 transport，但 devicectl 的 JSON 有 connectionProperties.transportType
 * （'wired' = 插线、'localNetwork' = WiFi）。返回「插线设备 UDID 集合」，选设备时插线优先。
 * @returns {Set<string>} 插线设备的 UDID（大写）集合；拿不到则空集（退化为不区分）。
 */
function getWiredUdidSet() {
  const wired = new Set();
  try {
    /* --json-output - 直接输出到 stdout，避免写临时文件的竞态（之前用临时文件时，首次 devicectl
       冷启动文件可能还没落地就被读 → 拿到空集 → 插线优先失效）。execSync 同步拿全 stdout。 */
    const stdout = execSync('xcrun devicectl list devices --json-output -', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const data = JSON.parse(stdout);
    const devs = (data && data.result && data.result.devices) || [];
    for (const d of devs) {
      const tp = d.connectionProperties && d.connectionProperties.transportType;
      const udid = d.hardwareProperties && d.hardwareProperties.udid;
      if (tp === 'wired' && typeof udid === 'string') wired.add(udid.toUpperCase());
    }
  } catch (_) {
    /* devicectl 不可用 / 解析失败 → 空集，调用方退化为「不区分插线」的原有顺序 */
  }
  return wired;
}

/**
 * 找一台连接的 iOS 真机。用 `xcrun xctrace list devices` 解析候选；
 * 真机行格式 `Name (Version) (UDID)`（两组括号），Mac 行只有 `Name (UDID)`（一组括号），
 * 模拟器在 "== Simulators ==" 段，过滤掉。
 * 选择优先级：**先按 kind（类型）筛，再插线(wired) 优先于 WiFi，最后才看列出顺序**。
 * @param {'ipad'|'iphone'|null} kind 'ipad' 只挑 iPad、'iphone' 只挑 iPhone、
 *   null（默认 = `yarn dev ios real`）iPhone/iPad 都接受，但**优先 iPhone**，没 iPhone 才退回 iPad。
 * @returns {{ name: string, udid: string } | null}
 */
function getFirstRealIosDevice(kind = null) {
  try {
    const wiredSet = getWiredUdidSet();
    const out = execSync('xcrun xctrace list devices', { encoding: 'utf8' });
    const lines = out.split(/\r?\n/);
    let inDevicesSection = false;
    /* 收集全部匹配候选（带 isIpad/isIphone/wired 标记），最后统一按优先级挑。 */
    const candidates = [];
    for (const line of lines) {
      if (line.startsWith('== Devices ==')) {
        inDevicesSection = true;
        continue;
      }
      if (line.startsWith('== ')) {
        inDevicesSection = false;
        continue;
      }
      if (!inDevicesSection) continue;
      const m = line.match(/^(.+?) \([\d.]+\) \(([0-9A-Fa-f-]+)\)\s*$/);
      if (!m) continue;
      const name = m[1].trim();
      const udid = m[2];
      /* 白名单：name 必须含 iPhone 或 iPad（RN run-ios 不支持 Apple Watch / TV / Vision Pro）。 */
      const isIpad = /iPad/i.test(name);
      const isIphone = /iPhone/i.test(name);
      if (!isIphone && !isIpad) continue;
      if (kind === 'ipad' && !isIpad) continue;
      if (kind === 'iphone' && !isIphone) continue;
      candidates.push({ name, udid, isIpad, isIphone, wired: wiredSet.has(udid.toUpperCase()) });
    }
    if (candidates.length === 0) return null;
    /* 排序优先级：
       1. kind=null 时 iPhone 优先于 iPad（isIphone 在前）；kind 指定时此项无差别。
       2. 插线(wired) 优先于 WiFi。
       3. 其余保持 xctrace 列出顺序（稳定）。 */
    candidates.sort((a, b) => {
      if (kind == null && a.isIphone !== b.isIphone) return a.isIphone ? -1 : 1;
      if (a.wired !== b.wired) return a.wired ? -1 : 1;
      return 0;
    });
    const chosen = candidates[0];
    return { name: chosen.name, udid: chosen.udid };
  } catch (_) {
    /* xctrace 不可用或解析失败 → 返回 null，调用方报错给用户 */
  }
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
 * iOS 防御性清理 #3：如果 React-Core-prebuilt 的 React.xcframework 缺失或某个 slice 被切空，
 * 自动跑 `pod install` 重新拉回来。
 *
 * 缘起（两类残留，本函数都覆盖）：
 *  1. RNDeps 的 variant swap 脚本（Debug/Release 切换）在 build 中断 / 上次构建报错时会把某个
 *     slice 切空（如 `ios-arm64_x86_64-simulator/*` 目录被清掉）但没复原。
 *  2. 一次 Release/app-store 归档（yarn build ios testflight）后，整个 React.xcframework 可能被
 *     清掉只剩 `.last_build_configuration` 标记文件。之后跑模拟器没事（用不到 device slice），
 *     第一次跑真机才暴露缺 `ios-arm64`（device）slice。
 *  两种都表现为 build 报 `React.xcframework/<slice>/*: No such file or directory`,
 *  看起来很吓人实则只需要 pod install 一下就好。
 *
 * 检测策略：xcframework 根目录必须存在，且 device(ios-arm64) + simulator(ios-arm64_x86_64-simulator)
 * 两个关键 slice 都存在且非空。健康的 pod install 这两个 slice 一定都在，所以缺任一即判定要修。
 * （maccatalyst slice 不参与判定——我们不构建 Catalyst。）
 */
function maybeRepairReactXcframework() {
  const xcframeworkDir = path.resolve(
    __dirname,
    '..',
    'ios',
    'Pods',
    'React-Core-prebuilt',
    'React.xcframework',
  );
  /** 非空目录检查：目录存在且至少有一个条目。缺失 / 读不了 / 空都算「坏」。 */
  const isNonEmptyDir = (dir) => {
    try {
      return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
    } catch {
      return false;
    }
  };

  /** 必须健在的 slice：device + simulator。任一缺失/空 → 需要修。 */
  const requiredSlices = ['ios-arm64', 'ios-arm64_x86_64-simulator'];
  let reason = null;
  if (!fs.existsSync(xcframeworkDir)) {
    reason = 'React.xcframework 整个目录缺失（多见于上次 Release/TestFlight 归档后）';
  } else {
    const missing = requiredSlices.filter(
      (slice) => !isNonEmptyDir(path.join(xcframeworkDir, slice))
    );
    if (missing.length > 0) {
      reason = `React.xcframework slice 缺失/为空：${missing.join(', ')}（上次 build 被 RNDeps variant swap 切空了没复原）`;
    }
  }
  if (!reason) return;

  console.log(`[ios] ${reason}，自动 pod install 修复…`);
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
  if (target === 'ios' || target === 'ios:real') {
    env.RCT_NO_LAUNCH_PACKAGER = '1';
  }

  const runTarget =
    target === 'android:real' ? 'android' : target === 'ios:real' ? 'ios' : target;
  const args = ['react-native', `run-${runTarget}`];
  if (target === 'ios' || target === 'ios:real') {
    cleanupIosDSStore();
    maybeRepairReactXcframework();
    maybeNukeDerivedDataAfterPodInstall();
    args.push('--mode', 'Debug');
    /* 关键：把 Metro 端口传给 iOS build。run-ios --port N 会把 RCT_METRO_PORT=N 注入 app build，
       让装上去的 app 连这个端口的 Metro（而不是写死 8081）。不传的话多个 yarn dev 的 iOS app
       都去连 8081 → 串台 / Fast Refresh 连错 Metro。--no-packager：我们用外层 concurrently 起的
       Metro，不让 run-ios 自己再起一个（避免重复 Metro / 抢端口）。 */
    args.push('--port', String(METRO_PORT), '--no-packager');
    if (target === 'ios:real') {
      /** 设备类型过滤（yarn dev ipad / iphone）。dev.js 通过环境变量传入。 */
      const deviceKind = (process.env.FLOPS_IOS_DEVICE_KIND || '').toLowerCase() || null;
      const device = getFirstRealIosDevice(deviceKind);
      if (!device) {
        const kindLabel = deviceKind === 'ipad' ? ' iPad' : deviceKind === 'iphone' ? ' iPhone' : '';
        console.error(
          `\n[ios:real] 未检测到已连接的${kindLabel || ' iOS'}真机。请确认：\n` +
            `  1)${kindLabel || ' iPhone/iPad'} 通过 USB 连上 Mac，且已在设备上「信任此电脑」\n` +
            '  2) Xcode 里已设过 development team / signing\n' +
            '  3) `xcrun xctrace list devices` 能列出该设备\n' +
            '或者用 yarn dev ios 跑模拟器。'
        );
        process.exit(1);
      }
      args.push('--udid', device.udid);
      console.log(`[ios:real] 使用真机: ${device.name} (${device.udid})`);
    } else {
      const simulator = SIMULATOR_OVERRIDE || getIosSimulator();
      if (simulator) {
        const src = SIMULATOR_OVERRIDE ? '命令行' : 'rn-dev.config.json';
        const resolved = resolveSimulatorUdid(simulator);
        if (resolved) {
          // 用 UDID 而非名字：避免同名多台 / 已 booted 别的机时 CLI 装错机
          args.push('--udid', resolved.udid);
          console.log(
            `[ios] 使用模拟器(${src}): ${simulator} → ${resolved.udid}${
              resolved.booted ? ' (已 Booted)' : ''
            }`
          );
        } else {
          // 没在可用模拟器里精确匹配到名字：退回按名传给 CLI，并提示
          console.warn(
            `[ios] 未找到名为 "${simulator}" 的可用模拟器（来源：${src}）。\n` +
              '       退回 --simulator 按名匹配（可能装到已 booted 的其它机）。\n' +
              '       可用 `xcrun simctl list devices available` 查看确切名字。'
          );
          args.push('--simulator', simulator);
        }
      }
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
