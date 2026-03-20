import type { TextStyle } from 'react-native';

type AnsiState = { bold: boolean; dim: boolean; fg: number | null };

type AnsiSegment = {
  text: string;
  style?: TextStyle;
};

// ANSI 8 色（SGR 30–37）前景色，对齐桌面终端风格
const ANSI_FG: Record<number, string> = {
  30: '#2d2d2d',
  31: '#c23621',
  32: '#2ecc71',
  33: '#f39c12',
  34: '#3498db',
  35: '#9b59b6',
  36: '#00b4d8',
  37: '#ecf0f1',
};

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]?/g, '');
}

/**
 * 将 ANSI CSI（如 \x1b[36m）解析为 RN 可渲染片段。
 * 注：不尝试处理光标移动/清屏指令，仅解析 SGR（颜色/加粗/变暗）。
 */
export function ansiToSegments(text: string): AnsiSegment[] {
  if (typeof text !== 'string' || !text) return [{ text: '' }];

  const re = /\x1b\[([\d;]*)m/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  let state: AnsiState = { bold: false, dim: false, fg: null };
  const out: AnsiSegment[] = [];

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const raw = text.slice(lastIndex, match.index);
      out.push(createSegment(raw, state, idx++));
    }

    const codes = match[1] ? match[1].split(';').map((s) => parseInt(s, 10)) : [0];
    for (const code of codes) {
      if (code === 0) state = { bold: false, dim: false, fg: null };
      else if (code === 1) state = { ...state, bold: true };
      else if (code === 2) state = { ...state, dim: true };
      else if (code >= 30 && code <= 37) state = { ...state, fg: code };
      else if (code === 39) state = { ...state, fg: null };
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const raw = text.slice(lastIndex);
    out.push(createSegment(raw, state, idx++));
  }

  return out.length ? out : [{ text: '' }];
}

function createSegment(raw: string, state: AnsiState, _key: number): AnsiSegment {
  if (!raw) return { text: '' };

  const style: TextStyle = {};
  if (state.bold) style.fontWeight = 'bold';
  if (state.dim) style.opacity = 0.7;
  if (state.fg != null && ANSI_FG[state.fg]) style.color = ANSI_FG[state.fg];

  if (Object.keys(style).length === 0) return { text: raw };
  return { text: raw, style };
}

