/**
 * SRP-6a 客户端 + argon2id 客户端预哈希。Mobile (Hermes) 版，与后端
 * backend/user_system/srp_helper.py 字节级互通。
 *
 * 混合实现：
 *   - argon2id: react-native-argon2（iOS Argon2Swift / Android argon2kt，
 *     都包的是 Argon2 官方 reference C 实现，与 Python argon2-cffi 字节对齐）
 *     —— 纯 JS @noble/hashes 版在 Hermes 上同参数要跑 ~170s，不可用
 *   - SHA-256: @noble/hashes/sha2
 *   - getRandomValues: 由 react-native-get-random-values polyfill 提供
 *   - BigInt: Hermes 原生
 *
 * RSA-OAEP envelope 暂未接入：mobile 这次只切 login；register/change-pwd
 * 仍走旧明文路径，等后续补 node-forge 之类的 RSA pure JS 实现。
 *
 * 字节序与后端一致：BigInt → 大端字节，**去掉前导 0 字节**（对齐 srptools int_to_bytes）。
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import argon2 from 'react-native-argon2';
import forge from 'node-forge';

declare const global: { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
declare class TextEncoder { encode(s: string): Uint8Array }

const PRIME_2048_HEX =
  'AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050' +
  'A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50' +
  'E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B8' +
  '55F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773B' +
  'CA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748' +
  '544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6' +
  'AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB6' +
  '94B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73';

export const N = BigInt('0x' + PRIME_2048_HEX);
export const G = 2n;
const N_BYTE_LEN = 256;

// 必须与 backend/user_system/srp_helper.py 完全一致
const ARGON2_OPTS = { t: 3, m: 64 * 1024, p: 4, dkLen: 32 } as const;

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2) hex = '0' + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

function bigIntToBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array([0]);
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return hexToBytes(hex);
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n;
  return BigInt('0x' + bytesToHex(bytes));
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function pad(x: bigint): Uint8Array {
  const xb = bigIntToBytes(x);
  if (xb.length === N_BYTE_LEN) return xb;
  const out = new Uint8Array(N_BYTE_LEN);
  out.set(xb, N_BYTE_LEN - xb.length);
  return out;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  if (base < 0n) base += mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

type HashArg = bigint | string | Uint8Array;

function argToBytes(a: HashArg): Uint8Array {
  if (typeof a === 'bigint') return bigIntToBytes(a);
  if (typeof a === 'string') return utf8(a);
  if (a instanceof Uint8Array) return a;
  throw new TypeError('unsupported hash input: ' + typeof a);
}

/** SHA-256 over args concat'd with optional joiner; returns Uint8Array */
function Hbytes(args: HashArg[], joiner = ''): Uint8Array {
  const joinerBytes = joiner ? utf8(joiner) : null;
  const parts: Uint8Array[] = [];
  for (let i = 0; i < args.length; i++) {
    if (i > 0 && joinerBytes) parts.push(joinerBytes);
    parts.push(argToBytes(args[i]));
  }
  return sha256(concat(...parts));
}

/** Same, but returns BigInt (≈ srptools.context.hash() default mode) */
function Hint(args: HashArg[]): bigint {
  return bytesToBigInt(Hbytes(args));
}

let _kCache: bigint | null = null;
function getK(): bigint {
  if (_kCache === null) _kCache = Hint([N, pad(G)]);
  return _kCache;
}

/**
 * srp_password = argon2id(plaintext, salt) hex 输出。
 * 走 native（react-native-argon2 → Argon2Swift / argon2kt），~几百毫秒。
 */
export async function deriveSrpPassword(plaintext: string, saltHex: string): Promise<string> {
  const { rawHash } = await argon2(plaintext, saltHex, {
    iterations: ARGON2_OPTS.t,
    memory: ARGON2_OPTS.m,
    parallelism: ARGON2_OPTS.p,
    hashLength: ARGON2_OPTS.dkLen,
    mode: 'argon2id',
    saltEncoding: 'hex',
  });
  return rawHash;
}

export function generateSaltHex(): string {
  const b = new Uint8Array(16);
  const grv = global.crypto?.getRandomValues;
  if (typeof grv !== 'function') {
    throw new Error('crypto.getRandomValues unavailable (need react-native-get-random-values polyfill)');
  }
  grv.call(global.crypto, b);
  return bytesToHex(b);
}

export function computeVerifier(userId: string, srpPasswordHex: string, saltHex: string): string {
  const innerHash = Hbytes([userId, srpPasswordHex], ':');
  const x = Hint([hexToBytes(saltHex), innerHash]);
  const v = modPow(G, x, N);
  return bytesToHex(bigIntToBytes(v));
}

export class SrpClientSession {
  private userId: string;
  private srpPasswordHex: string;
  private _A: bigint | null = null;
  private _K: Uint8Array | null = null;
  private _M1: Uint8Array | null = null;
  private _expectedM2: Uint8Array | null = null;

  constructor(userId: string, srpPasswordHex: string) {
    this.userId = userId;
    this.srpPasswordHex = srpPasswordHex;
  }

  computeProof(saltHex: string, B_hex: string): { A_hex: string; M1_hex: string } {
    const salt = hexToBytes(saltHex);
    const B = BigInt('0x' + B_hex);
    if (B % N === 0n) throw new Error('invalid server public B');

    const aBytes = new Uint8Array(128);
    const grv = global.crypto?.getRandomValues;
    if (typeof grv !== 'function') throw new Error('crypto.getRandomValues unavailable');
    grv.call(global.crypto, aBytes);
    const a = bytesToBigInt(aBytes);
    this._A = modPow(G, a, N);

    const u = Hint([pad(this._A), pad(B)]);
    if (u === 0n) throw new Error('invalid u');

    const innerHash = Hbytes([this.userId, this.srpPasswordHex], ':');
    const x = Hint([salt, innerHash]);

    const k = getK();
    let base = (B - (k * modPow(G, x, N)) % N) % N;
    if (base < 0n) base += N;
    const S = modPow(base, a + u * x, N);
    this._K = Hbytes([S]);

    const Hn_int = Hint([N]);
    const Hg_int = Hint([G]);
    const Hi_int = Hint([this.userId]);
    const Hng_xor = bigIntToBytes(Hn_int ^ Hg_int);
    const Hi_bytes = bigIntToBytes(Hi_int);

    this._M1 = Hbytes([Hng_xor, Hi_bytes, salt, this._A, B, this._K]);

    this._expectedM2 = Hbytes([this._A, this._M1, this._K]);

    return {
      A_hex: bytesToHex(bigIntToBytes(this._A)),
      M1_hex: bytesToHex(this._M1),
    };
  }

  verifyServerProof(M2_hex: string): boolean {
    if (!this._expectedM2) return false;
    const got = hexToBytes(M2_hex);
    if (got.length !== this._expectedM2.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got[i] ^ this._expectedM2[i];
    return diff === 0;
  }
}

// --- RSA-OAEP envelope（boss recovery 后门）---
//
// 与 backend/user_system/envelope.py + Web SDK 互通：RSA-4096 OAEP，
// MGF1=SHA-256, hash=SHA-256, label=None。
// 每次加密结果不同（OAEP 内置随机），所以拖库者看不出密码碰撞。

export function encryptEnvelope(plaintextPassword: string, pubkeyPem: string): string {
  const pubkey = forge.pki.publicKeyFromPem(pubkeyPem);
  // forge encrypt 的 plaintext 形态是 binary string，不是 Uint8Array
  const binary = forge.util.encodeUtf8(plaintextPassword);
  const ct = pubkey.encrypt(binary, 'RSA-OAEP', {
    md: forge.md.sha256.create(),
    mgf1: { md: forge.md.sha256.create() },
  });
  return forge.util.encode64(ct);
}

/** RSA-OAEP(bytes, pubkey) → base64。给 K_user envelope (Tier 3 recovery) 用。 */
export function encryptEnvelopeBytes(plaintextBytes: Uint8Array, pubkeyPem: string): string {
  const pubkey = forge.pki.publicKeyFromPem(pubkeyPem);
  let bin = '';
  for (let i = 0; i < plaintextBytes.length; i++) bin += String.fromCharCode(plaintextBytes[i]);
  const ct = pubkey.encrypt(bin, 'RSA-OAEP', {
    md: forge.md.sha256.create(),
    mgf1: { md: forge.md.sha256.create() },
  });
  return forge.util.encode64(ct);
}

// =====================================================================
// Phase 1：用户数据加密体系（K_user / KDK / AES-GCM）
// 与 FlowUserSystemSDK/core/data_crypto.js + backend/data_crypto/aes.py
// 字节级互通（已 round-trip 过）。
// =====================================================================

const KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KDK_INFO_PREFIX = 'kuser/';

function bytesToBase64Local(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // RN 全局有 btoa（Hermes 提供）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (global as any).btoa(bin);
}

function base64ToBytesLocal(b64: string): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bin = (global as any).atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  return bytesToBase64Local(bytes);
}

export function base64ToBytes(b64: string): Uint8Array {
  return base64ToBytesLocal(b64);
}

/**
 * KDK = HKDF-SHA256(IKM=srp_password, salt=SRP salt, info='kuser/' + userId, 32)
 * SRP server 知道 verifier 反推不出 srp_password（离散对数），所以也算不出 KDK。
 */
export function deriveKDK(srpPasswordHex: string, saltHex: string, userId: string): Uint8Array {
  const ikm = hexToBytes(srpPasswordHex);
  const salt = hexToBytes(saltHex);
  const info = utf8(KDK_INFO_PREFIX + userId);
  return hkdf(sha256, ikm, salt, info, KEY_LEN);
}

export function generateKUser(): Uint8Array {
  const b = new Uint8Array(KEY_LEN);
  const grv = global.crypto?.getRandomValues;
  if (typeof grv !== 'function') {
    throw new Error('crypto.getRandomValues unavailable (need react-native-get-random-values polyfill)');
  }
  grv.call(global.crypto, b);
  return b;
}

/** AES-256-GCM 加密。输出 nonce(12) || ct || tag(16)。 */
export function aesGcmEncrypt(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== KEY_LEN) throw new TypeError(`key must be ${KEY_LEN} bytes`);
  const nonce = new Uint8Array(NONCE_LEN);
  const grv = global.crypto?.getRandomValues;
  if (typeof grv !== 'function') throw new Error('crypto.getRandomValues unavailable');
  grv.call(global.crypto, nonce);
  const keyStr = forge.util.createBuffer(forge.util.binary.raw.encode(key));
  const cipher = forge.cipher.createCipher('AES-GCM', keyStr);
  cipher.start({
    iv: forge.util.createBuffer(forge.util.binary.raw.encode(nonce)),
    tagLength: TAG_LEN * 8,
  });
  cipher.update(forge.util.createBuffer(forge.util.binary.raw.encode(plaintext)));
  cipher.finish();
  const ct = forge.util.binary.raw.decode(cipher.output.getBytes());
  const tag = forge.util.binary.raw.decode(cipher.mode.tag.getBytes());
  return concat(nonce, ct, tag);
}

export function aesGcmDecrypt(blob: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== KEY_LEN) throw new TypeError(`key must be ${KEY_LEN} bytes`);
  if (blob.length < NONCE_LEN + TAG_LEN) throw new Error('blob too short');
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  const keyStr = forge.util.createBuffer(forge.util.binary.raw.encode(key));
  const decipher = forge.cipher.createDecipher('AES-GCM', keyStr);
  decipher.start({
    iv: forge.util.createBuffer(forge.util.binary.raw.encode(nonce)),
    tag: forge.util.createBuffer(forge.util.binary.raw.encode(tag)),
    tagLength: TAG_LEN * 8,
  });
  decipher.update(forge.util.createBuffer(forge.util.binary.raw.encode(ct)));
  const ok = decipher.finish();
  if (!ok) throw new Error('AES-GCM auth tag verification failed');
  return forge.util.binary.raw.decode(decipher.output.getBytes());
}

export function wrapKUser(kUser: Uint8Array, kdk: Uint8Array): string {
  return bytesToBase64Local(aesGcmEncrypt(kUser, kdk));
}

export function unwrapKUser(blobB64: string, kdk: Uint8Array): Uint8Array {
  return aesGcmDecrypt(base64ToBytesLocal(blobB64), kdk);
}

// =====================================================================
// K_conv (per-conversation) helpers
// 与 FlowUserSystemSDK/core/data_crypto.js + backend/conversation_system/message_crypto.py
// 字节级互通。
// =====================================================================

/** k_conv_blob (base64) + K_user → K_conv 字节。 */
export function deriveKConvFromBlob(kConvBlobB64: string, kUserBytes: Uint8Array): Uint8Array {
  if (!kConvBlobB64 || kUserBytes.length !== KEY_LEN) {
    throw new Error('deriveKConvFromBlob: invalid inputs');
  }
  const blob = base64ToBytesLocal(kConvBlobB64);
  const kConv = aesGcmDecrypt(blob, kUserBytes);
  if (kConv.length !== KEY_LEN) throw new Error('K_conv must be 32 bytes');
  return kConv;
}

/** K_conv → RSA-OAEP-SHA256(transport.pub) → base64。每次 chat_v2 POST 都重算。 */
export function wrapKConvForWire(kConvBytes: Uint8Array, transportPubPem: string): string {
  if (kConvBytes.length !== KEY_LEN) throw new Error('wrapKConvForWire: K_conv invalid');
  const pub = forge.pki.publicKeyFromPem(transportPubPem);
  let bin = '';
  for (let i = 0; i < kConvBytes.length; i++) bin += String.fromCharCode(kConvBytes[i]);
  const ct = pub.encrypt(bin, 'RSA-OAEP', {
    md: forge.md.sha256.create(),
    mgf1: { md: forge.md.sha256.create() },
  });
  return forge.util.encode64(ct);
}

/** message dict 解密 content_ciphertext / tool_calls_ciphertext / reasoning_*_ciphertext。 */
export function decryptMessageLocal(
  msg: Record<string, unknown>,
  kConvBytes: Uint8Array,
): Record<string, unknown> {
  if (!msg || typeof msg !== 'object') return msg;
  const out: Record<string, unknown> = { ...msg };
  const fields: Array<[string, string]> = [
    ['content', 'content_ciphertext'],
    ['tool_calls', 'tool_calls_ciphertext'],
    ['reasoning_content', 'reasoning_content_ciphertext'],
    ['reasoning_seconds', 'reasoning_seconds_ciphertext'],
  ];
  for (const [plain, ct] of fields) {
    if (typeof out[ct] !== 'string') continue;
    const blobB64 = out[ct] as string;
    delete out[ct];
    try {
      const blob = base64ToBytesLocal(blobB64);
      const pt = aesGcmDecrypt(blob, kConvBytes);
      out[plain] = JSON.parse(new TextDecoder().decode(pt));
    } catch (e) {
      out[plain] = `[encrypted ${plain} — decrypt failed: ${(e as Error)?.message || e}]`;
    }
  }
  return out;
}

/** 单条 SSE chunk 字符串 (data: {...}\n\n)。若 type==='encrypted_chunk' 用 K_conv 解出内层 JSON。 */
export function decryptSseChunkLocal(chunkStr: string, kConvBytes: Uint8Array): string {
  if (typeof chunkStr !== 'string' || !chunkStr.startsWith('data: ')) return chunkStr;
  const body = chunkStr.slice('data: '.length).replace(/\n\n$/, '').trim();
  if (!body) return chunkStr;
  let parsed: { type?: string; ciphertext?: string };
  try { parsed = JSON.parse(body); } catch { return chunkStr; }
  if (!parsed || parsed.type !== 'encrypted_chunk' || !parsed.ciphertext) return chunkStr;
  try {
    const blob = base64ToBytesLocal(parsed.ciphertext);
    const innerPt = aesGcmDecrypt(blob, kConvBytes);
    const innerStr = new TextDecoder().decode(innerPt);
    return `data: ${innerStr}\n\n`;
  } catch {
    return chunkStr;
  }
}

// K_conv 缓存（per conv_id，模块级；进程生命期；logout 时由 SessionContext 清）
const _kConvCache: Map<string, Uint8Array> = new Map();

export function setCachedKConv(convId: string, kConvBytes: Uint8Array): void {
  if (!convId || kConvBytes.length !== KEY_LEN) return;
  _kConvCache.set(String(convId), kConvBytes);
}

export function getCachedKConv(convId: string): Uint8Array | null {
  if (!convId) return null;
  return _kConvCache.get(String(convId)) || null;
}

export function clearCachedKConv(convId?: string): void {
  if (convId) _kConvCache.delete(String(convId));
  else _kConvCache.clear();
}
