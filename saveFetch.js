/**
 * 在加载任何 polyfill 之前执行，保存 RN 原生 fetch。
 * 必须用 require() 在本文件最先执行，避免 import 提升导致 polyfill 先替换 global.fetch。
 */
global.__rnOriginalFetch = global.fetch;
