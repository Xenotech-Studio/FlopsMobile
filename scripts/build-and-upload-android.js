#!/usr/bin/env node
/**
 * 将已构建的 Android APK 上传到 Flops 后端（COS + Redis），版本默认未发布，需在 Web 后台发布后客户端才能检测到更新。
 * 配置优先级：FlopsMobile/upload-config.json（建议 gitignore）> 环境变量。
 * 格式：{ "FLOPS_SERVER_URL": "https://...", "FLOPS_ACCESS_TOKEN": "..." }
 *
 * 使用方式：
 * - yarn build android upload   （先构建再上传）
 * - node scripts/build-and-upload-android.js [path/to/app.apk]   （仅上传，不指定路径则用 build/ 下最新 .apk）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { Transform } = require('stream');

const rootDir = path.resolve(__dirname, '..');
const configPath = path.join(rootDir, 'upload-config.json');

let baseUrl = (process.env.FLOPS_SERVER_URL || '').trim().replace(/\/$/, '');
let token = (process.env.FLOPS_ACCESS_TOKEN || '').trim();
if (fs.existsSync(configPath)) {
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    baseUrl = (data.FLOPS_SERVER_URL || data.serverUrl || baseUrl).trim().replace(/\/$/, '');
    token = (data.FLOPS_ACCESS_TOKEN || data.accessToken || token).trim();
  } catch (e) {
    console.warn('Warning: could not parse upload-config.json, using env:', e.message);
  }
}

function findLatestApk(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.apk'));
  if (files.length === 0) return null;
  const withPath = files.map((f) => path.join(dir, f));
  withPath.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return withPath[0];
}

function formatBytes(n) {
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function run(apkPath) {
  const resolvedPath = apkPath ? path.resolve(rootDir, apkPath) : findLatestApk(path.join(rootDir, 'build'));
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    console.error('No APK found. Run "yarn build android" first or pass path: node scripts/build-and-upload-android.js path/to/app.apk');
    return Promise.reject(new Error('No APK found'));
  }

  if (!baseUrl || !token) {
    console.error('Missing FLOPS_SERVER_URL or FLOPS_ACCESS_TOKEN.');
    console.error('Create FlopsMobile/upload-config.json with FLOPS_SERVER_URL and FLOPS_ACCESS_TOKEN, or set env.');
    return Promise.reject(new Error('Missing upload config'));
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const version = (pkg.version || '').trim() || null;
  const filename = path.basename(resolvedPath);
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', fs.createReadStream(resolvedPath), { filename });
  if (version) form.append('version', version);

  const url = `${baseUrl}/api/admin/android-releases/upload`;
  const isHttps = url.startsWith('https');
  let totalBytes = 0;
  try {
    totalBytes = form.getLengthSync();
  } catch (_) {
    totalBytes = fs.statSync(resolvedPath).size + 512;
  }

  const progressStream = new Transform({
    transform(chunk, _enc, cb) {
      progressStream.sent = (progressStream.sent || 0) + chunk.length;
      const pct = totalBytes > 0 ? Math.min(100, (progressStream.sent / totalBytes) * 100) : 0;
      const barLen = 24;
      const filled = Math.round((pct / 100) * barLen);
      const bar = '[' + '='.repeat(filled) + (filled < barLen ? '>' : '') + ' '.repeat(barLen - filled - (filled < barLen ? 1 : 0)) + ']';
      process.stdout.write(`\r 上传 APK ${bar} ${pct.toFixed(1)}% (${formatBytes(progressStream.sent)} / ${formatBytes(totalBytes)})    `);
      cb(null, chunk);
    },
  });

  const urlObj = new URL(url);
  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port || (isHttps ? 443 : 80),
    path: urlObj.pathname + urlObj.search,
    method: 'POST',
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${token}`,
    },
  };

  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(options, (res) => {
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('Upload OK:', filename);
          try {
            const data = JSON.parse(body);
            console.log(`Version ${data.version || version || '(from file)'} uploaded. Publish it in Flops Web Admin to enable app update.`);
          } catch (_) {}
          resolve();
        } else {
          console.error('Upload failed:', `HTTP ${res.statusCode}:`, body);
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', (e) => {
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      console.error('Upload error:', e.message);
      reject(e);
    });
    form.pipe(progressStream).pipe(req);
  });
}

if (require.main === module) {
  const apkPath = process.argv[2];
  run(apkPath)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
} else {
  module.exports = { run };
}
