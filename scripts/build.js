#!/usr/bin/env node
/**
 * Unified build entry:
 * - yarn build                       -> android apk
 * - yarn build android               -> android apk
 * - yarn build android apk           -> android apk
 * - yarn build android aab           -> android aab
 * - yarn build android upload        -> android apk + 上传 Flops 后端
 * - yarn build android testinstall   -> assembleReleaseDev (com.flopsmobile.dev) + adb 装到所有连接设备
 * - yarn build android testinstall real -> 同上，但过滤掉 emulator，只装到实机
 * - yarn build ios                   -> ios ipa (development export，sideload 自用)
 * - yarn build ios ipa               -> 同上
 * - yarn build ios testflight        -> ios ipa (app-store export) + 上传 App Store Connect → TestFlight
 *
 * iOS testflight 模式说明：
 * - 强制 exportMethod=app-store（覆盖 FLOPS_IOS_EXPORT_METHOD）
 * - marketing version（MARKETING_VERSION）默认取自 package.json 的 version；
 *   可用环境变量 FLOPS_IOS_MARKETING_VERSION 覆盖（必须符合 CFBundleShortVersionString 格式：
 *   只能是非空的「数字 + 小数点」，例如 0.0.11）；传给 Xcode 后 ASC/TestFlight 里的版本号与该字段对齐。
 * - 自动注入 build number = UTC 时间戳 (YYYYMMDDHHMM, 12 位数字)，
 *   保证同一 marketing version 下每次 build 都唯一（Apple 强制约束）
 * - archive/export 完成后调用 build-and-upload-ios.js，凭据来自 ios-upload-config.json
 *
 * Also accepts common typos for android:
 * - anrdoid / anrdoi
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function expandHome(inputPath) {
  if (!inputPath) return inputPath;
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function fail(message) {
  console.error(`[build] ${message}`);
  process.exit(1);
}

function readPasswords(pswPath) {
  const raw = fs.readFileSync(pswPath, 'utf8');
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  if (lines.length === 0) {
    fail(`密码文件为空：${pswPath}`);
  }

  const storePassword = lines[0];
  const keyPassword = lines[1] || lines[0];
  return { storePassword, keyPassword };
}

function normalizePlatform(token) {
  if (!token) return null;
  const v = token.toLowerCase();
  if (v === 'android' || v === 'anrdoid' || v === 'anrdoi') return 'android';
  if (v === 'ios') return 'ios';
  return null;
}

function normalizeArtifact(token) {
  if (!token) return null;
  const v = token.toLowerCase();
  if (v === 'apk') return 'apk';
  if (v === 'aab') return 'aab';
  if (v === 'ipa') return 'ipa';
  return null;
}

function parseArgs(argv) {
  // Defaults: android + apk. 末尾可加：
  // - upload                -> android 上传 Flops 后端
  // - testflight            -> iOS 上传 App Store Connect (TestFlight)
  // - testinstall [real]    -> android assembleReleaseDev + adb install 到所有/仅实机
  let platform = 'android';
  let artifact = 'apk';
  let doUpload = false;
  let target = null;
  let testinstallReal = false;
  let index = 0;

  // testinstall 可能带 real 修饰：argv = [...prefix, 'testinstall', 'real']
  if (argv[argv.length - 1] === 'real' && argv[argv.length - 2] === 'testinstall') {
    target = 'testinstall';
    testinstallReal = true;
    argv = argv.slice(0, -2);
  } else if (argv[argv.length - 1] === 'testinstall') {
    target = 'testinstall';
    argv = argv.slice(0, -1);
  } else {
    const last = argv[argv.length - 1];
    if (last === 'upload') {
      doUpload = true;
      argv = argv.slice(0, -1);
    } else if (last === 'testflight') {
      target = 'testflight';
      argv = argv.slice(0, -1);
    }
  }

  const maybePlatform = normalizePlatform(argv[0]);
  const maybeArtifact = normalizeArtifact(argv[0]);

  if (maybePlatform) {
    platform = maybePlatform;
    index = 1;
  } else if (maybeArtifact) {
    artifact = maybeArtifact;
    index = 1;
  }

  const maybeSecondArtifact = normalizeArtifact(argv[index]);
  if (maybeSecondArtifact) {
    artifact = maybeSecondArtifact;
    index += 1;
  }

  if (argv[index]) {
    fail(`无法识别的参数：${argv[index]}。用法：yarn build [android|ios] [apk|aab|ipa] [upload|testflight]`);
  }

  // testflight 暗示 iOS（即使没写 ios 也兜底到 ios）
  if (target === 'testflight' && platform === 'android' && !maybePlatform) {
    platform = 'ios';
    artifact = 'ipa';
  }

  if (platform === 'ios' && artifact === 'apk') {
    artifact = 'ipa';
  }

  if (platform === 'ios' && artifact !== 'ipa') {
    fail('iOS 目前仅支持 ipa。用法：yarn build ios [ipa] [testflight]');
  }

  if (doUpload && platform !== 'android') {
    fail('upload 仅支持 yarn build android [apk] upload。iOS 上传请用 yarn build ios testflight');
  }

  if (target === 'testflight' && platform !== 'ios') {
    fail('testflight 仅支持 yarn build ios testflight');
  }

  if (target === 'testinstall' && platform !== 'android') {
    fail('testinstall 仅支持 yarn build android testinstall [real]');
  }

  return { platform, artifact, doUpload, target, testinstallReal };
}

function runAndroidBuild(artifact) {
  const task = artifact === 'aab' ? 'bundleRelease' : 'assembleRelease';
  const keystorePath = path.resolve(
    expandHome(process.env.FLOPS_KEYSTORE_PATH || '~/.keystores/flow.keystore')
  );
  const pswPath = path.resolve(
    expandHome(process.env.FLOPS_PSW_PATH || '~/.keystores/flow.psw')
  );
  const keyAlias = process.env.FLOPS_KEY_ALIAS || 'flops';

  if (!fs.existsSync(keystorePath)) {
    fail(`未找到 keystore：${keystorePath}`);
  }
  if (!fs.existsSync(pswPath)) {
    fail(`未找到密码文件：${pswPath}`);
  }

  const { storePassword, keyPassword } = readPasswords(pswPath);
  const androidDir = path.resolve(__dirname, '..', 'android');
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';

  console.log(`[build] platform=android`);
  console.log(`[build] artifact=${artifact}`);
  console.log(`[build] task=${task}`);
  console.log(`[build] keystore=${keystorePath}`);
  console.log(`[build] alias=${keyAlias}`);

  const gradleArgs = [
    task,
    `-Pandroid.injected.signing.store.file=${keystorePath}`,
    `-Pandroid.injected.signing.store.password=${storePassword}`,
    `-Pandroid.injected.signing.key.alias=${keyAlias}`,
    `-Pandroid.injected.signing.key.password=${keyPassword}`,
  ];

  const result = spawnSync(gradlew, gradleArgs, {
    cwd: androidDir,
    stdio: 'inherit',
    shell: true,
  });

  if (typeof result.status === 'number') {
    if (result.status !== 0) {
      process.exit(result.status);
    }
    const projectRoot = path.resolve(__dirname, '..');
    const outputDir =
      artifact === 'aab'
        ? path.join(androidDir, 'app', 'build', 'outputs', 'bundle', 'release')
        : path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release');
    const ext = artifact === 'aab' ? '.aab' : '.apk';
    const built = findLatestFileByExt(outputDir, ext);
    if (!built) {
      fail(`构建成功但未找到产物：${outputDir} (${ext})`);
    }
    const version = getPackageVersion(projectRoot);
    const targetName = `FlopsMobile-${version}${ext}`;
    const copied = copyArtifactToBuildRoot(projectRoot, built, targetName);
    console.log(`[build] artifact=${built}`);
    console.log(`[build] 已复制到: ${copied}`);
    return copied;
  }
  process.exit(1);
}

/**
 * 编译 assembleReleaseDev → APK 装到所有连接的 adb 设备（real=true 时过滤掉 emulator）。
 * - applicationId = com.flopsmobile.dev（跟 `yarn dev android` 同名，不会覆盖商店版 com.flopsmobile）
 * - 走 release 优化（minify + JS bundled）所以能脱机跑（不依赖 Metro）
 * - debug signing（debug.keystore），不需要正式签名密码
 */
function runAndroidTestInstall(realOnly) {
  const androidDir = path.resolve(__dirname, '..', 'android');
  const projectRoot = path.resolve(__dirname, '..');
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';

  console.log(`[build] platform=android`);
  console.log(`[build] task=assembleReleaseDev (applicationId=com.flopsmobile.dev)`);
  console.log(`[build] testinstall realOnly=${realOnly}`);

  // releaseDev 用 debug.keystore（gradle 里已经配好 signingConfig signingConfigs.debug），
  // 不需要 -Pandroid.injected.signing.* 系列参数。
  const result = spawnSync(gradlew, ['assembleReleaseDev'], {
    cwd: androidDir,
    stdio: 'inherit',
    shell: true,
  });
  if (typeof result.status !== 'number' || result.status !== 0) {
    fail('gradle assembleReleaseDev 失败');
  }

  const outputDir = path.join(
    androidDir,
    'app',
    'build',
    'outputs',
    'apk',
    'releaseDev'
  );
  const apk = findLatestFileByExt(outputDir, '.apk');
  if (!apk) {
    fail(`构建成功但未找到 APK 产物：${outputDir}`);
  }
  const version = getPackageVersion(projectRoot);
  const targetName = `FlopsMobile-${version}-testinstall.apk`;
  const copied = copyArtifactToBuildRoot(projectRoot, apk, targetName);
  console.log(`[build] APK: ${apk}`);
  console.log(`[build] 已复制到: ${copied}`);

  // 找设备
  const adbList = spawnSync('adb', ['devices', '-l'], { encoding: 'utf8' });
  if (adbList.status !== 0) {
    fail(`adb devices 失败：${adbList.stderr || adbList.stdout}`);
  }
  /* `adb devices -l` 输出形如：
   *   List of devices attached
   *   emulator-5554   device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 ...
   *   2B141FDH200xxx  device usb:1-3 product:NX669J model:Nubia_Z40_Pro device:...
   *   192.168.1.50:5555  device  product:... (无线连接的实机也会带 ":")
   * 实机判定：device id 不以 "emulator-" 开头。无线设备 (ip:port) 算实机。 */
  const lines = adbList.stdout.split('\n').slice(1);
  const devices = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, status] = trimmed.split(/\s+/);
    if (!id || status !== 'device') continue;
    const isEmulator = id.startsWith('emulator-');
    if (realOnly && isEmulator) continue;
    devices.push({ id, isEmulator });
  }

  if (devices.length === 0) {
    fail(
      realOnly
        ? '没找到任何 adb 实机（emulator 已被 real 过滤掉）'
        : '没找到任何 adb 设备。检查 `adb devices` 输出。'
    );
  }

  console.log(`[build] 目标设备 ${devices.length} 台：${devices.map((d) => d.id).join(', ')}`);
  let failed = 0;
  for (const dev of devices) {
    console.log(`[build] adb -s ${dev.id} install -r ${copied}`);
    const installRes = spawnSync('adb', ['-s', dev.id, 'install', '-r', copied], {
      stdio: 'inherit',
    });
    if (installRes.status !== 0) {
      console.error(`[build] 设备 ${dev.id} 安装失败 (code ${installRes.status})`);
      failed += 1;
    }
  }
  if (failed > 0) {
    fail(`${failed}/${devices.length} 台设备安装失败`);
  }
  console.log(`[build] testinstall 完成：${devices.length} 台设备安装成功`);
  return copied;
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: true,
  });
  if (typeof result.status === 'number') {
    return result.status;
  }
  return 1;
}

function collectFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function findLatestFileByExt(dir, ext) {
  const files = collectFilesRecursive(dir).filter((f) => f.toLowerCase().endsWith(ext));
  if (files.length === 0) return null;
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

function getPackageVersion(projectRoot) {
  const pkgPath = path.join(projectRoot, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return (pkg.version || '0.0.0').trim();
  } catch (_) {
    return '0.0.0';
  }
}

/**
 * CFBundleShortVersionString（MARKETING_VERSION）在 App Store Connect / TestFlight 上展示的版本（括号前的数字）。
 * Apple 要求由整数与小数点组成，例如「1.0」「0.0.11」；不支持 semver 后缀（如 1.0.0-rc）。
 */
function sanitizeIosMarketingVersion(rawVersion, fallbackHint) {
  const v = (rawVersion || '').trim();
  if (!v || !/^\d+(\.\d+)*$/.test(v)) {
    fail(
      `无效的 iOS marketing version「${v || '(empty)'}」${fallbackHint}\n` +
        `须为非空的「整数与小数点」组合（示例：0.0.11）。请修正 package.json 的 version\n` +
        `或设置环境变量 FLOPS_IOS_MARKETING_VERSION。`
    );
  }
  return v;
}

function copyArtifactToBuildRoot(projectRoot, sourcePath, targetBasename) {
  const buildRoot = path.join(projectRoot, 'build');
  fs.mkdirSync(buildRoot, { recursive: true });
  const name = targetBasename || path.basename(sourcePath);
  const targetPath = path.join(buildRoot, name);
  fs.copyFileSync(sourcePath, targetPath);
  return targetPath;
}

function writeIosExportOptionsPlist(plistPath, method) {
  const content =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n` +
    `<dict>\n` +
    `  <key>method</key>\n` +
    `  <string>${method}</string>\n` +
    `  <key>signingStyle</key>\n` +
    `  <string>automatic</string>\n` +
    `  <key>stripSwiftSymbols</key>\n` +
    `  <true/>\n` +
    `  <key>compileBitcode</key>\n` +
    `  <false/>\n` +
    `</dict>\n` +
    `</plist>\n`;
  fs.writeFileSync(plistPath, content, 'utf8');
}

function computeBuildNumberUTC() {
  // CFBundleVersion 必须在同 CFBundleShortVersionString 下唯一。
  // UTC YYYYMMDDHHMM (12 位数字) 永远递增，永远不撞，且短于 Apple 18 位上限。
  const now = new Date();
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
  ].join('');
}

function runIosBuild(artifact, target) {
  if (process.platform !== 'darwin') {
    fail('iOS 打包仅支持在 macOS 执行。');
  }
  if (artifact !== 'ipa') {
    fail('iOS 目前仅支持 ipa。');
  }

  const projectRoot = path.resolve(__dirname, '..');
  const iosDir = path.join(projectRoot, 'ios');

  /* RN 0.84 prebuilt RNDeps 的 variant swap 脚本用 rmdir 清空中间目录，任何残留的
     .DS_Store（Finder 偷塞 / 别工具留下）会让"空目录"实际不空，xcodebuild 翻 ENOTEMPTY
     直接挂掉。详见 run-app.js 同名函数。每次 build 前扫一遍 ios/ 下的 .DS_Store。 */
  try {
    spawnSync('find', [iosDir, '-name', '.DS_Store', '-type', 'f', '-delete'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (_) {
    // 失败也只是 warn 不阻断
  }

  /* 如果 React.xcframework 模拟器 slice 是空的（上次 build 被 RNDeps variant swap 切空了
     没复原），自动 pod install 修复——否则 build 报 `React.xcframework/...: No such file
     or directory` 直接挂。详见 run-app.js 同名函数。 */
  try {
    const sliceDir = path.join(
      iosDir,
      'Pods',
      'React-Core-prebuilt',
      'React.xcframework',
      'ios-arm64_x86_64-simulator',
    );
    let needsRepair = false;
    if (!fs.existsSync(sliceDir)) {
      needsRepair = true;
    } else {
      const entries = fs.readdirSync(sliceDir);
      if (entries.length === 0) needsRepair = true;
    }
    if (needsRepair) {
      console.log(
        '[build] React.xcframework 模拟器 slice 为空，自动 pod install 修复…'
      );
      const podResult = spawnSync('pod', ['install'], { cwd: iosDir, stdio: 'inherit' });
      if (podResult.status !== 0) {
        fail('pod install 失败。请手动 `cd ios && pod install` 后重试。');
      }
    }
  } catch (_) {
    // 失败 warn 不阻断；下面 xcodebuild 自己会报具体错
  }

  /* Podfile.lock 比上次 build 输出新 = pod install 之后没成功 build 过 → nuke DerivedData
     防 Fabric 缓存 symbol 错乱。详见 run-app.js 的同名函数（增量加 native Fabric pod 后
     React-Fabric 缓存不含 debug-only symbol 引发 linker 报"Undefined symbols"几十个）。 */
  try {
    const lockPath = path.join(iosDir, 'Podfile.lock');
    const dd = path.join(require('os').homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
    if (fs.existsSync(lockPath) && fs.existsSync(dd)) {
      const flopsBuildDirs = fs
        .readdirSync(dd)
        .filter((n) => n.startsWith('FlopsMobile-'));
      if (flopsBuildDirs.length > 0) {
        const lockMtime = fs.statSync(lockPath).mtimeMs;
        let latestBuildMtime = 0;
        for (const e of flopsBuildDirs) {
          const productsPath = path.join(dd, e, 'Build', 'Products');
          if (fs.existsSync(productsPath)) {
            const m = fs.statSync(productsPath).mtimeMs;
            if (m > latestBuildMtime) latestBuildMtime = m;
          }
        }
        if (latestBuildMtime > 0 && lockMtime > latestBuildMtime) {
          console.log(
            '[build] Podfile.lock 比上次构建产物新，nuke DerivedData 防 Fabric 缓存 symbol 错乱…'
          );
          for (const e of flopsBuildDirs) {
            const p = path.join(dd, e);
            try {
              spawnSync('rm', ['-rf', p]);
              console.log(`[build]   deleted ${p}`);
            } catch (err) {
              console.warn(`[build]   delete ${p} failed: ${err.message}`);
            }
          }
        }
      }
    }
  } catch (_) {
    // 失败 warn 不阻断
  }
  const workspace = process.env.FLOPS_IOS_WORKSPACE || 'FlopsMobile.xcworkspace';
  const scheme = process.env.FLOPS_IOS_SCHEME || 'FlopsMobile';
  const configuration = process.env.FLOPS_IOS_CONFIGURATION || 'Release';
  const isTestFlight = target === 'testflight';
  // testflight 强制 app-store export，因为只有 app-store profile 才能上 ASC。
  const exportMethod = isTestFlight
    ? 'app-store'
    : (process.env.FLOPS_IOS_EXPORT_METHOD || 'development');
  const pbxprojPath = path.join(iosDir, 'FlopsMobile.xcodeproj', 'project.pbxproj');
  const archivePath = path.join(projectRoot, 'build', 'ios', `${scheme}.xcarchive`);
  const exportPath = path.join(projectRoot, 'build', 'ios', 'export');
  const plistPath = path.join(projectRoot, 'build', 'ios', 'ExportOptions.plist');

  if (!fs.existsSync(pbxprojPath)) {
    fail(`未找到 iOS 工程配置文件：${pbxprojPath}`);
  }
  const pbxprojText = fs.readFileSync(pbxprojPath, 'utf8');
  if (!/DEVELOPMENT_TEAM\s*=/.test(pbxprojText)) {
    fail('iOS 工程未配置 DEVELOPMENT_TEAM，请先在 Xcode 的 Signing 中完成配置。');
  }

  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.mkdirSync(exportPath, { recursive: true });
  writeIosExportOptionsPlist(plistPath, exportMethod);

  const buildNumber = isTestFlight ? computeBuildNumberUTC() : null;
  const marketingVersionEnv = (process.env.FLOPS_IOS_MARKETING_VERSION || '').trim();
  const marketingVersionForArchive =
    isTestFlight &&
    sanitizeIosMarketingVersion(
      marketingVersionEnv || getPackageVersion(projectRoot),
      marketingVersionEnv ? '（来自 FLOPS_IOS_MARKETING_VERSION）' : '（来自 package.json version）'
    );

  console.log('[build] platform=ios');
  console.log('[build] artifact=ipa');
  console.log(`[build] workspace=${workspace}`);
  console.log(`[build] scheme=${scheme}`);
  console.log(`[build] configuration=${configuration}`);
  console.log(`[build] exportMethod=${exportMethod}`);
  if (isTestFlight) {
    console.log(`[build] target=testflight`);
    console.log(
      `[build] marketingVersion=${marketingVersionForArchive} (MARKETING_VERSION)`
    );
    console.log(`[build] buildNumber=${buildNumber} (CURRENT_PROJECT_VERSION)`);
  }

  const archiveArgs = [
    '-workspace',
    workspace,
    '-scheme',
    scheme,
    '-configuration',
    configuration,
    '-archivePath',
    archivePath,
    '-allowProvisioningUpdates',
    'archive',
  ];
  if (isTestFlight) {
    // xcodebuild 接受 KEY=VALUE 形式的 build setting 覆盖（放在 action 之后）
    archiveArgs.push(`MARKETING_VERSION=${marketingVersionForArchive}`);
    archiveArgs.push(`CURRENT_PROJECT_VERSION=${buildNumber}`);
  }

  const archiveStatus = runCommand('xcodebuild', archiveArgs, iosDir);
  if (archiveStatus !== 0) {
    process.exit(archiveStatus);
  }

  const exportStatus = runCommand(
    'xcodebuild',
    [
      '-exportArchive',
      '-archivePath',
      archivePath,
      '-exportPath',
      exportPath,
      '-exportOptionsPlist',
      plistPath,
      '-allowProvisioningUpdates',
    ],
    iosDir
  );
  if (exportStatus !== 0) {
    process.exit(exportStatus);
  }

  console.log(`[build] iOS export 完成，产物目录：${exportPath}`);
  const ipaPath = findLatestFileByExt(exportPath, '.ipa');
  if (!ipaPath) {
    fail('未找到导出的 IPA 文件。');
  }
  const version = getPackageVersion(projectRoot);
  const ipaName = isTestFlight
    ? `FlopsMobile-${version}-${buildNumber}.ipa`
    : `FlopsMobile-${version}.ipa`;
  const copied = copyArtifactToBuildRoot(projectRoot, ipaPath, ipaName);
  console.log(`[build] IPA: ${ipaPath}`);
  console.log(`[build] 已复制到: ${copied}`);
  return { ipaPath: copied, buildNumber };
}

const { platform, artifact, doUpload, target, testinstallReal } = parseArgs(
  process.argv.slice(2)
);

if (platform === 'ios') {
  const result = runIosBuild(artifact, target);
  if (target === 'testflight') {
    require('./build-and-upload-ios.js')
      .run(result.ipaPath)
      .then(() => process.exit(0))
      .catch((err) => {
        if (err && err.message) console.error(err.message);
        process.exit(1);
      });
  } else {
    process.exit(0);
  }
} else if (target === 'testinstall') {
  runAndroidTestInstall(testinstallReal);
  process.exit(0);
} else {
  const builtPath = runAndroidBuild(artifact);
  if (doUpload && builtPath) {
    require('./build-and-upload-android.js')
      .run(builtPath)
      .then(() => process.exit(0))
      .catch((err) => {
        if (err && err.message) console.error(err.message);
        process.exit(1);
      });
  } else {
    process.exit(0);
  }
}
