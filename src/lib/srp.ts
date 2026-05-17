/**
 * SRP-6a 客户端 + argon2id 客户端预哈希。Mobile (Hermes) 版，与后端
 * backend/user_system/srp_helper.py 字节级互通。
 *
 * 全纯 JS（无 native module）：
 *   - SHA-256: @noble/hashes/sha2
 *   - argon2id: @noble/hashes/argon2 （已与 Python argon2-cffi 字节对齐验证）
 *   - getRandomValues: 由 react-native-get-random-values polyfill 提供
 *   - BigInt: Hermes 原生
 *
 * RSA-OAEP envelope 暂未接入：mobile 这次只切 login；register/change-pwd
 * 仍走旧明文路径，等后续补 node-forge 之类的 RSA pure JS 实现。
 *
 * 字节序与后端一致：BigInt → 大端字节，**去掉前导 0 字节**（对齐 srptools int_to_bytes）。
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';
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
 * 在手机上耗时 ~3-5 秒（纯 JS），用 async 变体让出主线程。
 */
export async function deriveSrpPassword(plaintext: string, saltHex: string): Promise<string> {
  const out = await argon2idAsync(plaintext, hexToBytes(saltHex), ARGON2_OPTS);
  return bytesToHex(out);
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
