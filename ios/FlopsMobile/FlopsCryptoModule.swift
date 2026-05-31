//
//  FlopsCryptoModule.swift
//  FlopsMobile
//
//  原生 AES-256-GCM 解密：把聊天历史的批量解密从 JS(node-forge，Hermes 上极慢，80 条 ~3s)
//  下放到 CryptoKit(硬件加速、快数量级)。
//
//  blocking-sync：JS 侧 decryptMessageLocal 逐字段同步调用（不改异步流程）。原生不可用时 JS 兜底 forge。
//  密文布局与服务端/JS 一致：nonce(12) || ciphertext || tag(16)；明文是 UTF-8 JSON 文本，直接以 String 返回。
//

import Foundation
import React
import CryptoKit

@objc(FlopsCrypto)
class FlopsCryptoModule: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool {
    return false
  }

  /// 解密后明文以 UTF-8 文本返回（消息/标题/SSE 等 JSON 文本用；最省一次 base64）。失败返回 nil。
  @objc(decryptAesGcmUtf8:blobB64:)
  func decryptAesGcmUtf8(_ keyB64: String, blobB64: String) -> String? {
    guard let pt = Self.decryptRaw(keyB64, blobB64) else { return nil }
    return String(data: pt, encoding: .utf8)
  }

  /// 解密后明文以 base64 字节返回（二进制场景：密钥解包 K_conv/K_user 等，不能当文本）。失败返回 nil。
  @objc(decryptAesGcmBase64:blobB64:)
  func decryptAesGcmBase64(_ keyB64: String, blobB64: String) -> String? {
    guard let pt = Self.decryptRaw(keyB64, blobB64) else { return nil }
    return pt.base64EncodedString()
  }

  /// - Parameters:
  ///   - keyB64: base64 的 32 字节 AES-256 key
  ///   - blobB64: base64 的 nonce(12)||ct||tag(16)
  /// - Returns: 解密后的明文字节；失败返回 nil
  private static func decryptRaw(_ keyB64: String, _ blobB64: String) -> Data? {
    guard
      let keyData = Data(base64Encoded: keyB64),
      let blob = Data(base64Encoded: blobB64),
      keyData.count == 32,
      blob.count >= 12 + 16
    else {
      return nil
    }
    do {
      let nonce = try AES.GCM.Nonce(data: blob.subdata(in: 0..<12))
      let tag = blob.subdata(in: (blob.count - 16)..<blob.count)
      let ct = blob.subdata(in: 12..<(blob.count - 16))
      let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ct, tag: tag)
      return try AES.GCM.open(box, using: SymmetricKey(data: keyData))
    } catch {
      return nil
    }
  }
}
