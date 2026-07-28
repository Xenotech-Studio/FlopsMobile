/**
 * 全局按钮「按压放大」共享 spring 物理参数——以 ChatScreen composer 卡片调好的手感为基准。
 * scale 目标值由各按钮自定（1.03 / 1.1 / 1.4 …），这里只统一物理参数。
 */
export const PRESS_SPRING_CONFIG = { mass: 0.3, stiffness: 600, damping: 20 };
