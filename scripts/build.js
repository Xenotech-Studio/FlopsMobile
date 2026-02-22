#!/usr/bin/env node
/**
 * Unified build entry:
 * - yarn build                    -> android apk
 * - yarn build android            -> android apk
 * - yarn build android apk        -> android apk
 * - yarn build android aab        -> android aab
 * - yarn build ios                -> ios ipa
 * - yarn build ios ipa            -> ios ipa
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
  // Defaults: android + apk
  let platform = 'android';
  let artifact = 'apk';
  let index = 0;

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
    fail(`无法识别的参数：${argv[index]}。用法：yarn build [android|ios] [apk|aab|ipa]`);
  }

  if (platform === 'ios' && artifact === 'apk') {
    artifact = 'ipa';
  }

  if (platform === 'ios' && artifact !== 'ipa') {
    fail('iOS 目前仅支持 ipa。用法：yarn build ios [ipa]');
  }

  return { platform, artifact };
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
    const copied = copyArtifactToBuildRoot(projectRoot, built);
    console.log(`[build] artifact=${built}`);
    console.log(`[build] 已复制到: ${copied}`);
    process.exit(0);
  }
  process.exit(1);
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

function copyArtifactToBuildRoot(projectRoot, sourcePath) {
  const buildRoot = path.join(projectRoot, 'build');
  fs.mkdirSync(buildRoot, { recursive: true });
  const targetPath = path.join(buildRoot, path.basename(sourcePath));
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

function runIosBuild(artifact) {
  if (process.platform !== 'darwin') {
    fail('iOS 打包仅支持在 macOS 执行。');
  }
  if (artifact !== 'ipa') {
    fail('iOS 目前仅支持 ipa。');
  }

  const projectRoot = path.resolve(__dirname, '..');
  const iosDir = path.join(projectRoot, 'ios');
  const workspace = process.env.FLOPS_IOS_WORKSPACE || 'FlopsMobile.xcworkspace';
  const scheme = process.env.FLOPS_IOS_SCHEME || 'FlopsMobile';
  const configuration = process.env.FLOPS_IOS_CONFIGURATION || 'Release';
  const exportMethod = process.env.FLOPS_IOS_EXPORT_METHOD || 'development';
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

  console.log('[build] platform=ios');
  console.log('[build] artifact=ipa');
  console.log(`[build] workspace=${workspace}`);
  console.log(`[build] scheme=${scheme}`);
  console.log(`[build] configuration=${configuration}`);
  console.log(`[build] exportMethod=${exportMethod}`);

  const archiveStatus = runCommand(
    'xcodebuild',
    [
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
    ],
    iosDir
  );
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
  const copied = copyArtifactToBuildRoot(projectRoot, ipaPath);
  console.log(`[build] IPA: ${ipaPath}`);
  console.log(`[build] 已复制到: ${copied}`);
}

const { platform, artifact } = parseArgs(process.argv.slice(2));

if (platform === 'ios') {
  runIosBuild(artifact);
  process.exit(0);
}

runAndroidBuild(artifact);
