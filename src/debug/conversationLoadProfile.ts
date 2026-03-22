/**
 * 打开会话时的耗时探针。日志前缀固定为 [FLOPS_CONV_PROFILE]，在 Metro / Xcode 控制台过滤即可。
 *
 * 开启方式（任选）：
 * - 开发包：默认 __DEV__ 为 true 时会自动打日志。
 * - 任意包：在调试器里执行 `global.__FLOPS_PROFILE_CONVERSATION = true` 后重进会话。
 */

type GlobalWithFlag = typeof globalThis & { __FLOPS_PROFILE_CONVERSATION?: boolean };

export function isConversationLoadProfilingEnabled(): boolean {
  if (typeof __DEV__ !== 'undefined' && __DEV__) return true;
  return (globalThis as GlobalWithFlag).__FLOPS_PROFILE_CONVERSATION === true;
}

export function convProfileLog(label: string, data: Record<string, unknown>): void {
  if (!isConversationLoadProfilingEnabled()) return;
  console.log(`[FLOPS_CONV_PROFILE] ${label}`, data);
}
