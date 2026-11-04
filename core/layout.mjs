// 布局计算：1280×720 逻辑分辨率等比缩放 + 黑边；安全区；热区下限（真实 ≥44 CSS px）。浏览器与 smoke 共用。
import { DEFAULTS } from './defaults.mjs';

export const W = 1280, H = 720;

/**
 * @param {number} vw 视口宽（CSS px）
 * @param {number} vh 视口高
 * @param {{top?:number,right?:number,bottom?:number,left?:number}} inset 系统安全区（CSS px）
 */
export function computeLayout(vw, vh, inset = {}) {
  const scale = Math.min(vw / W, vh / H);
  const cssW = W * scale, cssH = H * scale;
  const offX = (vw - cssW) / 2, offY = (vh - cssH) / 2;
  // 系统安全区换算到逻辑坐标（黑边已经吃掉一部分）
  const sys = {
    left: Math.max(0, (inset.left || 0) - offX) / scale,
    right: Math.max(0, (inset.right || 0) - offX) / scale,
    top: Math.max(0, (inset.top || 0) - offY) / scale,
    bottom: Math.max(0, (inset.bottom || 0) - offY) / scale,
  };
  const safe = {
    left: Math.max(DEFAULTS.safeInset.x, sys.left),
    right: Math.max(DEFAULTS.safeInset.x, sys.right),
    top: Math.max(DEFAULTS.safeInset.y, sys.top),
    bottom: Math.max(DEFAULTS.safeInset.y, sys.bottom),
  };
  const hot = Math.max(DEFAULTS.baseButton, Math.ceil(DEFAULTS.minHotspotCss / scale));
  const portrait = vh > vw;
  return { vw, vh, scale, cssW, cssH, offX, offY, safe, hot, portrait };
}

/** 主界面布局（逻辑坐标，按 UI_SPEC §1）：文字框、名字栏、文本区、7 个快捷按钮。用于渲染和 smoke 校验。 */
export const QUICK = ['skip', 'auto', 'log', 'save', 'load', 'config', 'hide'];
export function hotspots(L) {
  const { safe, hot } = L;
  const gap = 8;
  const out = [];
  const textbox = { id: 'textbox', x: 0, y: 520, w: W, h: 200 };
  const text = { id: 'text', x: Math.max(120, safe.left), y: 560, w: 0, h: Math.min(130, H - safe.bottom - 560) };
  text.w = W - Math.max(120, safe.right) - text.x;
  // 快捷按钮一排，右对齐到安全区；底边贴文本区上沿（小屏按钮放大时向上长）
  // 竖屏等极小缩放下热区放大很多：一排放不下（会压住名字栏）就折成多排，右对齐、自下而上
  const name = { id: 'namebox', x: Math.max(96, safe.left), y: 488, w: 280, h: 52 };
  let perRow = QUICK.length;
  const fits = (k) => W - safe.right - (k * hot + (k - 1) * gap) >= name.x + 160 + gap;
  while (perRow > 1 && !fits(perRow)) perRow--;
  const rows = Math.ceil(QUICK.length / perRow);
  const rowW = perRow * hot + (perRow - 1) * gap;
  const x0 = W - safe.right - rowW;
  QUICK.forEach((n, i) => {
    const r = Math.floor(i / perRow), c = i % perRow;
    out.push({ id: n, x: x0 + c * (hot + gap), y: text.y - 4 - hot - (rows - 1 - r) * (hot + gap), w: hot, h: hot });
  });
  if (name.x + name.w > x0 - gap) name.w = Math.max(160, x0 - gap - name.x);
  return [...out, textbox, name, text];
}

/** 标题菜单按钮：右侧竖排 360×64（高度至少 hot） */
export function titleRects(L, n) {
  const { safe, hot } = L;
  const h = Math.max(64, hot), gap = 12, w = 360;
  // 竖屏缩得很小时一列放不下就分多列（从右往左）
  const avail = H - safe.top - safe.bottom;
  const perCol = Math.max(1, Math.min(n, Math.floor((avail + gap) / (h + gap))));
  const cols = Math.ceil(n / perCol);
  const total = perCol * h + (perCol - 1) * gap;
  const y0 = Math.max(safe.top, (H - total) / 2);
  return Array.from({ length: n }, (_, i) => {
    const c = Math.floor(i / perCol), r = i % perCol;
    return { x: W - safe.right - w - (cols - 1 - c) * (w + gap), y: y0 + r * (h + gap), w, h };
  });
}

/** 选项按钮布局（最多 3 个，超出也能排） */
export function choiceRects(L, n, hstyle = false) {
  const { safe, hot } = L;
  const h = Math.max(72, hot);
  const gap = 20;
  const w = Math.min(720, W - safe.left - safe.right);
  const total = n * h + (n - 1) * gap;
  // 普通选项：中央；H 中途选项：画面下 1/3（由调用方传 hstyle）
  const y0 = Math.max(safe.top, (520 - total) / 2);
  const yy = hstyle ? Math.max(safe.top, Math.min(H * 2 / 3 - 40, 520 - 8 - total)) : y0;
  return Array.from({ length: n }, (_, i) => ({ x: (W - w) / 2, y: yy + i * (h + gap), w, h }));
}

export function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * 竖屏版面（UI_SPEC §13，CSS px，不随 1280 基准缩放）。浏览器和 smoke 共用。
 * 自上而下：顶部安全区 → stage（宽 100vw，高 = 宽×9/16）→ HUD 48 → 文字面板 → 快捷栏 56 + 底部安全区。
 */
export const PORTRAIT = { hud: 48, quick: 56, side: 12, pad: 16, nameFont: 18, bodyFont: 17, choiceH: 56, choiceGap: 12, narrowBelow: 352, minW: 320 };
export const QUICK_NARROW = ['skip', 'auto', 'log', 'save', 'config']; // config 在窄屏充当“菜单”（内含 读档 / 设置 / 隐藏）
export function portraitLayout(vw, vh, inset = {}) {
  const top = inset.top || 0, bottom = inset.bottom || 0;
  const stage = { x: 0, y: top, w: vw, h: vw * 9 / 16, scale: vw / W };
  const hud = { x: 0, y: stage.y + stage.h, w: vw, h: PORTRAIT.hud };
  const quickY = vh - bottom - PORTRAIT.quick;
  const panel = { x: 0, y: hud.y + hud.h, w: vw, h: quickY - (hud.y + hud.h) };
  const narrow = vw < PORTRAIT.narrowBelow;
  const ids = narrow ? QUICK_NARROW : QUICK;
  const qw = vw / ids.length;
  const quick = ids.map((id, i) => ({ id, x: i * qw, y: quickY, w: qw, h: PORTRAIT.quick }));
  const choices = (n) => Array.from({ length: Math.min(n, 4) }, (_, i) => ({ x: PORTRAIT.pad, y: panel.y + PORTRAIT.pad + i * (PORTRAIT.choiceH + PORTRAIT.choiceGap), w: vw - 32, h: PORTRAIT.choiceH }));
  return { vw, vh, stage, hud, panel, quick, narrow, choices, safeBottom: bottom, safeTop: top };
}
