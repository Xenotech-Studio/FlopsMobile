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

/* ── 设备占用锁（让多个 yarn dev 自动避让，各占一台真机）──
 * 一台真机同一时刻只能被一个 dev 用。系统层面没有「设备被占用」标志，所以自己用 lockfile 记：
 * 选中设备后在锁目录写 <udid>.lock（内含本进程 pid）；下一个 dev 选机时跳过「锁存在且 pid 还活着」
 * 的设备。dev 退出删锁；pid 已死的陈旧锁视为无效（自愈，不会永久占着）。 */
const DEVICE_LOCK_DIR = path.join(os.tmpdir(), 'flops-dev-device-locks');

function lockPathFor(udid) {
  return path.join(DEVICE_LOCK_DIR, `${udid.toUpperCase()}.lock`);
}

/** 某 pid 是否还活着（kill 0 探测，不真发信号）。 */
function pidAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // EPERM = 存在但无权限（仍算活着）；ESRCH = 不存在
  }
}

/** 锁主 pid = dev 会话 pid（dev.js 经 env 传入）；拿不到则退回本进程 pid（兜底）。 */
function lockOwnerPid() {
  const sid = parseInt(process.env.FLOPS_DEV_SESSION_PID || '', 10);
  return Number.isNaN(sid) ? process.pid : sid;
}

/** 该 udid 是否被「别的活着的 dev 会话」占用。陈旧锁（owner pid 死）顺手删掉。 */
function isDeviceLockedByOther(udid) {
  const lp = lockPathFor(udid);
  let raw;
  try {
    raw = fs.readFileSync(lp, 'utf8');
  } catch (_) {
    return false; // 没锁文件 = 空闲
  }
  const pid = parseInt(String(raw).trim(), 10);
  if (pid === lockOwnerPid()) return false; // 自己会话的锁
  if (pidAlive(pid)) return true; // 别的活会话占着
  /* 陈旧锁（owner 会话已死）→ 清掉，视为空闲 */
  try { fs.unlinkSync(lp); } catch (_) {}
  return false;
}

/** 抢占某设备：写锁，owner = dev 会话 pid。
 * 不在 run-app 退出时删锁——run-app 是短命的（装完就退），锁要活到整个 dev 会话结束。
 * 释放靠 isDeviceLockedByOther 的陈旧检测：dev 会话 pid 死了，下个 dev 选机时自动清掉。 */
function acquireDeviceLock(udid) {
  try {
    fs.mkdirSync(DEVICE_LOCK_DIR, { recursive: true });
    fs.writeFileSync(lockPathFor(udid), String(lockOwnerPid()));
  } catch (_) {
    /* 锁写失败不致命：退化为不避让 */
  }
}

/* ── build 串行锁（同一时刻只允许一个 xcodebuild）──
 * 多个 yarn dev 同时 build 会撞同一个 DerivedData 的 build.db（SQLite，单写）→
 * "database is locked ... two concurrent builds" → exit 65。
 * 用一个全局锁文件串行化：要 build 先抢锁，抢不到就等前一个 build 完，避免并发撞 db。
 * 锁内写「本 run-app 的 pid + 时间戳」；陈旧锁（持有进程已死 / 超时）自动接管，防死锁。 */
const BUILD_LOCK_FILE = path.join(os.tmpdir(), 'flops-dev-xcodebuild.lock');
const BUILD_LOCK_STALE_MS = 20 * 60 * 1000; // 20 分钟没释放视为陈旧（全量 build 也够了）

function readBuildLock() {
  try {
    const raw = fs.readFileSync(BUILD_LOCK_FILE, 'utf8');
    const [pidStr, tsStr] = String(raw).trim().split(/\s+/);
    return { pid: parseInt(pidStr, 10), ts: parseInt(tsStr, 10) || 0 };
  } catch (_) {
    return null;
  }
}

/** 尝试原子抢锁：成功返回 true。用 'wx'（O_EXCL）保证只有一个进程能创建成功。 */
function tryAcquireBuildLock() {
  try {
    const fd = fs.openSync(BUILD_LOCK_FILE, 'wx'); // wx = 文件已存在则抛错
    fs.writeSync(fd, `${process.pid} ${Date.now()}`);
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') return false;
    /* 锁已存在：检查是否陈旧（持有进程死了 / 超时）→ 接管 */
    const cur = readBuildLock();
    const stale =
      !cur || !pidAlive(cur.pid) || Date.now() - cur.ts > BUILD_LOCK_STALE_MS;
    if (stale) {
      try {
        fs.writeFileSync(BUILD_LOCK_FILE, `${process.pid} ${Date.now()}`);
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }
}

function releaseBuildLock() {
  try {
    const cur = readBuildLock();
    if (cur && cur.pid === process.pid) fs.unlinkSync(BUILD_LOCK_FILE);
  } catch (_) {}
}

/** 等到能 build 为止（串行）。第一次等待时打印提示。 */
async function waitForBuildLock() {
  let waited = false;
  while (!tryAcquireBuildLock()) {
    if (!waited) {
      waited = true;
      const cur = readBuildLock();
      console.log(
        `[build] 另一个 build 正在进行${cur ? `（pid ${cur.pid}）` : ''}，等它完成再开始（避免 build.db 锁冲突）…`
      );
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  /* 进程异常退出也要释放锁，否则别的 dev 会一直等到陈旧超时 */
  process.on('exit', releaseBuildLock);
  process.on('SIGINT', () => { releaseBuildLock(); process.exit(130); });
  process.on('SIGTERM', () => { releaseBuildLock(); process.exit(143); });
  process.on('SIGHUP', () => { releaseBuildLock(); process.exit(129); });
}

/**
 * 找一台连接的 iOS 真机。用 `xcrun xctrace list devices` 解析候选；
 * 真机行格式 `Name (Version) (UDID)`（两组括号），Mac 行只有 `Name (UDID)`（一组括号），
 * 模拟器在 "== Simulators ==" 段，过滤掉。
 * 选择优先级：**先按 kind（类型）+ nameFilter（名字子串）筛，再插线(wired) 优先于 WiFi，最后才看列出顺序**。
 * @param {'ipad'|'iphone'|null} kind 'ipad' 只挑 iPad、'iphone' 只挑 iPhone、
 *   null（默认 = `yarn dev ios real`）iPhone/iPad 都接受，但**优先 iPhone**，没 iPhone 才退回 iPad。
 * @param {string|null} nameFilter 设备名子串（大小写无关）。非空时只保留名字含它的设备
 *   —— 用来区分同类型多台真机（如两台 iPhone 用 "Steven" / "Haowen" 各选一台）。
 * @returns {{ name: string, udid: string } | null}
 */
function getFirstRealIosDevice(kind = null, nameFilter = null) {
  try {
    const wiredSet = getWiredUdidSet();
    const out = execSync('xcrun xctrace list devices', { encoding: 'utf8' });
    const lines = out.split(/\r?\n/);
    const nf = nameFilter ? nameFilter.toLowerCase() : null;
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
      if (nf && !name.toLowerCase().includes(nf)) continue;
      candidates.push({
        name,
        udid,
        isIpad,
        isIphone,
        wired: wiredSet.has(udid.toUpperCase()),
        locked: isDeviceLockedByOther(udid), // 已被别的 dev 占用
      });
    }
    if (candidates.length === 0) return null;
    /* 排序优先级：
       1. 未被占用(locked=false) 优先 —— 多个 dev 自动避让，各占一台。
       2. kind=null 时 iPhone 优先于 iPad（isIphone 在前）；kind 指定时此项无差别。
       3. 插线(wired) 优先于 WiFi。
       4. 其余保持 xctrace 列出顺序（稳定）。
       注：全被占用时仍返回第一台（不硬阻塞——比如只有一台设备、反复 dev 同一台是合理的）。 */
    candidates.sort((a, b) => {
      if (a.locked !== b.locked) return a.locked ? 1 : -1;
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
 * 按设备类型（iPad/iPhone）在「可用模拟器」里挑一台。`yarn dev ipad`（默认 / real 没真机回退）用。
 * 选择优先级：已 Booted（省一次冷启动）> iOS runtime 版本更新 > 列出顺序。
 * @param {'ipad'|'iphone'} kind 设备类型。
 * @param {string|null} nameFilter 模拟器名子串（大小写无关），非空时只保留名字含它的。
 * @returns {{ udid: string, name: string, booted: boolean } | null}
 */
function getFirstSimulatorOfKind(kind, nameFilter = null) {
  try {
    const json = execSync('xcrun simctl list devices available --json', {
      encoding: 'utf8',
    });
    const data = JSON.parse(json);
    const nf = nameFilter ? nameFilter.toLowerCase() : null;
    const re = kind === 'ipad' ? /iPad/i : /iPhone/i;
    const candidates = [];
    for (const runtime of Object.keys(data.devices || {})) {
      /* 只看 iOS runtime（排除 watchOS/tvOS/visionOS）；顺带解析版本号用于排序。 */
      const m = runtime.match(/iOS-(\d+)-(\d+)/i);
      if (!m) continue;
      const rv = parseInt(m[1], 10) * 1000 + parseInt(m[2], 10);
      for (const dev of data.devices[runtime] || []) {
        if (!re.test(dev.name)) continue;
        if (nf && !dev.name.toLowerCase().includes(nf)) continue;
        candidates.push({
          udid: dev.udid,
          name: dev.name,
          booted: dev.state === 'Booted',
          rv,
        });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      if (a.booted !== b.booted) return a.booted ? -1 : 1;
      if (a.rv !== b.rv) return b.rv - a.rv;
      return 0;
    });
    const c = candidates[0];
    return { udid: c.udid, name: c.name, booted: c.booted };
  } catch (_) {
    return null;
  }
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
    /* Metro 端口经下面 run-ios 的 --extra-params FLOPS_METRO_PORT=N（xcodebuild build setting）注入，
       Info.plist $(FLOPS_METRO_PORT) 展开 → AppDelegate 运行时设 RCT_jsLocation。详见 args 处注释。 */
  }

  const runTarget =
    target === 'android:real' ? 'android' : target === 'ios:real' ? 'ios' : target;
  const args = ['react-native', `run-${runTarget}`];
  if (target === 'ios' || target === 'ios:real') {
    cleanupIosDSStore();
    maybeRepairReactXcframework();
    maybeNukeDerivedDataAfterPodInstall();
    args.push('--mode', 'Debug');
    /* --no-packager：我们用外层 concurrently 起的 Metro，不让 run-ios 自己再起一个。
       --port：用于 run-ios 的 launch 阶段；真正决定 app 连哪个端口的是下面的 FLOPS_METRO_PORT。
       --extra-params FLOPS_METRO_PORT=N：作为 xcodebuild build setting 覆盖传入，Info.plist 的
       $(FLOPS_METRO_PORT) 展开成本端口，AppDelegate(DEBUG) 据此设 RCT_jsLocation=localhost:N，
       让 app 连自己那个 Metro。这是 prebuilt React-Core 下唯一可行的「每实例独立端口」机制
       （RCT_METRO_PORT C 宏写死在 prebuilt 里，env/--port 都改不动）。 */
    args.push('--port', String(METRO_PORT), '--no-packager');
    args.push('--extra-params', `FLOPS_METRO_PORT=${METRO_PORT}`);
    if (target === 'ios:real') {
      /** 设备类型过滤（yarn dev ipad real → 'ipad'；纯 ios real → null=iPhone 优先）。dev.js 经环境变量传入。 */
      const deviceKind = (process.env.FLOPS_IOS_DEVICE_KIND || '').toLowerCase() || null;
      /** 真机名过滤：real 模式下命令行的引号参数当「设备名子串」用，区分同类型多台真机
       *  （如两台 iPhone：yarn dev ios real "Steven" / yarn dev ios real "Haowen"）。 */
      const nameFilter = SIMULATOR_OVERRIDE;
      const device = getFirstRealIosDevice(deviceKind, nameFilter);
      const kindLabel = deviceKind === 'ipad' ? ' iPad' : deviceKind === 'iphone' ? ' iPhone' : '';
      const nameLabel = nameFilter ? `（名字含 "${nameFilter}"）` : '';
      if (device) {
        acquireDeviceLock(device.udid); // 占用本机，让后续 dev 自动避让到下一台
        args.push('--udid', device.udid);
        console.log(`[ios:real] 使用真机: ${device.name} (${device.udid})`);
      } else if (deviceKind) {
        /* yarn dev ipad real：没连真机 → 回退到 iPad 模拟器（纯 ios real 才严格只用真机）。 */
        const sim = getFirstSimulatorOfKind(deviceKind, nameFilter);
        if (!sim) {
          console.error(
            `\n[ios:real] 既没连${kindLabel}真机${nameLabel}，也没找到可用的${kindLabel}模拟器。请确认：\n` +
              `  1) 接上${kindLabel}真机（USB + 设备上「信任此电脑」+ Xcode signing），或\n` +
              `  2) 在 Xcode / \`xcrun simctl list devices available\` 里有一台${kindLabel}模拟器\n` +
              (nameFilter ? `  3) 名字确实含 "${nameFilter}"（大小写无关）\n` : '')
          );
          process.exit(1);
        }
        args.push('--udid', sim.udid);
        console.log(
          `[ios:real] 未连接${kindLabel}真机${nameLabel}，回退模拟器: ${sim.name} (${sim.udid})${
            sim.booted ? ' (已 Booted)' : ''
          }`
        );
      } else {
        /* 纯 `yarn dev ios real`（无类型别名）：保持严格——只用真机，不回退模拟器。 */
        console.error(
          `\n[ios:real] 未检测到已连接的 iOS 真机${nameLabel}。请确认：\n` +
            '  1) iPhone/iPad 通过 USB 连上 Mac，且已在设备上「信任此电脑」\n' +
            '  2) Xcode 里已设过 development team / signing\n' +
            '  3) `xcrun xctrace list devices` 能列出该设备\n' +
            (nameFilter ? `  4) 名字确实含 "${nameFilter}"（区分大小写无关）\n` : '') +
            '或者用 yarn dev ios 跑模拟器、yarn dev ipad 跑 iPad（默认模拟器、real 才用真机）。'
        );
        process.exit(1);
      }
    } else if ((process.env.FLOPS_IOS_DEVICE_KIND || '').toLowerCase()) {
      /* yarn dev ipad（不带 real）：按设备类型挑一台模拟器，不优先真机。
       *  引号位置参数当「模拟器名子串」过滤（如 yarn dev ipad "Pro"）。 */
      const deviceKind = process.env.FLOPS_IOS_DEVICE_KIND.toLowerCase();
      const kindLabel = deviceKind === 'ipad' ? 'iPad' : 'iPhone';
      const nameFilter = SIMULATOR_OVERRIDE;
      const nameLabel = nameFilter ? `（名字含 "${nameFilter}"）` : '';
      const sim = getFirstSimulatorOfKind(deviceKind, nameFilter);
      if (!sim) {
        console.error(
          `\n[ios] 没找到可用的 ${kindLabel} 模拟器${nameLabel}。请确认：\n` +
            `  1) Xcode / \`xcrun simctl list devices available\` 里有一台 ${kindLabel} 模拟器\n` +
            (nameFilter ? `  2) 名字确实含 "${nameFilter}"（大小写无关）\n` : '') +
            `或用 \`yarn dev ${deviceKind} real\` 跑真机。`
        );
        process.exit(1);
      }
      args.push('--udid', sim.udid);
      console.log(
        `[ios] 使用 ${kindLabel} 模拟器: ${sim.name} (${sim.udid})${
          sim.booted ? ' (已 Booted)' : ''
        }`
      );
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

  /* iOS：build 前抢全局 build 锁（串行化 xcodebuild，避免多 dev 撞 build.db）。
     Android 不需要（Gradle 自己有 build 锁、且各 dev 可并行）。 */
  const needsBuildLock = target === 'ios' || target === 'ios:real';
  const spawnBuild = () => {
    const child = spawn('npx', args, {
      stdio: 'inherit',
      env,
      shell: true,
    });
    child.on('exit', (code, signal) => {
      if (needsBuildLock) releaseBuildLock(); // build/install/launch 完成，放锁让下一个 dev build
      process.exit(code !== null ? code : signal ? 1 : 0);
    });
  };

  if (needsBuildLock) {
    waitForBuildLock().then(spawnBuild);
  } else {
    spawnBuild();
  }
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
