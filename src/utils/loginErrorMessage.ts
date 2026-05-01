/**
 * 登录失败：统一为可读中文文案（服务端常为英文短语或简短 error 字段）。
 */
export default function loginErrorMessage(err: unknown): string {
  const raw =
    err instanceof Error && typeof err.message === 'string'
      ? err.message.trim()
      : String(err ?? '').trim();
  if (!raw) return '登录失败，请稍后重试。';

  const lowered = raw.toLowerCase();

  if (
    lowered.includes('401') ||
    lowered.includes('invalid credential') ||
    lowered.includes('invalid_credentials') ||
    lowered.includes('authentication failed') ||
    lowered.includes('auth failed') ||
    lowered.includes('wrong password') ||
    lowered.includes('incorrect password') ||
    lowered.includes('bad password') ||
    lowered.includes('password mismatch') ||
    lowered.includes('unauthorized') ||
    /incorrect.*username|incorrect.*password|用户名或密码/.test(lowered)
  ) {
    return '用户 ID 或密码不正确。';
  }

  if (lowered.includes('403') || lowered.includes('forbidden')) {
    return '当前账号暂无登录权限。';
  }

  if (
    lowered.includes('econnrefused') ||
    lowered.includes('failed to fetch') ||
    lowered.includes('network') ||
    lowered.includes('socket hang up') ||
    lowered.includes('无法连接') ||
    lowered.includes('connection refused') ||
    /runtime request failed:\s*5\d\d/i.test(lowered)
  ) {
    return '无法连接服务器，请检查网络后重试。';
  }

  if (lowered.includes('timeout')) {
    return '登录请求超时，请稍后再试。';
  }

  if (/^runtime request failed:\s*404/i.test(lowered)) {
    return '登录接口不可用，请更新应用或稍后再试。';
  }

  if (lowered.includes('429') || lowered.includes('too many')) {
    return '尝试次数过多，请稍后再试。';
  }

  if (lowered.includes('core bridge')) {
    return '无法完成登录，请重启应用后再试。';
  }

  if (raw.length > 160 || lowered.includes('\n')) {
    return '登录失败，请稍后重试。';
  }

  return raw;
}
