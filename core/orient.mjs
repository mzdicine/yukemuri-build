// 横竖屏 / 防偷窥模式（BOARD E6，UI_SPEC §13）。
// 竖屏：<html data-layout="portrait">；图像层（.stage 内背景/立绘/CG/差分/tint）按 16:9 等比缩小放在上方，
// filter: brightness(var(--portrait-dim))；文字和 UI 不缩放、放在下方、亮度正常（版面见 web/portrait.css）。
// --portrait-dim = 设置里的「竖屏亮度」（0.1–1，默认 0.3；制作人 2026-11-04 17:56 放宽）；--stage-brightness 为派生值：竖屏 = --portrait-dim，横屏 = 1。
export const PRIVACY_BRIGHTNESS = 0.3; // 默认竖屏亮度（新玩家）；存档里的旧值照常读
export const DIM_MIN = 0.1, DIM_MAX = 1;
export const clampDim = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(DIM_MAX, Math.max(DIM_MIN, Math.round(n * 100) / 100)) : PRIVACY_BRIGHTNESS; };

/** 纯函数：由视口算出布局模式和图像亮度（smoke 也用） */
export function orientState(vw, vh, dim = PRIVACY_BRIGHTNESS) {
  const portrait = vh > vw;
  return { layout: portrait ? 'portrait' : 'landscape', brightness: portrait ? clampDim(dim) : 1 };
}

/** 浏览器：监听视口方向，写 data-layout、--portrait-dim、--stage-brightness；返回 { apply, stop } */
export function watchOrientation(root = document.documentElement, onChange = null, getDim = () => PRIVACY_BRIGHTNESS) {
  const apply = () => {
    const s = orientState(window.innerWidth, window.innerHeight, getDim());
    root.dataset.layout = s.layout;
    root.style.setProperty('--portrait-dim', String(clampDim(getDim())));
    root.style.setProperty('--stage-brightness', String(s.brightness));
    onChange?.(s);
  };
  apply();
  window.addEventListener('resize', apply);
  return { apply, stop: () => window.removeEventListener('resize', apply) };
}
