//
//  FlopsPushModule.m
//  FlopsMobile
//
//  Objective-C bridge：将 Swift 类 FlopsPushModule 暴露给 React Native。
//

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(FlopsPushModule, RCTEventEmitter)

RCT_EXTERN_METHOD(requestPermission:(RCTPromiseResolveBlock)resolve
                          rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getAuthorizationStatus:(RCTPromiseResolveBlock)resolve
                                rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(registerSilently:(RCTPromiseResolveBlock)resolve
                          rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getDeviceToken:(RCTPromiseResolveBlock)resolve
                       rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getBundleIdentifier:(RCTPromiseResolveBlock)resolve
                             rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getPendingDeepLink:(RCTPromiseResolveBlock)resolve
                            rejecter:(RCTPromiseRejectBlock)reject)

@end
