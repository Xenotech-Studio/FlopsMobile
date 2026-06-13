//
//  Swift ↔ ObjC 桥接头。
//  react-native-orientation-locker 是静态库 pod（无 module），AppDelegate.swift 里
//  调 Orientation.getOrientation() 做动态屏幕方向控制需要从这里引入。
//
#import <react-native-orientation-locker/Orientation.h>
