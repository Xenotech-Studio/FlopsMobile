#!/usr/bin/env node
/**
 * Waits for Metro to be ready, then runs react-native run-ios or run-android.
 * Used by yarn dev so the app launches after the packager is up.
 * iOS: reads rn-dev.config.json "ios.simulator" for --simulator "Device Name".
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const target = process.argv[2] || 'ios'; // ios | android
const METRO_PORT = parseInt(process.argv[3] || process.env.METRO_PORT || '8081', 10);
const POLL_INTERVAL_MS = 800;
const METRO_WAIT_TIMEOUT_MS = 60000;

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

  const args = ['react-native', `run-${target}`];
  if (target === 'ios') {
    const simulator = getIosSimulator();
    if (simulator) {
      args.push('--simulator', simulator);
    }
  }
  if (target === 'android') {
    args.push('--no-packager', '--port', String(METRO_PORT));
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
