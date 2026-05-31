package com.flopsmobile

import android.util.Base64
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 原生 AES-256-GCM 解密：把聊天历史的批量解密从 JS(node-forge，Hermes 上极慢，80 条 ~3s)
 * 下放到平台 crypto(javax.crypto，硬件加速、快数量级)。
 *
 * blocking-sync：JS 侧 decryptMessageLocal 逐字段同步调用（不改异步流程）。原生不可用时 JS 兜底 forge。
 * 密文布局与服务端/JS 一致：nonce(12) || ciphertext || tag(16)；明文是 UTF-8 JSON 文本，直接以 String 返回。
 */
class FlopsCryptoModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "FlopsCrypto"

  /** 解密后明文以 UTF-8 文本返回（消息/标题/SSE 等 JSON 文本用；最省一次 base64）。失败返回 null。 */
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun decryptAesGcmUtf8(keyB64: String, blobB64: String): String? {
    val pt = decryptRaw(keyB64, blobB64) ?: return null
    return String(pt, Charsets.UTF_8)
  }

  /** 解密后明文以 base64 字节返回（二进制场景：密钥解包 K_conv/K_user 等，不能当文本）。失败返回 null。 */
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun decryptAesGcmBase64(keyB64: String, blobB64: String): String? {
    val pt = decryptRaw(keyB64, blobB64) ?: return null
    return Base64.encodeToString(pt, Base64.NO_WRAP)
  }

  /**
   * @param keyB64  base64 的 32 字节 AES-256 key
   * @param blobB64 base64 的 nonce(12)||ct||tag(16)
   * @return 解密后的明文字节；失败返回 null
   */
  private fun decryptRaw(keyB64: String, blobB64: String): ByteArray? {
    return try {
      val key = Base64.decode(keyB64, Base64.DEFAULT)
      val blob = Base64.decode(blobB64, Base64.DEFAULT)
      if (key.size != 32 || blob.size < 12 + 16) return null
      val nonce = blob.copyOfRange(0, 12)
      // javax 的 AES/GCM/NoPadding：doFinal 的输入是 ct||tag（tag 在尾部 16 字节），正好是 blob 去掉 nonce
      val ctAndTag = blob.copyOfRange(12, blob.size)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
      cipher.doFinal(ctAndTag)
    } catch (t: Throwable) {
      null
    }
  }
}
