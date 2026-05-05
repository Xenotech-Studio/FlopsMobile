#!/usr/bin/env node
/**
 * 上传已构建的 iOS .ipa 到 App Store Connect。同一通道既给 TestFlight 也给 App Store。
 *
 * 配置文件：FlopsMobile/ios-upload-config.json（被 .gitignore 屏蔽，必须手动创建；参考 ios-upload-config.example.json）
 *   - ASC_API_KEY_ID:   10 位 Key ID，App Store Connect → Users and Access → Integrations 创建
 *   - ASC_ISSUER_ID:    UUID，每个 ASC team 共享一个 Issuer ID
 *   - ASC_API_KEY_PATH: 相对 FlopsMobile/ 的 .p8 路径（约定 ../secrets/AuthKey_<KEY_ID>.p8）
 *
 * 实现细节：
 *   xcrun altool 在固定路径查找 .p8（按优先级）：
 *     ./private_keys/  ~/private_keys/  ~/.private_keys/  ~/.appstoreconnect/private_keys/
 *   本脚本会把 secrets/ 下的 .p8 软链到 ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
 *   一次软链长期有效，重跑只 re-link 错误的链接，不影响原文件。
 *
 * 使用：
 *   yarn build ios testflight                                     # 完整流程：build + upload
 *   node scripts/build-and-upload-ios.js [path/to/Flops.ipa]      # 仅上传（路径默认取 build/ 下最新 .ipa）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const configPath = path.join(rootDir, 'ios-upload-config.json');

function fail(msg) {
  console.error(`[ios-upload] ${msg}`);
  process.exit(1);
}

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    fail(
      `未找到 ${configPath}\n` +
        `请参考同目录的 ios-upload-config.example.json 创建（该文件已 .gitignore，不会进 git）。`
    );
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    fail(`ios-upload-config.json 解析失败：${e.message}`);
  }
  const keyId = (raw.ASC_API_KEY_ID || '').trim();
  const issuerId = (raw.ASC_ISSUER_ID || '').trim();
  const keyPathRel = (raw.ASC_API_KEY_PATH || '').trim();
  if (!keyId || keyId.startsWith('REPLACE_ME')) {
    fail('ios-upload-config.json 缺 ASC_API_KEY_ID（或仍为占位符）');
  }
  if (!issuerId || issuerId.startsWith('REPLACE_ME')) {
    fail('ios-upload-config.json 缺 ASC_ISSUER_ID（或仍为占位符）');
  }
  if (!keyPathRel || keyPathRel.includes('REPLACE_ME')) {
    fail('ios-upload-config.json 缺 ASC_API_KEY_PATH（或仍为占位符）');
  }

  // 路径相对 FlopsMobile/ 解析
  const keyPath = path.resolve(rootDir, keyPathRel);
  if (!fs.existsSync(keyPath)) {
    fail(
      `ASC API .p8 不存在：${keyPath}\n` +
        `请确认 ASC_API_KEY_PATH 配置正确，且 .p8 文件已放置到该位置。`
    );
  }
  return { keyId, issuerId, keyPath };
}

/**
 * 在 ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8 建立到源 .p8 的软链。
 *
 * 这是 xcrun altool 的默认查找路径之一。直接软链而非复制，可在更新源文件时
 * 自动同步，且避免跨位置存放多个 .p8 副本。
 */
function ensureP8AtAltoolPath(keyId, srcKeyPath) {
  const altoolDir = path.join(os.homedir(), '.appstoreconnect', 'private_keys');
  fs.mkdirSync(altoolDir, { recursive: true });
  const dst = path.join(altoolDir, `AuthKey_${keyId}.p8`);

  if (fs.existsSync(dst) || fs.lstatSync(dst, { throwIfNoEntry: false })) {
    try {
      const stat = fs.lstatSync(dst);
      if (stat.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(dst);
        const resolvedTarget = path.isAbsolute(linkTarget)
          ? linkTarget
          : path.resolve(altoolDir, linkTarget);
        if (resolvedTarget === path.resolve(srcKeyPath)) {
          return dst; // 已正确软链
        }
        // 软链指向别处，删了重建
        fs.unlinkSync(dst);
      } else {
        // 普通文件：保守起见不动，警告用户
        console.warn(
          `[ios-upload] 警告：${dst} 是普通文件而非软链；保留现状。\n` +
            `  如需用本仓库的 .p8 替换，请手动 rm 该文件后重跑。`
        );
        return dst;
      }
    } catch (_) {
      // lstat 失败就当不存在
    }
  }

  fs.symlinkSync(srcKeyPath, dst);
  console.log(`[ios-upload] 软链：${dst} -> ${srcKeyPath}`);
  return dst;
}

function findLatestIpa(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.ipa'));
  if (files.length === 0) return null;
  const withPath = files.map((f) => path.join(dir, f));
  withPath.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return withPath[0];
}

/**
 * altool 在 validation 错误（如缺 icon）时 exit code 仍可能是 0，UPLOAD FAILED
 * 行只出现在输出里。仅依赖 exit code 会把这类失败误判为成功，必须扫描输出。
 *
 * 因此把 stdio 从 'inherit' 改成 pipe，原样转发到本进程 stdout/stderr 的同时
 * 累计到 buffer，在 close 时同时检查 exit code 与 buffer 内容。
 */
const ALTOOL_FAILURE_REGEX = /UPLOAD FAILED|Validation failed|^\s*\d{4}-\d{2}-\d{2}.*\bERROR:/im;

function uploadIpa(ipaPath, keyId, issuerId) {
  console.log(`[ios-upload] 开始上传：${ipaPath}`);
  console.log(`[ios-upload] Key ID=${keyId}  Issuer=${issuerId}`);
  console.log(
    '[ios-upload] 调用 xcrun altool --upload-app（这一步通常需要数分钟，期间 altool 会做客户端校验后流式传输 ipa；请耐心等待）...'
  );
  return new Promise((resolve, reject) => {
    const args = [
      'altool',
      '--upload-app',
      '-f',
      ipaPath,
      '-t',
      'ios',
      '--apiKey',
      keyId,
      '--apiIssuer',
      issuerId,
    ];
    const proc = spawn('xcrun', args, { stdio: ['inherit', 'pipe', 'pipe'] });
    let combined = '';
    proc.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      combined += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      combined += chunk.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      const hasFailureInOutput = ALTOOL_FAILURE_REGEX.test(combined);
      if (code === 0 && !hasFailureInOutput) {
        console.log('');
        console.log('[ios-upload] 上传成功 ✓');
        console.log(
          '[ios-upload] 接下来：到 App Store Connect → 你的 app → TestFlight tab，'
        );
        console.log(
          '[ios-upload]   Apple 会处理 build 5-30 分钟（"Processing"），'
        );
        console.log(
          '[ios-upload]   随后 Internal Testers 立即可装；External 首次需 Beta App Review。'
        );
        resolve();
        return;
      }

      const reasonHeader = hasFailureInOutput
        ? `altool 输出中检测到 validation / upload 错误（exit code ${code}；详见上方 "UPLOAD FAILED" / "Validation failed" / "ERROR:" 行）`
        : `xcrun altool 失败 (exit code ${code})`;
      reject(
        new Error(
          `${reasonHeader}\n` +
            `常见原因：\n` +
            `  - 缺 icon（Universal app 需 76@2x + 83.5@2x；iPhone-only 需检查 60@2x/3x 都在）\n` +
            `  - bundle id 与 ASC app record 不匹配（确认 com.xenotech.FlopsMobile 已在 ASC My Apps 创建）\n` +
            `  - build number 重复（脚本已用 timestamp 自动避免，但若手动跑 upload 跳过 build 阶段可能撞）\n` +
            `  - .p8 / Issuer / Key ID 配错（ios-upload-config.json）\n` +
            `  - Distribution Cert / App Store Profile 缺失（archive 阶段一般会先报错）`
        )
      );
    });
  });
}

async function run(ipaPathArg) {
  const { keyId, issuerId, keyPath } = loadConfig();
  ensureP8AtAltoolPath(keyId, keyPath);

  let ipaPath;
  if (ipaPathArg) {
    ipaPath = path.resolve(rootDir, ipaPathArg);
    if (!fs.existsSync(ipaPath)) {
      fail(`未找到 ipa：${ipaPath}`);
    }
  } else {
    ipaPath = findLatestIpa(path.join(rootDir, 'build'));
    if (!ipaPath) {
      fail(
        '未找到 ipa。请先跑 `yarn build ios testflight`，或显式指定路径：\n' +
          '  node scripts/build-and-upload-ios.js path/to/Flops.ipa'
      );
    }
  }

  await uploadIpa(ipaPath, keyId, issuerId);
}

if (require.main === module) {
  run(process.argv[2])
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[ios-upload] ${err.message || err}`);
      process.exit(1);
    });
} else {
  module.exports = { run };
}
