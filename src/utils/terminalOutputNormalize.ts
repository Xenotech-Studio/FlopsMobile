/**
 * 将 TTY 流（含 CSI 光标/擦除/清屏与 SGR 颜色）归一为「控制语义执行后」的静态文本。
 * 不引入第三方库；与服务端 Flops 仓库根目录 `terminal_output_normalize.py` 保持行为对齐。
 *
 * @param {string} input
 * @param {{ keepSgr?: boolean }} [options] - keepSgr 默认 true：保留 \\x1b[...m 供 LLM/ansiToReact
 * @returns {string}
 */

type LineTok = { t: 's'; raw: string } | { t: 'c'; ch: string };
type Line = LineTok[];

/**
 * 流式 chunk 可能在 ESC/CSI/OSC 中间截断；末尾不完整序列不参与模拟，原样拼回，避免把 [、数字等当成可打印字符导致「假换行」。
 */
function splitIncompleteEscapeSuffix(s: string): { body: string; suffix: string } {
  const ESC = "\x1b";
  const li = s.lastIndexOf(ESC);
  if (li === -1) return { body: s, suffix: "" };
  const suf = s.slice(li);
  if (suf.length === 1) return { body: s.slice(0, li), suffix: suf };
  const c1 = suf[1];
  if (c1 === "[") {
    for (let i = 2; i < suf.length; i++) {
      const code = suf.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) {
        return { body: s, suffix: "" };
      }
    }
    return { body: s.slice(0, li), suffix: suf };
  }
  if (c1 === "]") {
    const rest = suf.slice(2);
    if (rest.includes("\x07")) return { body: s, suffix: "" };
    if (rest.includes(ESC + "\\")) return { body: s, suffix: "" };
    return { body: s.slice(0, li), suffix: suf };
  }
  if (suf.length === 2) {
    const code = suf.charCodeAt(1);
    if (code >= 0x40 && code <= 0x5f) {
      return { body: s, suffix: "" };
    }
  }
  if (suf.length >= 2 && (c1 === "(" || c1 === ")" || c1 === "#")) {
    if (suf.length < 3) return { body: s.slice(0, li), suffix: suf };
  }
  return { body: s, suffix: "" };
}

export function normalizeTerminalOutput(
  input: string | null | undefined,
  options: { keepSgr?: boolean } = {}
): string {
  if (typeof input !== "string" || !input) return "";
  const { body, suffix } = splitIncompleteEscapeSuffix(input);
  return normalizeTerminalOutputCore(body, options) + suffix;
}

function normalizeTerminalOutputCore(input: string, options: { keepSgr?: boolean } = {}): string {
  const keepSgr = options.keepSgr !== false;
  if (!input) return "";

  let lines: Line[] = [[]];
  let row = 0;
  let vcol = 0;

  const ensureRow = (r: number) => {
    while (lines.length <= r) lines.push([]);
  };

  const joinTokens = (tokens: Line): string => {
    let s = "";
    for (const t of tokens) s += t.t === "s" ? t.raw : t.ch;
    return s;
  };

  /**
   * @param {Array<{ t: 's'; raw: string } | { t: 'c'; ch: string }>} tokens
   * @param {number} vcol0
   */
  const eraseLineFromVcol = (tokens: Line, vcol0: number): Line => {
    let v = 0;
    const out: Line = [];
    let pending: Line = [];
    for (const t of tokens) {
      if (t.t === "s") {
        pending.push(t);
        continue;
      }
      if (v < vcol0) {
        out.push(...pending, t);
        pending = [];
        v++;
      } else {
        pending = [];
      }
    }
    return out;
  };

  /**
   * @param {Array<{ t: 's'; raw: string } | { t: 'c'; ch: string }>} tokens
   * @param {number} vcol0
   */
  const eraseLineToVcol = (tokens: Line, vcol0: number): Line => {
    let v = 0;
    const out: Line = [];
    let pending: Line = [];
    for (const t of tokens) {
      if (t.t === "s") {
        pending.push(t);
        continue;
      }
      if (v >= vcol0) {
        out.push(...pending, t);
        pending = [];
        v++;
      } else {
        pending = [];
        v++;
      }
    }
    return out;
  };

  /**
   * @param {Array<{ t: 's'; raw: string } | { t: 'c'; ch: string }>} tokens
   * @param {number} vcol0
   * @param {string} raw
   */
  const insertSgr = (tokens: Line, vcol0: number, raw: string): void => {
    let v = 0;
    let ti = 0;
    for (; ti < tokens.length; ti++) {
      const t = tokens[ti];
      if (t.t === "s") continue;
      if (v === vcol0) break;
      v++;
    }
    tokens.splice(ti, 0, { t: "s", raw });
  };

  /**
   * @param {Array<{ t: 's'; raw: string } | { t: 'c'; ch: string }>} tokens
   * @param {number} vcol0
   * @param {string} ch
   */
  const putChar = (tokens: Line, vcol0: number, ch: string): void => {
    let v = 0;
    let ti = 0;
    for (; ti < tokens.length; ti++) {
      const t = tokens[ti];
      if (t.t === "s") continue;
      if (v === vcol0) break;
      v++;
    }
    if (ti < tokens.length && tokens[ti].t === "c") {
      tokens[ti] = { t: "c", ch };
    } else {
      tokens.splice(ti, 0, { t: "c", ch });
    }
  };

  const parseCsi = (
    str: string,
    escIdx: number
  ): { raw: string; paramStr: string; final: string; end: number } | null => {
    if (str.charCodeAt(escIdx) !== 0x1b || str[escIdx + 1] !== "[") return null;
    let j = escIdx + 2;
    while (j < str.length) {
      const ch = str[j];
      const code = ch.charCodeAt(0);
      if (code >= 0x40 && code <= 0x7e) {
        return {
          raw: str.slice(escIdx, j + 1),
          paramStr: str.slice(escIdx + 2, j),
          final: ch,
          end: j + 1,
        };
      }
      j++;
    }
    return null;
  };

  const parseNums = (paramStr: string): number[] => {
    if (!paramStr || paramStr[0] === "?") return [];
    const parts = paramStr.split(";");
    const out: number[] = [];
    for (const p of parts) {
      if (!p) out.push(0);
      else {
        const n = parseInt(p, 10);
        out.push(Number.isFinite(n) ? n : 0);
      }
    }
    return out;
  };

  const skipOsc = (str: string, escIdx: number): number | null => {
    if (str.charCodeAt(escIdx) !== 0x1b || str[escIdx + 1] !== "]") return null;
    let j = escIdx + 2;
    while (j < str.length) {
      if (str[j] === "\x07") return j + 1;
      if (str[j] === "\x1b" && str[j + 1] === "\\") return j + 2;
      j++;
    }
    return str.length;
  };

  let i = 0;
  while (i < input.length) {
    const c0 = input[i];
    const code0 = c0.charCodeAt(0);

    if (c0 === "\r") {
      vcol = 0;
      i++;
      continue;
    }
    if (c0 === "\n") {
      row += 1;
      ensureRow(row);
      vcol = 0;
      i++;
      continue;
    }
    if (c0 === "\b") {
      vcol = Math.max(0, vcol - 1);
      i++;
      continue;
    }
    if (c0 === "\t") {
      const tab = 8;
      vcol = vcol + tab - (vcol % tab);
      i++;
      continue;
    }

    if (code0 === 0x1b) {
      const oscEnd = skipOsc(input, i);
      if (oscEnd != null && input[i + 1] === "]") {
        i = oscEnd;
        continue;
      }

      const csi = parseCsi(input, i);
      if (!csi) {
        putChar(lines[row], vcol, c0);
        vcol += 1;
        i++;
        continue;
      }

      const { raw, paramStr, final, end } = csi;
      i = end;

      if (paramStr.startsWith("?")) {
        continue;
      }

      const nums = parseNums(paramStr);
      const n0 = nums[0] || 0;
      const n1 = nums[1] || 0;

      if (final === "m") {
        if (keepSgr) {
          ensureRow(row);
          insertSgr(lines[row], vcol, raw);
        }
        continue;
      }

      ensureRow(row);

      if (final === "A") {
        row = Math.max(0, row - (n0 || 1));
        continue;
      }
      if (final === "B" || final === "e") {
        row += n0 || 1;
        ensureRow(row);
        continue;
      }
      if (final === "C" || final === "a") {
        vcol += n0 || 1;
        continue;
      }
      if (final === "D") {
        vcol = Math.max(0, vcol - (n0 || 1));
        continue;
      }
      if (final === "E") {
        row += n0 || 1;
        ensureRow(row);
        vcol = 0;
        continue;
      }
      if (final === "F") {
        row = Math.max(0, row - (n0 || 1));
        vcol = 0;
        continue;
      }
      if (final === "G") {
        vcol = Math.max(0, (n0 || 1) - 1);
        continue;
      }
      if (final === "H" || final === "f") {
        const rr = (n0 || 1) - 1;
        const cc = (n1 || 1) - 1;
        row = Math.max(0, rr);
        ensureRow(row);
        vcol = Math.max(0, cc);
        continue;
      }

      if (final === "J") {
        const mode = n0;
        if (mode === 2 || mode === 3) {
          lines = [[]];
          row = 0;
          vcol = 0;
          continue;
        }
        if (mode === 1) {
          for (let r = 0; r < row; r++) lines[r] = [];
          lines[row] = eraseLineToVcol(lines[row], vcol);
          for (let r = row + 1; r < lines.length; r++) lines[r] = [];
          continue;
        }
        // 0 or default: 从光标擦到屏尾
        lines[row] = eraseLineFromVcol(lines[row], vcol);
        for (let r = row + 1; r < lines.length; r++) lines[r] = [];
        continue;
      }

      if (final === "K") {
        const mode = n0;
        if (mode === 1) {
          lines[row] = eraseLineToVcol(lines[row], vcol);
          continue;
        }
        if (mode === 2) {
          lines[row] = [];
          continue;
        }
        // 0 / default: 擦到行尾
        lines[row] = eraseLineFromVcol(lines[row], vcol);
        continue;
      }

      if (final === "S" || final === "T" || final === "L" || final === "M" || final === "@") {
        continue;
      }

      if (final === "s" || final === "u") {
        continue;
      }

      continue;
    }

    let ch = c0;
    let adv = 1;
    if (code0 >= 0xd800 && code0 <= 0xdbff && i + 1 < input.length) {
      const c1 = input[i + 1];
      const c1c = c1.charCodeAt(0);
      if (c1c >= 0xdc00 && c1c <= 0xdfff) {
        ch = c0 + c1;
        adv = 2;
      }
    }

    ensureRow(row);
    putChar(lines[row], vcol, ch);
    vcol += 1;
    i += adv;
  }

  while (lines.length > 1 && joinTokens(lines[lines.length - 1]) === "") {
    lines.pop();
  }

  return lines.map(joinTokens).join("\n");
}

/**
 * 对工具 result 中的 stdout/stderr 做终端归一化（就地新对象）。
 * @param {Record<string, unknown>} result
 * @param {{ keepSgr?: boolean }} [options]
 */
export function normalizeToolResultTerminalFields(
  result: Record<string, unknown> | null | undefined,
  options: { keepSgr?: boolean } = {}
): Record<string, unknown> | null | undefined {
  if (result == null || typeof result !== "object" || Array.isArray(result)) return result;
  const out: Record<string, unknown> = { ...result };
  for (const key of ["stdout", "stderr"] as const) {
    const v = out[key];
    if (typeof v === "string" && v) {
      out[key] = normalizeTerminalOutput(v, options);
    }
  }
  return out;
}
