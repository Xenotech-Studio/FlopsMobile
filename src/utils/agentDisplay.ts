/** 与 FlopsWeb Chat.jsx formatAgentDisplayLabel 一致 */
export function formatAgentDisplayLabel(agentId: string | null | undefined): string {
  const s = String(agentId || '').trim();
  if (!s || s === 'default') return 'FLOPS';
  return s;
}

/** 优先用服务端 profile 的 display_name，否则回退 formatAgentDisplayLabel(agentId) */
export function resolveAgentDisplayLabel(
  agentId: string | null | undefined,
  displayName?: string | null
): string {
  const dn = String(displayName ?? '').trim();
  if (dn) return dn;
  return formatAgentDisplayLabel(agentId);
}
