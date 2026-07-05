//
//  FlopsAudioModule.m
//  FlopsMobile
//
//  Objective-C bridge：把 Swift 类 FlopsAudioModule（@objc(FlopsAudio)）暴露给 React Native。
//  与 FlopsPushModule 同为老式 RCT_EXTERN_MODULE（RN 新架构下经 interop 层照常注册）。
//

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(FlopsAudio, RCTEventEmitter)

RCT_EXTERN_METHOD(loadAndPlay:(NSArray *)segments
                         meta:(NSDictionary *)meta
                     resolver:(RCTPromiseResolveBlock)resolve
                     rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(play:(RCTPromiseResolveBlock)resolve
              rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(pause:(RCTPromiseResolveBlock)resolve
               rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stop:(RCTPromiseResolveBlock)resolve
              rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(playIndex:(nonnull NSNumber *)index
                   resolver:(RCTPromiseResolveBlock)resolve
                   rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getState:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startRealtime:(NSString *)wsUrl
                       resolver:(RCTPromiseResolveBlock)resolve
                       rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopRealtime:(RCTPromiseResolveBlock)resolve
                      rejecter:(RCTPromiseRejectBlock)reject)

@end
