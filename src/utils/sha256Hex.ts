/** 与 FlowTask Web 协作消息里 `origin_token_hash` 对齐（若运行环境无 subtle 则返回 null）。 */
export async function sha256Hex(text: string): Promise<string | null> {
  try {
    const g = globalThis as unknown as {
      crypto?: { subtle?: { digest: (algo: string, data: Uint8Array) => Promise<ArrayBuffer> } };
      TextEncoder?: new () => { encode(input: string): Uint8Array };
    };
    const subtle = g.crypto?.subtle;
    const TextEncoderCtor = g.TextEncoder;
    if (!subtle || !TextEncoderCtor) return null;
    const buf = await subtle.digest('SHA-256', new TextEncoderCtor().encode(text));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}
