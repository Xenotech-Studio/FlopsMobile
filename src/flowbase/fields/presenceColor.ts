/**
 * presence 配色：由 client_id 稳定派生一个高辨识度 HSL 颜色。
 * 公式与 Desktop `useFlowBaseRealtime.js` 的 colorForClient 完全一致，保证「同一协作者在
 * Desktop 和 Mobile 上是同一个颜色」。
 */
export function colorForClient(clientId: string): string {
  let h = 0;
  const s = String(clientId || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 70%, 45%)`;
}
