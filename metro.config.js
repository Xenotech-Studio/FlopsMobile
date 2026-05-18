const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    /**
     * lib0/webcrypto 在 RN 上默认走 webcrypto.react-native.cjs，那个文件 require 了
     * isomorphic-webcrypto/src/react-native，而后者又 require 了 expo-random / expo-modules-core
     * （即使分支用不到，Metro 静态分析也会去解析）。我们不用 Expo。
     * 直接把 react-native 平台的 lib0 webcrypto 替换成 browser 版（用 crypto.getRandomValues，
     * 由 react-native-polyfill-globals 在 index.js 里 polyfill）。yjs 只用到 getRandomValues，不需要 subtle。
     */
    resolveRequest: (context, moduleName, platform) => {
      if (
        platform === 'ios' || platform === 'android'
      ) {
        if (
          moduleName === 'lib0/webcrypto' ||
          moduleName === 'lib0/dist/webcrypto.react-native.cjs' ||
          moduleName.endsWith('/lib0/dist/webcrypto.react-native.cjs')
        ) {
          return {
            type: 'sourceFile',
            filePath: path.join(__dirname, 'node_modules/lib0/dist/webcrypto.cjs'),
          };
        }
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
