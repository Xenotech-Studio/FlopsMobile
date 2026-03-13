/**
 * 当前应用版本号，与 package.json 保持一致（构建时与 native versionName 同步）。
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../package.json') as { version?: string };
export const APP_VERSION = (pkg.version || '0.0.0').trim();
