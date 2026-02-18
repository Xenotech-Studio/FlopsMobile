/**
 * @format
 * 仅在需要 response.body 流式时使用 polyfill fetch，其余用 RN 原生 fetch，避免 blob 报错。
 */
require('./saveFetch');
require('react-native-polyfill-globals/auto');
const polyfillFetch = global.fetch;
const originalFetch = global.__rnOriginalFetch;

global.fetch = function fetchWithStreamingSupport(input, init) {
  if (init?.reactNative?.textStreaming) return polyfillFetch(input, init);
  return originalFetch(input, init);
};

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
