//
//  FlopsCryptoModule.m
//  FlopsMobile
//
//  Objective-C bridge：把 Swift 类 FlopsCryptoModule 暴露给 React Native。
//  decryptAesGcmUtf8 是 blocking-sync（JS 侧逐字段同步调用）。
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(FlopsCrypto, NSObject)

RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(decryptAesGcmUtf8:(NSString *)keyB64
                                               blobB64:(NSString *)blobB64)

RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(decryptAesGcmBase64:(NSString *)keyB64
                                                 blobB64:(NSString *)blobB64)

@end
