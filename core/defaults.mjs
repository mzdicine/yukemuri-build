// 引擎默认值表（时长 ms）。数值来自 docs/STAGING.md / docs/UI_SPEC.md / art/bg/drafts/NOTES.md。
export const DEFAULTS = {
  logicalW: 1280, logicalH: 720,
  bgTrans: { crossfade: 800, fade: 600, wipe: 700, white: 400, black: 1500, none: 0 },
  bgTransDefault: 'crossfade',
  blackHold: 500,
  charIn: 300, charExprChange: 120, charOut: 300, slidePx: 120,
  cgTrans: 800, cgDiffTrans: 300,
  daynight: 2000,
  shake: { s: { amp: 6, dur: 300 }, m: { amp: 14, dur: 300 }, l: { amp: 28, dur: 300 } }, // 震屏幅度 px / 默认时长 ms（main.js shake() 读这里；@shake dur= 可覆盖）
  flash: { white: '#ffffff', pink: '#f2a7b8', red: '#c0262d', dur: 200 },
  bgmFade: 1000,
  ambientVol: 0.6,
  // tint=dusk：结衣 NOTES 参考参数——multiply 竖向渐变 顶(255,170,150)→底(255,210,110)，再叠 screen (255,140,110) 18%，整体亮度 ×0.95
  tints: {
    dusk: { multiply: ['rgb(255,170,150)', 'rgb(255,210,110)'], screen: 'rgba(255,140,110,0.18)', brightness: 0.95 },
  },
  danger: {
    levels: [ // 0–39 / 40–79 / 80–100
      { min: 0, vignette: 0.20, bpm: 60, shake: null, bgmDuck: 1 },
      { min: 40, vignette: 0.45, bpm: 100, shake: 's', bgmDuck: 1 },
      { min: 80, vignette: 0.70, bpm: 140, shake: 's', bgmDuck: 0.2 },
    ],
    kinds: { knock: 'se_knock', voice: 'se_husband_turn', phone: 'se_phone_vibe', snore: 'amb_nextdoor_snore' },
    upSe: 'se_danger_up', clearSe: 'se_danger_clear', heartbeat: 'se_heartbeat_loop',
    // 心跳：AUDIO_SPEC 未单列阈值；按 STAGING §6（0–39 档即有 60bpm 慢心跳）= 危险事件进行中且 danger ≥ 1 就响，播放速率随档位
    heartbeatMin: 1,
    holdBreathMs: 2000,
  },
  hud: { popMs: 2000, popMsPortrait: 1500, levels: 5 }, // UI_SPEC §13.5：横屏 2000 / 竖屏 1500
  // H 高潮特效（STAGING §12）。坐标为逻辑 1280×720；特效一律 y ≤ maxY（文字框上沿以上）
  hfx: {
    maxY: 500, fadeStop: 600, swapMs: 400,
    hearts: {
      1: { max: [8, 12], rate: 3, speed: [40, 70], size: [20, 44], alpha: [0.55, 0.85], sway: 12, swayT: 2500, life: 4500 },
      2: { max: [20, 28], rate: 7, speed: [60, 100], size: [24, 64], alpha: [0.65, 0.95], sway: 18, swayT: 2000, life: 3800 },
      3: { max: [40, 56], rate: 14, speed: [90, 150], size: [28, 96], alpha: [0.7, 1.0], sway: 24, swayT: 1600, life: 3200 },
    },
    heartWeights: { a: 3, b: 3, c: 3, d: 1 }, heartDMinLv: 2, burstEvery: 1200, burstN: [3, 5],
    areaDefault: 'edges', edgeFrac: 0.22, lowerY: [360, 520],
    staticHearts: 6,
    moan: {
      1: { size: [40, 48], white: 4, red: 1.5, blur: 6, glow: 0.45, tilt: 6, inMs: 250, hold: 1200, outMs: 500, jitter: 2 },
      2: { size: [52, 60], white: 5, red: 2, blur: 8, glow: 0.6, tilt: 9, inMs: 200, hold: 1100, outMs: 450, jitter: 2 },
      3: { size: [64, 76], white: 6, red: 2.5, blur: 12, glow: 0.75, tilt: 12, inMs: 150, hold: 1000, outMs: 400, jitter: 4 },
    },
    moanMax: { 1: 2, 2: 3, 3: 4 }, moanEdge: [24, 48], moanSlide: 24, moanMaxLen: 8, clearMs: 300,
    burstDefault: { n: 3, lang: 'mix', gap: 350 },
    words: {
      ja: ['はぁ♡', 'んっ♡', 'あっ♡', 'ふぁ…♡', 'んぅ…♡', 'はぁっ♡', 'やぁ…♡', 'あぁ…♡'],
      zh: ['哈啊♡', '嗯…♡', '不行…♡', '好舒服♡', '啊…♡', '嗯啊♡', '等…♡', '呜…♡'],
    },
    positions: ['l', 'r', 'lt', 'rt', 'lb', 'rb'], moanTopY: 84, // 避脸：去掉 t/b（STAGING §12）
  },
  // 故意不出图的素材（制作人定）：build 不算缺图，运行时不请求、不显示占位
  noArt: ['art/chara/hitozuma_ring.png'],
  backlogMax: 200,
  saveSlotsPerPage: 6, savePages: 10, autoSlots: 3,
  textSpeed: 40,      // 字/秒
  autoWait: 1500,     // 自动模式：文本显示完后等待
  autoPerChar: 60,
  minHotspotCss: 44,
  baseButton: 56,
  safeInset: { x: 64, y: 24 },
  titleBgm: 'bgm_title',
  recallBgm: 'bgm_title',
  titleBg: 'bg_rotenburo_night',
  unlockSe: 'se_unlock',
  ui: { click: 'se_ui_click', confirm: 'se_ui_confirm', cancel: 'se_ui_cancel' },
  // 句末语气词（INTERJ_SPEC_DRAFT 附录 A）。素材 audio/interj/<角色>/<角色>_<情绪>_<两位>.ogg，build 自动登记到 game.json assets.interj
  interj: {
    chars: ['hitozuma', 'okami', 'gal', 'bucho'],
    // 映射值写 'none' = 这类表情不配语气词（不会去找名为 none 的素材）
    // 日常映射：千寻第一份清单（18:3x）覆盖；'none' = 不配。映射到但该角色没有素材的情绪 → 静默不播（按 game.json 实际登记的素材判断）
    map: {
      hitozuma: { smile: 'none', demure: 'none', _default: 'none', tease: 'none', smugnr: 'none', surrender: 'none', heated: 'none',
        smug: 'laugh', surprised: 'surprise', dazed: 'think', hairflip: 'tease' },
      okami: { smile: 'none', knowing: 'none', _default: 'none', apologetic: 'sorry', wink: 'knowing' },
      gal: { smile: 'none', _default: 'none', stutter: 'none', pout: 'none', heated: 'none', tongue: 'none', smug: 'none',
        freeze: 'surprise', cling: 'amae', grin: 'tease', dazed: 'think' },
      bucho: { smile: 'none', blank: 'none', beam: 'none', cover: 'none', heated: 'none', _default: 'none',
        realize: 'surprise', panic: 'surprise', peek: 'amae', dazed: 'think' },
    },
    mapH: { // H 块内覆盖（未列出的沿用 map）
      hitozuma: { heated: 'moan', surrender: 'moan', dazed: 'moan', _default: 'moan', smile: 'breath', demure: 'breath' },
      gal: { heated: 'moan', cling: 'moan', dazed: 'moan', _default: 'moan', smile: 'affirm' },
      // 社长 H：捂住身体（cover/panic）= 暂停，不配 moan
      bucho: { smile: 'amae', beam: 'affirm', cover: 'surprise', panic: 'surprise', peek: 'amae', heated: 'moan', dazed: 'moan', _default: 'moan' },
    },
    hOnly: ['moan'], // 只在 H 块内用的情绪（块外写 @interj moan → build 警告）；以后加 moan_hard / climax 只改这里和映射即可（情绪名可含下划线）
    questionRe: /[？?]\s*$/,
    endsWithInterjRe: /(^|[。！？!?…—\s])[嗯唔呜啊哈呵哼诶欸哎唉嗐哦呃嘻嘿切]+[。！？!?～~…—\s]*$/,
    gain: 0.9, everyN: 1, minGapMs: 0, inDanger: false, inH: true, fadeOutMs: 60,
  },
  // 通用叠加层（E-fxlayer / E-fxsteam，STAGING §13.3）
  fxlayer: {
    // 立绘 fx=<名> / CG +<名>（无 art/cg/<cgid>_<名>.png 时）回退用的通用叠加图
    // 查找顺序（统筹 19:00 定）：art/ui/fx/fx_<层>_<cg>_<差分>.png → art/cg/<cg>_<层>.png → art/ui/fx/fx_<层>_<cg>.png → 下面的通用图
    // 差分专用 fx 优先（结衣版夸张红晕）；无差分（如鉴赏）照样回落到 art/cg 通用层
    cgFx: (l, id, diff) => [...(diff ? [`art/ui/fx/fx_${l}_${id}_${diff}.png`] : []), `art/cg/${id}_${l}.png`, `art/ui/fx/fx_${l}_${id}.png`],
    blend: { blush: 'multiply' }, // 叠层混合模式（CSS mix-blend-mode）
    overlays: { smoke: 'art/ui/fx/fx_smoke_overlay.png', steam: 'art/ui/fx/fx_steam_overlay.png' },
    // 屏幕级 @fx <名> on|off [lv=1-3] [fade=ms]：bg/立绘之上、CG/UI 之下；换 @bg 自动关；进存档
    // 头顶锚定特效 @fx <名> on=<角色> / @char … fx=<名>：art/ui/fx/fx_<名>.png 横向雪碧图；fx_<名>.json 的 frames/size/dur 可覆盖
    anchored: { frames: 8, size: 256, dur: 1500, fadeOutMs: 200, head: [540, 120], canvas: [1080, 1620], file: (n) => `art/ui/fx/fx_${n}.png`, meta: (n) => `art/ui/fx/fx_${n}.json` },
    screen: {
      steam: { tile: 'art/ui/fx/fx_steam_tile.png', overlay: 'art/ui/fx/fx_steam_overlay.png', alpha: [0.5, 0.75, 1], periodMs: 50000, fadeMs: 800 },
    },
  },
};
