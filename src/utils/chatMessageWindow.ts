/**
 * 流式期间的「消息窗口」裁剪。
 *
 * 单独成模块是为了能测：ChatScreen 拖着一长串未编译 ESM 的原生依赖（audio-api / 图标 /
 * 手势 / 加密…），jest 里 import 不进来。而这段边界判定已经踩过两次坑，值得钉住。
 */
import type { ChatMessage } from './chatLocalMessages';

/**
 * 与 FlopsWeb Chat.jsx 一致：存在进行中的 chat_v2 run 时去掉最后一条 user 之后的回复，
 * 避免与 subscribe 回放叠两套。
 *
 * 两个边界要分开算：
 * - task_event（后台任务灰条）在服务端是 meta user 消息（kind='task_event'），run 期间就会被
 *   drain 进消息列表。它要保留，否则流式时灰条会被截掉。
 * - 但**不能**拿它当"保留到这里为止"的界桩：带后台任务的一轮，服务端消息形如
 *   `… user, assistant(已落库的半截), task_event, …`，按它切会把中间那条 assistant 半截一起留下。
 *   那条随后会被当成**已完成**消息渲染（挂上复制/重新生成按钮行），同时 resume 又把同一段内容
 *   流进下面的气泡 —— 就是「切回前台先显示结束态、再变活跃、还跳一下滚动」的由来。
 *
 * 所以：切到最后一个边界（user 或 task_event），但真 user 之后只放行 task_event 灰条，
 * 助手内容一律丢掉 —— 它马上会由流重新渲染出来。
 */
export function truncateMessagesAfterLastUser(messages: ChatMessage[]): ChatMessage[] {
  let lastUserIdx = -1;
  let lastBoundaryIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const role = messages[i].role;
    if (role === 'user') {
      lastUserIdx = i;
      lastBoundaryIdx = i;
    } else if (role === 'task_event') {
      lastBoundaryIdx = i;
    }
  }
  if (lastBoundaryIdx < 0) return messages;
  return messages
    .slice(0, lastBoundaryIdx + 1)
    .filter((m, i) => i <= lastUserIdx || m.role === 'task_event');
}
