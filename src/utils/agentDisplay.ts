/** 与 FlopsWeb Chat.jsx formatAgentDisplayLabel 一致 */
export function formatAgentDisplayLabel(agentId: string | null | undefined): string {
  const s = String(agentId || '').trim();
  if (!s || s === 'default') return 'FLOPS';
  return s;
}
