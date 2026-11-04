// 《湯けむり裏返し》ADV 引擎 v0.1 —— 浏览器渲染 / UI / 音频 / 存档。逻辑在 core/vm.mjs（Node 侧 sim/smoke 共用）。
// 原则：缺素材一律占位（色块 / 静音），绝不因素材缺失崩溃；退出 H 由 VM 清空循环 SE 与环境音，这里只做声明式同步。
import { VM, newSystem, routeUnlocked, cgGroup, hGroup } from './core/vm.mjs';
import { DEFAULTS } from './core/defaults.mjs';
import { computeLayout, hotspots, titleRects, choiceRects, portraitLayout } from './core/layout.mjs';
import { diffAudio, applyActs } from './core/audiosync.mjs';
import { decideInterj, InterjGate } from './core/interj.mjs';
import { watchOrientation, clampDim, PRIVACY_BRIGHTNESS } from './core/orient.mjs';
import { readPakIndex, slicePak } from './core/pak.mjs';

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------- 存储 ----------------
const LS = 'onsen1.';
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); return true; } catch (e) { console.warn('localStorage 写入失败', e); return false; } },
  del(k) { try { localStorage.removeItem(LS + k); } catch {} },
};
const CFG_DEFAULT = {
  vol: { master: 1, bgm: 0.8, se: 0.9, voice: 1, amb: 0.8 },
  textSpeed: DEFAULTS.textSpeed, autoWait: DEFAULTS.autoWait, autoPerChar: DEFAULTS.autoPerChar,
  skipUnread: false, tbOpacity: 0.85, dangerFx: 'normal', voiceStop: true, interj: true, interjH: true,
  hfx: true, // 「H 特效」开关（STAGING §12.3）
  portraitDim: PRIVACY_BRIGHTNESS, // 「竖屏亮度」0.1–1（UI_SPEC §13.7），写入 --portrait-dim
};
const cfg = Object.assign(structuredClone(CFG_DEFAULT), store.get('cfg', {}));
cfg.vol = Object.assign({}, CFG_DEFAULT.vol, cfg.vol || {});
cfg.portraitDim = clampDim(cfg.portraitDim);
const saveCfg = () => store.set('cfg', cfg);

// ---------------- 载入 ----------------
let game, P, FILES, AUD;
try {
  game = await (await fetch('game.json', { cache: 'no-cache' })).json();
  P = game.program; FILES = new Set(game.assets.files); AUD = game.assets.audio || {};
} catch (e) {
  document.body.innerHTML = '<p style="color:#fff;padding:2em">载入 game.json 失败：请先运行 <code>bash tools/build.sh --web</code>，并用 http 服务器打开 build_web/。</p>';
  throw e;
}
const NOART = new Set(DEFAULTS.noArt || []); // 故意不出图：当作「有意为空」，不请求不占位
const has = (p) => FILES.has(p) && !NOART.has(p);
const NOVOICE = !!game.noVoice; // 无语音版：@voice 跳过，只留语气词
// 包体压缩（N-eng2）：逻辑路径（art/…png）→ 实际输出文件（多为 .webp）；has() 仍按逻辑名判断
const AMAP = game.assets.map || {};
const R = (p) => (p && AMAP[p]) || p;
const INTERJ = game.assets.interj || {};
const PAKS = game.assets.paks || {}; // 语音按场景 / 语气词按角色的 .pak（build 生成）
const PAK_KEEP = 6;
const hasAudio = (id) => !!(AUD[id] && (AUD[id].ogg || AUD[id].m4a));
const interjGate = new InterjGate();
document.body.classList.toggle('noskin', game.assets.uiSkin === false);
// 皮肤图逐张探测（UI_SPEC §12）：有图才加 sk-* 类用图，缺图退回 CSS 样式
const skin = (f) => game.assets.uiSkin !== false && has(`art/ui/${f}.png`);
for (const [cls, f] of [['sk-vignette', 'ui_vignette_red'], ['sk-seen', 'ui_choice_seen'], ['sk-toggle', 'ui_toggle_on'], ['sk-menu-p', 'ui_btn_menu_p'], ['sk-choice-h-p', 'ui_choice_h_p'], ['sk-voice', 'ui_btn_voice_n'], ['sk-voice-p', 'ui_btn_voice_p']]) document.body.classList.toggle(cls, skin(f));
document.body.classList.toggle('sk-slider', skin('ui_slider_bar') && skin('ui_slider_knob'));
const sys = Object.assign(newSystem(), store.get('sys', {}));
const saveSys = () => store.set('sys', sys);
// 多女主路线（SCRIPT_SYNTAX §10）：没声明时只有一条隐式默认路线
const ROUTES = P_routes();
function P_routes() { return game.program.routes?.length ? game.program.routes : [{ id: 'main', title: '', entry: game.program.entry, implicit: true }]; }
const routeTitle = (id) => ROUTES.find((r) => r.id === id)?.title || '';
// 旧系统存档：只有一条路线时，把已有结局补记到该路线
if (ROUTES.length === 1 && !Object.keys(sys.routeEnds || {}).length && Object.keys(sys.endings || {}).length) sys.routeEnds = { [ROUTES[0].id]: { ...sys.endings } };
const charName = (id) => game.program.chars?.[id]?.name || id;
// 分组 tab：只有一个组时不显示（UI_SPEC §13：竖屏热区 ≥44px 由 .tabs .btn 保证）
function orderGroups(gs) { // 标签按路线顺序，其余保持原顺序排在后面
  const rk = (g) => { const i = ROUTES.findIndex((r) => r.id === g || r.heroine === g || r.chara === g); return i < 0 ? 1e6 : i; };
  return gs.map((g, i) => [g, i]).sort((a, b) => rk(a[0]) - rk(b[0]) || a[1] - b[1]).map((x) => x[0]);
}
function groupTabs(screen, groups, cur, reopen) {
  if (groups.length <= 1) return null;
  const tabs = el('div', 'tabs groups'); tabs.setAttribute('role', 'tablist');
  for (const g of groups) { const b = el('button', `btn${g === cur ? ' on' : ''}`, charName(g)); b.dataset.group = g; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(g === cur)); b.onclick = () => { audio.ui('click'); store.set(`grp.${screen}`, g); reopen(g); }; tabs.append(b); }
  return tabs;
}

// ---------------- 资源 / 占位 ----------------
function hue(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; }
function placeholder(label, cls = '') {
  const d = el('div', `ph ${cls}`, label);
  d.style.background = `linear-gradient(135deg, hsl(${hue(label)} 35% 32%), hsl(${(hue(label) + 40) % 360} 35% 18%))`;
  d.dataset.ph = label;
  return d;
}
function img(path, label, cls = '') {
  if (!path || !has(path)) return placeholder(label || path || '?', cls);
  const i = el('img', cls); i.decoding = 'async'; i.draggable = false; i.alt = '';
  i.onerror = () => { const p = placeholder(label || path, cls); p.style.cssText += i.style.cssText; i.replaceWith(p); };
  i.src = R(path);
  return i;
}
const preloaded = new Set();
function preload(path) { if (path && has(path) && !preloaded.has(path)) { preloaded.add(path); const i = new Image(); i.decoding = 'async'; i.src = R(path); } }
// 分场景加载：进入场景时空闲预取它的后继场景（bg/立绘/CG + 音频）；首屏之外的资源都按需取，SW 运行时缓存
const SCENES = game.assets.scenes || {};
const prefetched = new Set();
function prefetchScene(code) {
  const s = SCENES[code]; if (!s || prefetched.has(code)) return; prefetched.add(code);
  const go = () => { for (const f of s.img) preload(f); for (const id of s.aud) audio.prefetch(id); };
  (window.requestIdleCallback || ((f) => setTimeout(f, 300)))(go);
}
let interjPf = false;
function enterScene(code) {
  if (!code) return; prefetchScene(code); for (const n of SCENES[code]?.next || []) prefetchScene(n);
  // 语气词包（按角色，很小）第一次进场景时空闲预取，避免第一声语气词等网络
  if (!interjPf) { interjPf = true; const one = {}; for (const e of Object.values(AUD)) if (e.pak?.startsWith('interj_')) one[e.pak] ||= e.id; (window.requestIdleCallback || ((f) => setTimeout(f, 300)))(() => Object.values(one).forEach((id) => audio.prefetch(id))); }
}

// ---------------- 音频（Web Audio，缺音静音） ----------------
class Audio_ {
  constructor() { this.ctx = null; this.buf = new Map(); this.paks = new Map(); this.pakLog = []; this.loaded = new Map(); this.state = { bgm: null, loops: {}, amb: {} }; this.nodes = { bgm: null, loops: new Map(), amb: new Map() }; this.want = this.state; this.nextFade = null; this.duck = 1; this.breath = 1; this.voiceNode = null; this.rate = 1; }
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      this.ctx = new AC();
      const mk = () => { const g = this.ctx.createGain(); g.connect(this.master); return g; };
      this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination);
      this.g = { bgm: mk(), se: mk(), voice: mk(), amb: mk() };
      this.bgmDuck = this.ctx.createGain(); this.bgmDuck.connect(this.g.bgm);
      this.applyVol();
      this.caps();
      this.state = { bgm: null, loops: {}, amb: {} };
      this.sync(this.want);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }
  applyVol() {
    if (!this.ctx) return; const v = cfg.vol, t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(v.master, t, 0.02);
    for (const k of ['bgm', 'se', 'voice', 'amb']) this.g[k].gain.setTargetAtTime(v[k], t, 0.02);
    this.bgmDuck.gain.setTargetAtTime(this.duck * this.breath, t, 0.15);
  }
  setDuck(d) { this.duck = d; this.applyVol(); }
  holdBreath(ms) { this.breath = 0; this.applyVol(); setTimeout(() => { this.breath = 1; this.applyVol(); }, ms); }
  // ogg 是 Opus（build 转码）或 Vorbis（SE 原样）；不支持的浏览器（iOS 18.4 以前的 Safari）走 .m4a（AAC）
  caps() {
    if (!this.can) { const a = document.createElement('audio'); this.can = { opus: !!a.canPlayType('audio/ogg; codecs="opus"'), vorbis: !!a.canPlayType('audio/ogg; codecs="vorbis"') }; this.canOgg = this.can.opus || this.can.vorbis; }
    return this.can;
  }
  meta(id) { return AUD[id] || null; }
  fmt(id) { const m = this.meta(id); if (!m) return null; this.caps(); return m.ogg && (m.codec === 'opus' ? this.can.opus : m.codec === 'vorbis' ? this.can.vorbis : this.canOgg) ? 'ogg' : m.m4a ? 'm4a' : m.ogg ? 'ogg' : null; }
  url(id) {
    const m = this.meta(id), f = this.fmt(id); if (!f) return null;
    if (m.pak) { const p = PAKS[m.pak] || {}; return p[f] || p.ogg || p.m4a || null; }
    return m[f] || m.ogg || m.m4a || null;
  }
  // 语音/语气词包（engine/core/pak.mjs）：整包 fetch 一次，索引切片；最多留 PAK_KEEP 个包的原始数据（解码结果另存 this.buf）
  pak(u) {
    if (!this.paks.has(u)) {
      const p = fetch(u).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status))).then((ab) => ({ ab, idx: readPakIndex(ab) }));
      p.catch(() => this.paks.delete(u));
      this.paks.set(u, p);
      while (this.paks.size > PAK_KEEP) this.paks.delete(this.paks.keys().next().value);
    } else { const p = this.paks.get(u); this.paks.delete(u); this.paks.set(u, p); } // LRU
    this.pakLog.push(u); if (this.pakLog.length > 50) this.pakLog.shift();
    return this.paks.get(u);
  }
  // 只下载不解码（进场景时预取后继场景的音频；解码留到真正播放）。pak 整包取进内存
  prefetch(id) {
    const u = this.url(id); if (!u) return;
    if (this.meta(id).pak) { this.pak(u).catch(() => {}); return; }
    if (!this.buf.has(u) && !this._pf?.has(u)) { (this._pf ||= new Set()).add(u); fetch(u).catch(() => {}); }
  }
  // 调试 / 测试用：最近一次解码，及每个 id 实际从哪个文件解出来（最多留 200 条）
  note(r) { this.lastLoad = r; this.loaded.delete(r.id); this.loaded.set(r.id, r); if (this.loaded.size > 200) this.loaded.delete(this.loaded.keys().next().value); }
  load(id) {
    if (!this.ctx) return Promise.resolve(null);
    const u = this.url(id); if (!u) return Promise.resolve(null);
    const m = this.meta(id), key = m.pak ? `${u}#${id}` : u;
    if (!this.buf.has(key)) {
      const dec = (ab) => new Promise((res, rej) => this.ctx.decodeAudioData(ab, res, rej));
      const get = (x) => (m.pak
        ? this.pak(x).then(({ ab, idx }) => { const b = slicePak(ab, idx, id); return b ? b : Promise.reject(`pak 里没有 ${id}`); })
        : fetch(x).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))).then(dec).then((b) => { this.note({ id, url: x, ok: true, dur: b.duration }); return b; });
      const alt = m.pak ? PAKS[m.pak]?.m4a : m.m4a;
      this.buf.set(key, get(u)
        .catch((e) => (alt && u !== alt ? get(alt) : Promise.reject(e))) // ogg 解码失败 → m4a（pak）再试一次
        .catch((e) => { this.note({ id, url: u, ok: false, err: String(e) }); console.warn('音频载入失败（静音占位）', id, e); return null; }));
    }
    return this.buf.get(key);
  }
  _start(id, dest, { loop = false, vol = 1, fade = 0, rate = 1 } = {}) {
    const ent = { id, src: null, gain: this.ctx.createGain(), stopped: false, dur: 0 };
    ent.gain.connect(dest);
    const t = this.ctx.currentTime;
    if (fade > 0) { ent.gain.gain.setValueAtTime(0, t); ent.gain.gain.linearRampToValueAtTime(vol, t + fade / 1000); } else ent.gain.gain.value = vol;
    ent.ready = this.load(id).then((b) => {
      if (!b || ent.stopped) return 0;
      const s = this.ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = rate;
      if (loop) {
        s.loop = true; const m = this.meta(id);
        if (m && m.loopLength > 0 && m.sr) { s.loopStart = m.loopStart / m.sr; s.loopEnd = (m.loopStart + m.loopLength) / m.sr; }
      }
      s.connect(ent.gain); s.start(); ent.src = s; ent.dur = b.duration / rate;
      return ent.dur;
    });
    return ent;
  }
  _stop(ent, fade = 0) {
    if (!ent) return; ent.stopped = true;
    const t = this.ctx.currentTime;
    if (fade > 0) { ent.gain.gain.cancelScheduledValues(t); ent.gain.gain.setValueAtTime(ent.gain.gain.value, t); ent.gain.gain.linearRampToValueAtTime(0, t + fade / 1000); }
    const kill = () => { try { ent.src && ent.src.stop(); } catch {} ent.gain.disconnect(); };
    fade > 0 ? setTimeout(kill, fade + 50) : kill();
  }
  // 声明式同步：st.audio 是“应在响”的集合
  sync(want) {
    this.want = JSON.parse(JSON.stringify(want));
    if (!this.ctx) return;
    const acts = diffAudio(this.state, this.want);
    const fade = view.fast ? 0 : (this.nextFade ?? 800); this.nextFade = null;
    for (const a of acts) {
      if (a.ch === 'bgm') {
        if (a.act === 'stop') { this._stop(this.nodes.bgm, fade); this.nodes.bgm = null; }
        else if (a.act === 'play') this.nodes.bgm = this._start(a.id, this.bgmDuck, { loop: true, vol: a.vol ?? 1, fade });
        else if (this.nodes.bgm) this.nodes.bgm.gain.gain.setTargetAtTime(a.vol ?? 1, this.ctx.currentTime, 0.2);
      } else {
        const map = this.nodes[a.ch];
        if (a.act === 'stop') { this._stop(map.get(a.id), 300); map.delete(a.id); }
        else if (a.act === 'play') {
          const isHb = a.id === DEFAULTS.danger.heartbeat;
          map.set(a.id, this._start(a.id, a.ch === 'amb' ? this.g.amb : this.g.se, { loop: true, vol: a.vol ?? 1, fade: 300, rate: isHb ? this.rate : 1 }));
        }
      }
    }
    this.state = applyActs(this.state, acts);
  }
  setHeartRate(r) { this.rate = r; const n = this.nodes.loops.get(DEFAULTS.danger.heartbeat); if (n && n.src) n.src.playbackRate.value = r; }
  once(id, ch = 'se', vol = 1) { if (!this.ctx || !id) return Promise.resolve(0); const e = this._start(id, this.g[ch] || this.g.se, { vol }); e.ready.then((d) => setTimeout(() => this._stop(e), d * 1000 + 100)); return e.ready; }
  interj(id) { if (!this.ctx) return Promise.resolve(0); this.stopInterj(); const e = this._start(id, this.g.voice, { vol: DEFAULTS.interj.gain }); this.interjNode = e; return e.ready; }
  stopInterj() { if (this.interjNode) { this._stop(this.interjNode, DEFAULTS.interj.fadeOutMs); this.interjNode = null; } }
  voice(id) { if (NOVOICE || !this.ctx) return Promise.resolve(0); this.stopVoice(); const e = this._start(id, this.g.voice); this.voiceNode = e; return e.ready; }
  stopVoice() { if (this.voiceNode) { this._stop(this.voiceNode); this.voiceNode = null; } }
  ui(kind) { this.once(DEFAULTS.ui[kind]); }
}
const audio = new Audio_();
const voicePath = (id) => { const pre = id.split('_')[0]; return `audio/voice/${pre}/${id}.ogg`; };

// ---------------- 画面 ----------------
const stage = $('#stage');
const POS = { l: 0.2, lc: 0.35, c: 0.5, rc: 0.65, r: 0.8 };
const view = {
  fast: false, bgKey: null, chars: new Map(), cgKey: null, cgId: null,
  dur(d, def) { return this.fast ? 0 : (d ?? def); },
  bgSpec(bg) {
    if (!bg) return null;
    let time = bg.time || 'day', tint = bg.tint || null, path = `art/bg/bg_${bg.loc}_${time}.png`;
    if (time === 'dusk' && !has(path)) { path = `art/bg/bg_${bg.loc}_day.png`; tint = tint || 'dusk'; } // dusk 缺图：昼版 + 暖色遮罩
    return { path, tint, label: `bg_${bg.loc}_${time}`, key: `${path}|${tint}` };
  },
  makeBg(spec) {
    const w = el('div', 'bgwrap');
    const i = img(spec.path, spec.label, 'fit'); w.append(i);
    const T = spec.tint && DEFAULTS.tints[spec.tint];
    if (T) {
      i.style.filter = `brightness(${T.brightness})`;
      const m = el('div', 'tint-dusk-mul'); m.style.background = `linear-gradient(${T.multiply[0]}, ${T.multiply[1]})`;
      const s = el('div', 'tint-dusk-scr'); s.style.background = T.screen;
      w.append(m, s);
    }
    w._spec = spec;
    return w;
  },
  async swap(layer, oldEl, newEl, trans = 'crossfade', dur) {
    const d = this.dur(dur, 600);
    if (!d || trans === 'none') { if (oldEl) oldEl.remove(); if (newEl) layer.append(newEl); return; }
    if (trans === 'black' || trans === 'fade' || trans === 'white') {
      const c = $('#curtain'); c.style.background = trans === 'white' ? '#fff' : '#000'; c.style.transitionDuration = `${d / 2}ms`;
      c.style.opacity = 1; await sleep(d / 2);
      if (oldEl) oldEl.remove(); if (newEl) layer.append(newEl);
      c.style.opacity = 0; return;
    }
    if (newEl) {
      newEl.classList.add('fade'); newEl.style.setProperty('--dur', `${d}ms`); newEl.style.opacity = 0;
      if (trans === 'wipe') { newEl.style.opacity = 1; newEl.style.clipPath = 'inset(0 100% 0 0)'; newEl.style.transition = `clip-path ${d}ms ease`; }
      layer.append(newEl); newEl.getBoundingClientRect();
      if (trans === 'wipe') newEl.style.clipPath = 'inset(0 0 0 0)'; else newEl.style.opacity = 1;
    } else if (oldEl) { oldEl.classList.add('fade'); oldEl.style.setProperty('--dur', `${d}ms`); oldEl.style.opacity = 0; }
    await sleep(d); if (oldEl) oldEl.remove();
  },
  applyBg(bg, trans, dur) {
    const layer = $('#layer-bg'); const spec = this.bgSpec(bg);
    const key = spec ? spec.key : null; if (key === this.bgKey) return;
    this.bgKey = key; const old = layer.lastElementChild;
    [...layer.children].slice(0, -1).forEach((e) => e.remove());
    this.swap(layer, old, spec ? this.makeBg(spec) : null, trans, dur);
  },
  charPaths(id, ch) {
    const accs = P.chars[id]?.acc || [], empty = ch.acc && ch.acc.startsWith('no') && accs.includes(ch.acc.slice(2)); // noglasses 等 = 空叠层
    return { body: `art/chara/${id}_${ch.outfit}_${ch.expr}.png`, acc: ch.acc && !empty && !NOART.has(`art/chara/${id}_${ch.acc}.png`) ? [`art/chara/${id}_${ch.acc}_${ch.expr}.png`, `art/chara/${id}_${ch.acc}.png`].find(has) || `art/chara/${id}_${ch.acc}.png` : null }; // 有 <角色>_<配饰>_<表情>.png 就用它（全透明＝该表情不叠）
  },
  applyChars(st, c) {
    const layer = $('#layer-chars');
    for (const [id, e] of this.chars) if (!st.chars[id]) {
      this.chars.delete(id);
      const d = this.dur(c?.dur, 300); e.style.setProperty('--dur', `${d}ms`); e.style.opacity = 0; setTimeout(() => e.remove(), d);
    }
    for (const [id, ch] of Object.entries(st.chars)) {
      if (P.chars[id]?.sprite === false) continue;
      const p = this.charPaths(id, ch); const key = `${p.body}|${p.acc}`;
      let e = this.chars.get(id);
      const fresh = !e;
      if (!e) { e = el('div', 'sprite'); e.style.opacity = 0; layer.append(e); this.chars.set(id, e); }
      if (e._key !== key) {
        const keep = [...e.querySelectorAll(':scope > .cfx')];
        e._key = key; e.replaceChildren(img(p.body, `${id}_${ch.outfit}_${ch.expr}`)); if (p.acc && has(p.acc)) e.append(img(p.acc, ''));
        e.append(...keep);
        if (!has(p.body)) e.firstChild.textContent = `${P.chars[id]?.name || id}\n${ch.outfit}/${ch.expr}${ch.acc ? '/' + ch.acc : ''}`;
      }
      this.charFx(e, id, ch);
      e.style.left = `${(POS[ch.pos] ?? 0.5) * 1280}px`;
      if (fresh) { const d = this.dur(c?.dur, 300); e.style.setProperty('--dur', `${d}ms`); e.getBoundingClientRect(); }
      e.style.opacity = 1;
    }
  },
  applyCg(cg, c) {
    const layer = $('#layer-cg');
    const key = cg ? `${cg.id}|${cg.diff}|${(cg.layers || []).join(',')}` : null;
    if (key === this.cgKey) return;
    this.cgKey = key;
    const old = layer.lastElementChild;
    [...layer.children].slice(0, -1).forEach((e) => e.remove());
    if (!cg) { this.cgId = null; this.swap(layer, old, null, c?.trans || 'crossfade', c?.dur); return; }
    const w = el('div', 'bgwrap');
    w.append(img(`art/cg/${cg.id}.png`, cg.id, 'fit'));
    if (cg.diff) { const p = `art/cg/${cg.id}_${cg.diff}.png`; w.append(has(p) ? img(p, '', 'fit') : placeholder(`${cg.id} 差分 ${cg.diff}`, 'fit')); }
    for (const l of cg.layers || []) { const p = [...DEFAULTS.fxlayer.cgFx(l, cg.id, cg.diff), DEFAULTS.fxlayer.overlays[l]].find((x) => x && has(x)); if (p) { const li = img(p, '', 'fit'); if (DEFAULTS.fxlayer.blend[l]) li.style.mixBlendMode = DEFAULTS.fxlayer.blend[l]; w.append(li); } else { const t = el('div', 'ph'); t.textContent = `+${l}`; t.style.cssText = 'right:64px;bottom:230px;left:auto;top:auto;width:auto;height:auto;background:rgba(0,0,0,.4)'; w.append(t); } }
    const sameId = this.cgId === cg.id; this.cgId = cg.id;
    // 同一张 CG 换差分 / 层：快速交叉淡化；换 CG：按 trans
    this.swap(layer, old, w, sameId ? (c?.trans === 'none' ? 'none' : 'crossfade') : (c?.trans || 'crossfade'), sameId ? this.dur(c?.dur, 250) : c?.dur);
  },
  applyDanger(st, rising) {
    const v = st.vars.danger || 0, on = st.danger.active;
    const lv = [...DEFAULTS.danger.levels].reverse().find((l) => v >= l.min);
    const weak = cfg.dangerFx === 'weak';
    $('#vignette').style.opacity = on ? lv.vignette * (weak ? 0.5 : 1) : 0;
    $('#danger-meter').classList.toggle('on', on);
    $('#danger-meter .fill').style.height = `${clamp(v, 0, 100) * 2.32}px`;
    // 竖屏：危险演出搬到 UI 层（UI_SPEC §13.5）——计量条脉动 + 文字面板描边呼吸（随档位加深），屏息时停在最红
    const de = document.documentElement; const li = DEFAULTS.danger.levels.indexOf(lv);
    de.style.setProperty('--dv', String(clamp(v, 0, 100))); de.style.setProperty('--bpm', String(lv.bpm || 80));
    de.style.setProperty('--dlv-a', String(Math.min(1, 0.35 + 0.65 * li / Math.max(1, DEFAULTS.danger.levels.length - 1)) * (weak ? 0.6 : 1)));
    if (!on) delete de.dataset.danger; else if (de.dataset.danger !== 'hold') de.dataset.danger = String(li);
    if (on && rising && v >= 100) { de.dataset.danger = 'hold'; clearTimeout(this._holdT); this._holdT = setTimeout(() => { if (de.dataset.danger === 'hold') de.dataset.danger = String(li); }, 2000); }
    audio.setDuck(on ? lv.bgmDuck : 1);
    audio.setHeartRate(lv.bpm / 60);
    if (on && rising && lv.shake && !weak) this.shake(lv.shake);
    if (on && rising && v >= 100) audio.holdBreath(DEFAULTS.danger.holdBreathMs);
  },
  shake(level = 's', dur, dir = 'xy') {
    if (this.fast) return;
    const sk = DEFAULTS.shake[level] || DEFAULTS.shake.m, amp = sk.amp;
    stage.style.setProperty('--amp', `${cfg.dangerFx === 'weak' ? amp / 2 : amp}px`); stage.style.setProperty('--sdur', `${dur ?? sk.dur ?? 300}ms`);
    // 只震图像层（UI_SPEC §13.5：竖屏不震文字面板）；横屏同样只震图像，文字始终可读
    const ls = [...document.querySelectorAll('#stage-img > .layer')];
    for (const l of ls) { l.classList.remove('shaking'); l.getBoundingClientRect(); l.classList.add('shaking'); }
    setTimeout(() => ls.forEach((l) => l.classList.remove('shaking')), (dur ?? 300) + 20);
  },
  flash(color = 'white', dur, count = 1) {
    if (this.fast) return;
    const f = $('#flash'); f.style.background = { white: '#fff', pink: '#f2a7b8', black: '#000', red: '#c0262d' }[color] || color;
    const d = dur ?? 300; const kf = []; for (let i = 0; i < count; i++) kf.push({ opacity: 0 }, { opacity: 0.9 }); kf.push({ opacity: 0 });
    f.animate(kf, { duration: d * count, easing: 'ease-out' });
  },
  // E-fxlayer：头顶锚定特效。挂在 .sprite 里（随立绘位置/缩放移动）；锚点 = characters.txt head（画布 1080×1620）
  charFx(e, id, ch) {
    const A = DEFAULTS.fxlayer.anchored, want = new Set(ch.fx || []);
    for (const f of e.querySelectorAll(':scope > .cfx:not(.out)')) if (!want.has(f.dataset.fx)) {
      const d = this.dur(null, A.fadeOutMs); f.classList.add('out'); f.style.setProperty('--dur', `${d}ms`); f.style.opacity = 0; if (d) setTimeout(() => f.remove(), d); else f.remove();
    }
    for (const n of want) {
      if (e.querySelector(`:scope > .cfx[data-fx="${n}"]:not(.out)`)) continue;
      const M = { frames: A.frames, size: A.size, dur: A.dur, ...(game.assets.fxMeta?.[n] || {}) }, path = A.file(n);
      const [hx, hy] = P.chars[id]?.head || A.head, [cw, ch_] = A.canvas;
      const f = el('div', 'cfx'); f.dataset.fx = n; f.dataset.chara = id;
      f.style.cssText = `left:${hx / cw * 100}%;top:${hy / ch_ * 100}%;width:${M.size / cw * 100}%;aspect-ratio:1;--frames:${M.frames};--fdur:${M.dur}ms`;
      if (has(path)) f.style.backgroundImage = `url("${R(path)}")`; else f.classList.add('missing');
      e.append(f);
    }
  },
  // E-fxsteam（STAGING §13.3）：#layer-steam 在立绘之上、CG 之下；lv → 不透明度；reduced-motion 只放静态 overlay
  steamKey: null,
  applySteam(scr, fade) {
    const layer = $('#layer-steam'), s = scr?.steam, S = DEFAULTS.fxlayer.screen.steam;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const key = s ? `on|${reduced}` : null, d = this.dur(fade, S.fadeMs);
    const cur = layer.querySelector('.steam:not(.out)');
    if (s && cur && key === this.steamKey) { cur.dataset.lv = s.lv; cur.style.setProperty('--dur', `${d}ms`); cur.style.opacity = S.alpha[s.lv - 1]; return; }
    this.steamKey = key;
    if (cur) { cur.classList.add('out'); cur.style.setProperty('--dur', `${d}ms`); cur.style.opacity = 0; if (d) setTimeout(() => cur.remove(), d); else cur.remove(); }
    if (!s) return;
    const w = el('div', `steam${reduced ? ' static' : ''}`); w.dataset.lv = s.lv;
    if (!reduced && has(S.tile)) { const t = el('div', 'steam-tile'); t.style.backgroundImage = `url("${R(S.tile)}")`; t.style.setProperty('--period', `${S.periodMs}ms`); w.append(t); }
    if (has(S.overlay)) w.append(img(S.overlay, '', 'fit'));
    w.style.setProperty('--dur', `${d}ms`); w.style.opacity = 0; layer.append(w); w.getBoundingClientRect(); w.style.opacity = S.alpha[s.lv - 1];
  },
  applyUi(st) { $('#ui').classList.toggle('hidden', !!st.uiHidden || ctl.userHide); },
  full(st) {
    const f = this.fast; this.fast = true;
    this.applyBg(st.bg, 'none'); this.applyChars(st); this.applyCg(st.cg, { trans: 'none' }); this.applySteam(st.screen); this.applyDanger(st, false); this.applyUi(st); hud.all(st, true);
    this.fast = f;
    hfx.restore(st);
  },
  clear() {
    for (const s of ['#layer-bg', '#layer-chars', '#layer-steam', '#layer-cg']) $(s).replaceChildren();
    this.bgKey = this.cgKey = this.cgId = this.steamKey = null; this.chars.clear();
    hfx.clear(0);
    $('#vignette').style.opacity = 0; $('#danger-meter').classList.remove('on'); delete document.documentElement.dataset.danger; audio.setDuck(1);
  },
  onCmd(c, st) {
    switch (c.op) {
      case 'bg': this.applyBg(st.bg, c.trans, c.dur); this.applyChars(st, { dur: 0 }); this.applyCg(st.cg, { trans: c.trans, dur: c.dur }); this.applySteam(st.screen, c.dur); break;
      case 'fx': this.applySteam(st.screen, c.fade); this.applyChars(st, { dur: 0 }); break;
      case 'daynight': this.applyBg(st.bg, 'crossfade', c.dur ?? 1200); break;
      case 'char': case 'hide': this.applyChars(st, c); break;
      case 'cg': this.applyCg(st.cg, c); break;
      case 'shake': this.shake(c.level, c.dur, c.dir); break;
      case 'flash': this.flash(c.color, c.dur, c.count); break;
      case 'ui': this.applyUi(st); break;
      case 'danger': this.applyDanger(st, !c.end); break;
      case 'hearts': case 'moan': hfx.onCmd(c); break;
      case 'bgm': case 'bgmstop': audio.nextFade = c.fade ?? null; break;
    }
  },
};

// ---------------- HUD（好感 / 欲望） ----------------
const hud = {
  popMs: () => (L?.portrait ? DEFAULTS.hud.popMsPortrait : DEFAULTS.hud.popMs),
  els: {},
  build() {
    const h = $('#hud'); h.replaceChildren(); this.els = {};
    for (const [k, v] of Object.entries(P.vars)) {
      if (v.gauge !== 'aff' && v.gauge !== 'lust') continue;
      const g = el('div', `gauge ${v.gauge}`);
      const ico = el('div', 'ico', v.gauge === 'aff' ? '♥' : '❀'); ico.title = `${P.chars[v.chara]?.name || ''}${v.label}`;
      const bar = el('div', 'bar'); const fill = el('i'); bar.append(fill);
      for (const t of v.th || []) { const b = el('b'); b.style.left = `${((t - v.min) / (v.max - v.min)) * 100}%`; bar.append(b); }
      const lv = el('span', 'lv');
      g.append(ico, bar, lv); g.style.display = 'none'; h.append(g);
      this.els[k] = { g, fill, lv, def: v, timer: 0 };
    }
  },
  set(k, val, pop) {
    const e = this.els[k]; if (!e) return;
    const { def } = e; const r = clamp((val - def.min) / (def.max - def.min), 0, 1);
    e.g.style.display = ''; e.fill.style.width = `${r * 100}%`;
    e.lv.textContent = `${def.label} Lv${Math.min(DEFAULTS.hud.levels, 1 + Math.floor(r * DEFAULTS.hud.levels))}`;
    if (pop) { e.g.classList.add('open'); clearTimeout(e.timer); e.timer = setTimeout(() => e.g.classList.remove('open'), hud.popMs()); }
  },
  all(st) { for (const k of Object.keys(this.els)) { const touched = st.vars[k] !== P.vars[k].init; if (touched) this.set(k, st.vars[k], false); else this.els[k].g.style.display = 'none'; } },
  hideAll() { for (const e of Object.values(this.els)) e.g.style.display = 'none'; },
};

function toast(msg) { const t = el('div', null, msg); $('#toast').append(t); setTimeout(() => t.remove(), 2500); }

// ---------------- VM ----------------
const backlog = [];
const vm = new VM(P, {
  system: sys,
  hooks: {
    cmd: (c, m) => view.onCmd(c, m.st),
    sfx: (s) => {
      if (view.fast && s.kind !== 'voice') return;
      if (s.kind === 'voice') return; // 台词语音在 showText 里播（便于自动模式等待）
      audio.once(s.id, s.id.startsWith('amb_') ? 'amb' : 'se', s.vol ?? 1);
    },
    gauge: (k, o, n, silent, m) => { if (k !== 'danger') hud.set(k, n, !silent && !view.fast); },
    threshold: (k, t, m) => { if (!m.st.recall) { const v = P.vars[k]; toast(`${P.chars[v.chara]?.name || ''}${v.label} 达到 ${t}`); audio.once(DEFAULTS.unlockSe); } },
    unlock: (kind, id) => { saveSys(); if (kind === 'recall') toast(`回想解锁：${P.hblocks[id]?.title || id}`); },
    chose: (opt) => backlog.push({ choice: true, text: opt.text }),
    hEnter: () => {},
    hExit: () => { hfx.stopHearts(0); hfx.clearMoans(); }, // 与自动停音同处：退出 H 块清空特效
    recallExit: () => hfx.clear(0),
    warn: (w) => console.warn(w),
  },
});

// ---------------- H 高潮特效：爱心粒子 + 拟声字（STAGING §12） ----------------
// 画在图像层 #stage-img 内的 #hfx（1280×720 逻辑坐标，竖屏随图像层缩放并一起压暗）；只用 y ≤ hfx.maxY，绝不盖文字框。
// 退出 H 块 / 回想自动清空；skip 时不发射；读档只恢复爱心档位（st.fx.hearts），拟声字不恢复。
const HX = DEFAULTS.hfx;
const hfx = {
  hearts: null, emitT: null, burstT: null, durT: null, timers: new Set(), moans: [], lastPos: null, lastWord: null,
  get root() { return $('#hfx'); },
  get on() { return cfg.hfx !== false; },
  reduced() { return matchMedia('(prefers-reduced-motion: reduce)').matches || cfg.dangerFx === 'weak'; },
  eff(lv) { return this.reduced() ? lv - 1 : lv; }, // 降一档；0 = lv1 的静态版
  r: (a, b) => a + Math.random() * (b - a),
  rv(v, j = 0.15) { return Array.isArray(v) ? this.r(v[0], v[1]) : v * this.r(1 - j, 1 + j); }, // 区间或标量（±15%）
  later(fn, ms) { const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms); this.timers.add(t); return t; },
  // ---- 爱心 ----
  pickHeart(lv) {
    const w = Object.entries(HX.heartWeights).filter(([k]) => k !== 'd' || lv >= HX.heartDMinLv);
    let x = Math.random() * w.reduce((s, [, v]) => s + v, 0);
    for (const [k, v] of w) if ((x -= v) < 0) return k;
    return 'a';
  },
  heartEl(lv, size) {
    const k = this.pickHeart(lv), src = `art/ui/fx/fx_heart_${k}.png`;
    let el;
    if (has(src)) { el = document.createElement('img'); el.src = R(src); el.alt = ''; }
    else { el = document.createElement('div'); el.className = 'css'; el.textContent = '♥'; el.style.fontSize = `${size}px`; } // 素材缺失：CSS 退回
    el.classList.add('heart'); el.dataset.k = k;
    el.style.width = el.style.height = `${size}px`;
    return el;
  },
  areaPoint(area, s) {
    const M = HX.maxY, W = 1280;
    let x, y;
    if (area === 'full') { x = this.r(0, W - s); y = this.r(80, M - s); }
    else if (area === 'lower') { x = this.r(0, W - s); y = this.r(HX.lowerY[0], Math.min(HX.lowerY[1], M) - s); } // §12.1 360–520，夹到 ≤500
    else { const e = W * HX.edgeFrac; x = Math.random() < 0.5 ? this.r(0, e - s) : this.r(W - e, W - s); y = this.r(60, M - s); }
    return { x, y: Math.max(0, Math.min(y, M - s)) };
  },
  spawn(burst) {
    const h = this.hearts; if (!h || !this.root) return;
    const P = HX.hearts[h.eff];
    if (!burst && this.root.querySelectorAll('.heart:not(.out)').length >= P.max[1]) return;
    const size = burst ? this.r(16, 28) : this.r(P.size[0], P.size[1]);
    const el = this.heartEl(h.eff, size);
    const { x, y } = burst ? burst : this.areaPoint(h.area, size);
    el.style.left = `${x}px`; el.style.top = `${y}px`;
    const a = this.rv(P.alpha), life = burst ? 1400 : this.rv(P.life);
    const rise = (burst ? 80 : this.rv(P.speed) * life / 1000), sway = this.rv(P.sway, 0.4), swT = this.rv(P.swayT);
    const rot = this.r(-15, 15), N = 14, kf = [];
    const bx = burst ? this.r(-70, 70) : 0, by = burst ? this.r(-60, -20) : 0;
    for (let i = 0; i <= N; i++) {
      const t = i / N, ms = t * life;
      const op = ms < 200 ? a * ms / 200 : t > 0.7 ? a * (1 - (t - 0.7) / 0.3) : a;
      const sc = ms < 200 ? ms / 200 : 1;
      const dx = bx * Math.min(1, t * 4) + sway * Math.sin(2 * Math.PI * ms / swT), dy = by * Math.min(1, t * 4) - rise * t;
      kf.push({ offset: t, opacity: op, transform: `translate(${dx}px,${dy}px) rotate(${rot}deg) scale(${sc})` });
    }
    this.root.append(el);
    el.animate(kf, { duration: life, easing: 'linear', fill: 'forwards' }).onfinish = () => el.remove();
  },
  tick() {
    if (!this.hearts || view.fast || document.hidden) return;
    const P = HX.hearts[this.hearts.eff], n = Math.max(1, Math.round(P.rate * 0.2)); // 每 200ms 一拍
    for (let i = 0; i < n; i++) if (Math.random() < P.rate * 0.2 / n) this.spawn();
  },
  burstTick() {
    if (!this.hearts || view.fast || document.hidden) return;
    const c = this.areaPoint(this.hearts.area, 28), n = Math.round(this.r(HX.burstN[0], HX.burstN[1] + 0.99));
    for (let i = 0; i < n; i++) this.spawn({ x: c.x, y: Math.max(80, c.y) });
  },
  staticHearts() {
    for (let i = 0; i < HX.staticHearts; i++) {
      const P = HX.hearts[1], s = this.r(P.size[0], P.size[1]), el = this.heartEl(1, s), { x, y } = this.areaPoint(this.hearts.area, s);
      el.classList.add('static'); el.style.left = `${x}px`; el.style.top = `${y}px`; el.style.opacity = 0;
      this.root.append(el);
      el.animate([{ opacity: 0 }, { opacity: P.alpha[0] }], { duration: HX.fadeStop, fill: 'forwards' });
    }
  },
  setHearts(lv, area = HX.areaDefault, dur = null) {
    if (!this.on || !this.root) return;
    const prev = this.hearts, eff = this.eff(lv);
    clearInterval(this.emitT); clearInterval(this.burstT); clearTimeout(this.durT); this.emitT = this.burstT = this.durT = null;
    if (prev && (prev.eff <= 0) !== (eff <= 0)) this.fadeHearts(HX.swapMs); // 动↔静切换：旧的淡掉；同为动态则平滑换档不叠加
    if (prev && eff <= 0 && prev.eff <= 0 && prev.area === area) { prev.lv = lv; return; }
    this.hearts = { lv, area, eff };
    if (eff <= 0) this.staticHearts();
    else {
      this.emitT = setInterval(() => this.tick(), 200);
      if (eff >= 3) this.burstT = setInterval(() => this.burstTick(), HX.burstEvery);
      if (!prev && !view.fast) for (let i = 0; i < Math.ceil(HX.hearts[eff].max[0] / 3); i++) this.spawn();
    }
    if (dur) this.durT = setTimeout(() => this.stopHearts(HX.fadeStop), dur);
  },
  fadeHearts(ms) {
    for (const el of this.root?.querySelectorAll('.heart:not(.out)') || []) {
      el.classList.add('out');
      if (!ms) { el.remove(); continue; }
      el.getAnimations().forEach((a) => a.pause());
      el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }], { duration: ms, fill: 'forwards', composite: 'replace' }).onfinish = () => el.remove();
    }
  },
  stopHearts(fade = HX.fadeStop) {
    clearInterval(this.emitT); clearInterval(this.burstT); clearTimeout(this.durT); this.emitT = this.burstT = this.durT = null;
    this.hearts = null; this.fadeHearts(fade);
  },
  // ---- 拟声字 ----
  place(pos, w, h) {
    const M = HX.maxY, W = 1280, e = this.r(HX.moanEdge[0], HX.moanEdge[1]);
    const xs = { l: e, r: W - w - e, m: this.r(220, Math.max(220, W - 220 - w)) }, yT = e, yB = M - h - e, yM = this.r(HX.moanTopY, Math.max(HX.moanTopY, M - h - 60)), yTs = Math.max(yT, HX.moanTopY);
    const P = { l: [xs.l, yM], r: [xs.r, yM], t: [xs.m, yT], b: [xs.m, yB], lt: [xs.l + this.r(0, 60), yTs + this.r(0, 40)], rt: [xs.r - this.r(0, 60), yTs + this.r(0, 40)], lb: [xs.l + this.r(0, 60), yB - this.r(0, 40)], rb: [xs.r - this.r(0, 60), yB - this.r(0, 40)] }[pos];
    return { x: Math.max(0, Math.min(P[0], W - w)), y: Math.max(0, Math.min(P[1], M - h)), w, h };
  },
  hit(a) { return this.moans.some((m) => a.x < m.rc.x + m.rc.w && m.rc.x < a.x + a.w && a.y < m.rc.y + m.rc.h && m.rc.y < a.y + a.h); },
  moan(text, lv = 2, pos = 'auto', dur = null) {
    if (!this.on || view.fast || !this.root) return;
    const eff = this.eff(lv), still = eff <= 0, sl = Math.max(1, eff), M = HX.moan[sl];
    const live = () => this.moans.filter((m) => !m.out);
    while (live().length >= HX.moanMax[sl]) this.fadeMoan(live()[0], 200); // 同屏上限 = 档位 + 1：最旧的提前淡出
    const el = document.createElement('div'), j = document.createElement('div'), t = document.createElement('span');
    el.className = `moan lv${sl}${still ? ' still' : ''}`; j.className = 'j'; j.dataset.t = text; t.className = 't'; t.textContent = text;
    const glowSrc = 'art/ui/fx/fx_moan_glow.png';
    if (has(glowSrc)) { const g = document.createElement('img'); g.className = 'glow'; g.src = R(glowSrc); g.alt = ''; el.append(g); } else el.classList.add('noglow');
    j.append(t); el.append(j);
    const fs = this.r(M.size[0], M.size[1]);
    el.style.cssText = `font-size:${fs}px;--ws:${M.white}px;--rs:${M.red}px;--blur:${M.blur}px;--ga:${M.glow};--jit:${M.jitter}px;visibility:hidden`;
    this.root.append(el);
    const w0 = el.offsetWidth, h0 = el.offsetHeight, tilt = this.r(-M.tilt, M.tilt), rad = Math.abs(tilt) * Math.PI / 180;
    const w = w0 * Math.cos(rad) + h0 * Math.sin(rad), h = h0 * Math.cos(rad) + w0 * Math.sin(rad); // 倾斜后的外接框，保证转完也在 y≤maxY 内
    const cands = pos === 'auto' ? HX.positions.filter((p) => p !== this.lastPos).sort(() => Math.random() - 0.5) : [pos];
    let rc = null, used = cands[0];
    for (let k = 0; k < 8 && !rc; k++) for (const p of cands) { const c = this.place(p, w, h); if (!this.hit(c)) { rc = c; used = p; break; } }
    rc ||= this.place(used, w, h);
    this.lastPos = used;
    el.style.left = `${rc.x + (w - w0) / 2}px`; el.style.top = `${rc.y + (h - h0) / 2}px`; el.style.visibility = '';
    const s = HX.moanSlide, dx = used.includes('l') ? -s : used.includes('r') ? s : 0, dy = used.includes('t') ? -s : used.includes('b') ? s : 0;
    const m = { el, rc, out: false, t: null };
    this.moans.push(m);
    el.animate(still ? [{ opacity: 0, transform: `rotate(${tilt}deg)` }, { opacity: 1, transform: `rotate(${tilt}deg)` }]
      : [{ opacity: 0, transform: `translate(${dx}px,${dy}px) rotate(${tilt}deg) scale(.8)` }, { opacity: 1, transform: `translate(0,0) rotate(${tilt}deg) scale(1)` }],
    { duration: M.inMs, easing: 'cubic-bezier(.2,1.4,.4,1)', fill: 'forwards' });
    m.tilt = tilt;
    m.t = this.later(() => this.fadeMoan(m, M.outMs), M.inMs + (dur ?? M.hold));
  },
  fadeMoan(m, ms) {
    if (!m || m.out) return; m.out = true; clearTimeout(m.t); this.timers.delete(m.t);
    const done = () => { m.el.remove(); this.moans = this.moans.filter((x) => x !== m); };
    if (!ms) return done();
    const still = m.el.classList.contains('still');
    m.el.animate([{ opacity: 1, transform: `translate(0,0) rotate(${m.tilt}deg)` }, { opacity: 0, transform: `translate(0,${still ? 0 : -16}px) rotate(${m.tilt}deg)` }], { duration: ms, fill: 'forwards' }).onfinish = done;
  },
  burst(lv, n = HX.burstDefault.n, lang = HX.burstDefault.lang, gap = HX.burstDefault.gap) {
    if (!this.on || view.fast) return;
    const pool = lang === 'mix' ? [...HX.words.ja, ...HX.words.zh] : HX.words[lang];
    for (let i = 0; i < n; i++) {
      this.later(() => {
        let w; do w = pool[Math.floor(Math.random() * pool.length)]; while (pool.length > 1 && w === this.lastWord);
        this.lastWord = w; this.moan(w, lv, 'auto');
      }, i * gap);
    }
  },
  clearMoans(ms = HX.clearMs) {
    for (const t of this.timers) clearTimeout(t); this.timers.clear();
    for (const m of [...this.moans]) this.fadeMoan(m, ms);
  },
  clear(ms = 0) { this.stopHearts(ms); this.clearMoans(ms); if (!ms) this.root?.replaceChildren(); this.moans = []; this.lastPos = null; },
  restore(st) { // 读档 / 打开开关：只恢复爱心档位（带 dur 的视为一次性，不恢复）
    this.clear(0);
    const h = st?.fx?.hearts;
    if (h && !h.dur && this.on) this.setHearts(h.lv, h.area);
  },
  onCmd(c) {
    if (c.op === 'hearts') { if (c.stop) this.stopHearts(c.fade ?? HX.fadeStop); else this.setHearts(c.lv, c.area, c.dur); }
    else if (c.clear) this.clearMoans();
    else if (c.burst) this.burst(c.lv, c.n, c.lang, c.gap);
    else this.moan(c.text, c.lv, c.pos, c.dur);
  },
  count() { return { hearts: this.root?.querySelectorAll('.heart:not(.out)').length || 0, moans: this.moans.filter((m) => !m.out).length, lv: this.hearts?.lv ?? 0, eff: this.hearts?.eff ?? null }; },
};

// ---------------- 流程控制 ----------------
const ctl = {
  mode: 'title', auto: false, skip: false, userHide: false, typing: null, ev: null, waitTimer: 0, autoTimer: 0, busy: false,
  setSkip(on) { this.skip = on; view.fast = on; qbtn('skip').classList.toggle('on', on); if (on) this.kick(); },
  setAuto(on) { this.auto = on; qbtn('auto').classList.toggle('on', on); if (on) this.kick(); },
  kick() { if (this.ev && this.ev.type === 'text' && !this.typing) this.afterText(); },
  handle(ev) {
    this.ev = ev; clearTimeout(this.waitTimer); clearTimeout(this.autoTimer);
    audio.sync(vm.st.audio);
    if (vm.st.scene?.code !== this.sceneCode) { this.sceneCode = vm.st.scene?.code; enterScene(this.sceneCode); }
    if (ev.type !== 'text') { $('#text').classList.remove('done'); }
    switch (ev.type) {
      case 'text': return this.showText(ev);
      case 'choice': return this.showChoice(ev);
      case 'wait': this.waitTimer = setTimeout(() => this.next(), this.skip ? 0 : ev.ms); return;
      case 'end': return this.ending(ev);
      case 'recallEnd': return screens.recall(true);
    }
  },
  showText(ev) {
    const name = ev.name || (ev.speaker ? P.chars[ev.speaker]?.name : '') || '';
    const nb = $('#namebox'); nb.classList.toggle('on', !!name); $('span', nb).textContent = name;
    const body = $('#text .body'); const t = $('#text'); t.classList.remove('done');
    backlog.push({ name, text: ev.text, voice: NOVOICE ? null : ev.voice }); if (backlog.length > 200) backlog.shift();
    if (this.skip && !ev.read && !cfg.skipUnread) this.setSkip(false);
    audio.stopInterj(); // 翻页即停
    if (cfg.voiceStop) audio.stopVoice();
    this.voiceP = ev.voice && !NOVOICE && !this.skip ? audio.voice(ev.voice) : Promise.resolve(0);
    const full = ev.text; const cps = cfg.textSpeed;
    if (this.skip || !cps || cps >= 200) { body.textContent = full; this.typing = null; return this.afterText(); }
    let i = 0; const t0 = performance.now(); const chars = [...full];
    const tick = (now) => {
      if (this.typing !== tok) return;
      const n = Math.min(chars.length, Math.floor(((now - t0) / 1000) * cps) + 1);
      if (n !== i) { i = n; body.textContent = chars.slice(0, i).join(''); }
      if (i >= chars.length) { this.typing = null; this.afterText(); } else requestAnimationFrame(tick);
    };
    const tok = {}; this.typing = tok; body.textContent = ''; requestAnimationFrame(tick);
  },
  finishTyping() { if (!this.typing) return false; this.typing = null; $('#text .body').textContent = this.ev.text; this.afterText(); return true; },
  afterText() {
    $('#text').classList.add('done');
    const ev = this.ev;
    if (!ev || ev.type !== 'text') return; // 回标题/切屏后残留的打字回调
    if (this.skip) { if (ev.read || cfg.skipUnread) this.autoTimer = setTimeout(() => this.next(), 40); else this.setSkip(false); return; }
    // 句末语气词：文字显示完时播（规则在 core/interj.mjs）
    let interjP = Promise.resolve(0);
    if (!ev._interjDone) {
      ev._interjDone = true;
      const d = decideInterj(ev, { bank: INTERJ, hasVoice: hasAudio, noVoice: NOVOICE, enabled: cfg.interj, enabledH: cfg.interjH, skip: this.skip });
      if (d.emo && !d.skip && interjGate.allow(performance.now())) { const id = interjGate.pick(INTERJ, d.chara, d.emo); if (id) interjP = audio.interj(id); }
    }
    if (this.auto) {
      const me = ev;
      Promise.all([this.voiceP, interjP]).then(([d, dj]) => { const wait = Math.max(d * 1000 + 300, dj * 1000 + 200, cfg.autoWait + cfg.autoPerChar * [...ev.text].length * (d ? 0 : 1)); this.autoTimer = setTimeout(() => { if (this.ev === me && this.auto && !screens.open) this.next(); }, wait); });
    }
  },
  showChoice(ev) {
    if (this.skip) this.setSkip(false);
    autosave();
    const box = $('#choices'); box.replaceChildren(); box.className = `on${ev.hstyle ? '' : ' dim'}`;
    const R = choiceRects(L, ev.opts.length, ev.hstyle);
    ev.opts.forEach((o, k) => {
      const b = el('button', `choice${ev.hstyle ? ' h' : ''}${o.seen ? ' seen' : ''}`, o.text);
      if (!L.portrait) Object.assign(b.style, { left: `${R[k].x}px`, top: `${R[k].y}px`, width: `${R[k].w}px`, height: `${R[k].h}px` });
      b.onclick = (e) => { e.stopPropagation(); audio.ui('confirm'); box.className = ''; box.replaceChildren(); this.handle(vm.choose(o.i)); };
      box.append(b);
    });
  },
  next() {
    if (screens.open || !this.ev) return;
    if (this.ev.type === 'text' || this.ev.type === 'wait') { audio.stopInterj(); try { this.handle(vm.advance()); } catch (e) { this.crash(e); } }
  },
  click() {
    if (this.mode !== 'game' || screens.open) return;
    audio.unlock();
    if (this.userHide) { this.userHide = false; view.applyUi(vm.st); return; }
    if (this.skip) { this.setSkip(false); return; }
    if (this.ev?.type === 'text') { if (this.finishTyping()) return; this.next(); }
    else if (this.ev?.type === 'end') this.toTitle();
  },
  ending(ev) {
    saveSys();
    if (this.skip) this.setSkip(false); this.setAuto(false);
    $('#namebox').classList.remove('on');
    $('#text .body').textContent = `—— 终 ——　${ev.title || ''}\n（轻触返回标题）`; $('#text').classList.add('done');
  },
  crash(e) { console.error(e); toast(`脚本错误：${e.message}`); },
  start(fn) {
    this.mode = 'game'; screens.closeAll(); view.clear(); backlog.length = 0; audio.stopInterj(); audio.stopVoice(); hud.build(); hud.hideAll();
    $('#text .body').textContent = ''; $('#namebox').classList.remove('on'); $('#choices').className = '';
    this.userHide = false; this.setAuto(false); this.setSkip(false);
    try { const ev = fn(); view.full(vm.st); this.handle(ev); } catch (e) { this.crash(e); }
  },
  toTitle() {
    this.setAuto(false); this.setSkip(false); audio.stopVoice();
    vm.toTitle(); saveSys(); this.ev = null; this.mode = 'title'; view.clear();
    screens.title();
  },
};

// ---------------- 存档 ----------------
function isH() { return !!(vm.st.h || vm.st.recall); }
async function thumbnail() {
  const W = 256, H = 144;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
  const draw = (node) => {
    if (!node) return;
    if (node.tagName === 'IMG' && node.complete && node.naturalWidth) {
      const r = node.getBoundingClientRect(), s = $('#stage-img').getBoundingClientRect(); const k = W / s.width;
      // object-fit 的图按元素框绘制（近似），立绘按 contain
      try { x.drawImage(node, (r.left - s.left) * k, (r.top - s.top) * k, r.width * k, r.height * k); } catch {}
    } else if (node.classList?.contains('ph')) {
      const r = node.getBoundingClientRect(), s = $('#stage-img').getBoundingClientRect(); const k = W / s.width;
      x.fillStyle = `hsl(${hue(node.dataset.ph || '')} 35% 28%)`; x.fillRect((r.left - s.left) * k, (r.top - s.top) * k, r.width * k, r.height * k);
    } else if (node.classList?.contains('tint-dusk-mul')) { x.globalCompositeOperation = 'multiply'; const g = x.createLinearGradient(0, 0, 0, H); const T = DEFAULTS.tints.dusk; g.addColorStop(0, T.multiply[0]); g.addColorStop(1, T.multiply[1]); x.fillStyle = g; x.fillRect(0, 0, W, H); x.globalCompositeOperation = 'source-over'; }
    for (const ch of node.children || []) draw(ch);
  };
  for (const s of ['#layer-bg', '#layer-chars', '#layer-cg']) draw($(s));
  if (isH()) {
    // UI_SPEC §3：H 中存档缩略图轻微模糊（4px）；不支持 ctx.filter 的浏览器缩小再放大
    const out = document.createElement('canvas'); out.width = W; out.height = H; const o = out.getContext('2d');
    o.filter = 'blur(4px)';
    if (o.filter === 'blur(4px)') { o.drawImage(c, 0, 0); }
    else { o.filter = 'none'; const sm = document.createElement('canvas'); sm.width = 32; sm.height = 18; const s2 = sm.getContext('2d'); s2.imageSmoothingEnabled = true; s2.drawImage(c, 0, 0, 32, 18); o.imageSmoothingEnabled = true; o.imageSmoothingQuality = 'high'; o.drawImage(sm, 0, 0, W, H); }
    return out.toDataURL('image/jpeg', 0.7);
  }
  return c.toDataURL('image/jpeg', 0.7);
}
async function saveTo(slot, quiet = false) {
  if (vm.st.recall) { toast('回想中不能存档'); return false; }
  if (ctl.mode !== 'game' || !ctl.ev || ctl.ev.type === 'end') return false;
  const data = vm.save({ t: Date.now(), text: vm.st.last?.text?.slice(0, 40) || '', name: vm.st.last?.name || '', scene: vm.st.scene?.title || '', route: vm.st.route || null, routeTitle: routeTitle(vm.st.route), h: !!vm.st.h, version: game.version });
  data.thumb = await thumbnail();
  data.backlog = backlog.slice(-60);
  const ok = store.set(`save.${slot}`, data);
  if (!quiet) toast(ok ? `已存档（${slotName(slot)}）` : '存档失败：浏览器存储空间不足');
  return ok;
}
function loadFrom(slot) {
  const data = store.get(`save.${slot}`); if (!data) return false;
  // 存档里的记录最后一条就是当前句，读档后会重新显示并记入，所以去掉
  ctl.start(() => { const ev = vm.load(data); backlog.push(...(data.backlog || []).slice(0, -1)); return ev; });
  hud.all(vm.st);
  toast(`已读档（${slotName(slot)}）`);
  return true;
}
function autosave() {
  if (vm.st.recall || ctl.skip) return;
  const n = DEFAULTS.autoSlots; const i = (store.get('autoIdx', -1) + 1) % n; store.set('autoIdx', i); saveTo(`a${i + 1}`, true);
}
const slotName = (s) => (s === 'q' ? '快速' : s[0] === 'a' ? `自动 ${s.slice(1)}` : `No.${s}`);
function latestSave() {
  let best = null;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i); if (!k.startsWith(LS + 'save.')) continue;
    const d = store.get(k.slice(LS.length)); if (d && (!best || d.meta.t > best.t)) best = { slot: k.slice(LS.length + 5), t: d.meta.t };
  }
  return best;
}

// ---------------- 界面（标题 / 存读档 / 设置 / 记录 / 回想 / 鉴赏） ----------------
const screens = {
  open: null, stack: [],
  root: $('#screens'),
  show(node, name) { this.root.append(node); this.stack.push(node); this.open = name; this.sync(); },
  sync() { document.body.toggleAttribute('data-screen', !!this.open); },
  close() { const n = this.stack.pop(); if (n) n.remove(); this.open = this.stack.length ? this.stack[this.stack.length - 1]._name : null; this.sync(); if (!this.open) ctl.kick(); },
  closeAll() { while (this.stack.length) this.stack.pop().remove(); this.open = null; this.sync(); },
  frame(title, name) {
    const s = el('div', 'screen'); s._name = name; s.append(el('h2', null, title));
    const x = el('button', 'btn close', '返回'); x.onclick = () => { audio.ui('cancel'); this.close(); }; s.append(x);
    s.addEventListener('contextmenu', (e) => { e.preventDefault(); this.close(); });
    return s;
  },
  splash() {
    const s = el('div', 'screen title'); s._name = 'splash';
    s.style.cssText = 'justify-content:center;align-items:center;text-align:center;font-size:24px;line-height:1.8';
    s.innerHTML = '<div style="font:700 min(64px, 11vw) var(--font-body);white-space:nowrap;margin-bottom:24px">湯けむり裏返し</div><div>本作品为成人向内容，仅供 18 岁以上玩家。<br>登场人物均为成年人，情节纯属虚构。</div><div style="margin-top:40px;opacity:.8">— 轻触开始 —</div>';
    s.onclick = () => { audio.unlock(); this.closeAll(); this.title(); };
    this.show(s, 'splash');
  },
  title() {
    this.closeAll();
    const s = el('div', 'screen title'); s._name = 'title';
    s.append(img(skin('ui_title_bg') ? 'art/ui/ui_title_bg.png' : `art/bg/${DEFAULTS.titleBg}.png`, '标题背景', 'fit'));
    if (skin('ui_title_chara')) { s.classList.add('has-chara'); s.append(img('art/ui/ui_title_chara.png', '', 'fit chara')); }
    // 标题：有带字 logo 图才替换文字；否则 无字底框 ui_title_frame + 引擎渲染文字（UI_SPEC §12）
    const logo = el('div', 'logo');
    if (skin('ui_title_logo')) logo.append(img('art/ui/ui_title_logo.png', '湯けむり裏返し'));
    else { if (skin('ui_title_frame')) logo.classList.add('framed'); logo.append(el('span', 'logo-text', '湯けむり裏返し')); }
    s.append(logo);
    s.append(el('div', 'ver', `v${game.version}${game.release ? '' : '（开发版）'}`));
    const latest = latestSave();
    const items = [
      ['开始游戏', () => (ROUTES.length > 1 ? this.routes() : ctl.start(() => vm.start(ROUTES[0].entry, ROUTES[0].id)))],
      ['继续', latest ? () => loadFrom(latest.slot) : null],
      ['读档', () => this.saveload('load')],
      ['回想', () => this.recall()],
      ['CG 鉴赏', () => this.gallery()],
      ['设置', () => this.config()],
    ];
    const menu = el('div', 'menu'); const R = titleRects(L, items.length);
    items.forEach(([t, f], i) => {
      const b = el('button', 'btn', t); Object.assign(b.style, { left: `${R[i].x}px`, top: `${R[i].y}px`, height: `${R[i].h}px` });
      if (!f) b.disabled = true; else b.onclick = () => { audio.unlock(); audio.ui('click'); f(); };
      menu.append(b);
    });
    s.append(menu); this.show(s, 'title');
    audio.sync({ bgm: { id: DEFAULTS.titleBgm, vol: 1 }, loops: {}, amb: {} });
  },
  routes() {
    const s = this.frame('选择路线', 'routes'); s.classList.add('routes');
    const grid = el('div', 'grid thumbs route-grid'); grid.style.gridTemplateColumns = `repeat(${Math.min(3, ROUTES.length)}, 320px)`;
    for (const r of ROUTES) {
      const ok = routeUnlocked(game.program, sys, r);
      const cleared = !!Object.keys(sys.routeEnds?.[r.id] || {}).length;
      const b = el('button', `thumb route${ok ? '' : ' locked'}`); b.dataset.route = r.id;
      b.setAttribute('aria-label', ok ? r.title : `${r.title}（未解锁）`); if (!ok) b.setAttribute('aria-disabled', 'true');
      const tp = r.thumb ? `art/ui/${r.thumb}.png` : `art/ui/thumb/thumb_route_${r.id}.png`;
      b.append(has(tp) ? img(tp, '') : (() => { const ph = placeholder(r.title); ph.textContent = ''; ph.append(el('span', 'ph-t', '敬请期待')); return ph; /* 名字只在底部说明条出现一次 */ })()); // 文字包一层才能省略号
      if (!ok) b.append(el('div', 'lock', '🔒'));
      { const hn = r.heroine ? charName(r.heroine) : ''; b.append(el('div', 'cap', hn && !r.title.includes(hn) ? `${r.title}　${hn}` : r.title)); } // 标题已含角色名就不重复
      if (cleared) b.append(el('div', 'cnt', '已通关'));
      b.onclick = () => {
        if (!ok) { audio.ui('cancel'); return toast('尚未解锁'); }
        audio.unlock(); audio.ui('confirm'); ctl.start(() => vm.startRoute(r.id));
      };
      grid.append(b);
    }
    s.append(grid); this.show(s, 'routes');
  },
  saveload(mode, page = store.get('slPage', 1)) {
    const s = this.frame(mode === 'save' ? '存档' : '读档', 'saveload');
    const tabs = el('div', 'tabs');
    const pages = ['Q', 'A', ...Array.from({ length: DEFAULTS.savePages }, (_, i) => String(i + 1))];
    for (const p of pages) { const b = el('button', `btn${String(page) === p ? ' on' : ''}`, p === 'Q' ? '快速' : p === 'A' ? '自动' : p); b.onclick = () => { store.set('slPage', p); this.close(); this.saveload(mode, p); }; tabs.append(b); }
    const grid = el('div', 'grid'); grid.style.gridTemplateColumns = 'repeat(3, 1fr)';
    const slots = page === 'Q' ? ['q'] : page === 'A' ? Array.from({ length: DEFAULTS.autoSlots }, (_, i) => `a${i + 1}`) : Array.from({ length: DEFAULTS.saveSlotsPerPage }, (_, i) => String((Number(page) - 1) * DEFAULTS.saveSlotsPerPage + i + 1));
    for (const sl of slots) {
      const d = store.get(`save.${sl}`);
      const b = el('button', `slot${d ? '' : ' empty'}`);
      if (d?.thumb) { const im = el('img'); im.src = d.thumb; b.append(im); } else b.append(el('div', 'thumbph'));
      const m = el('div', 'meta'); m.append(el('b', null, slotName(sl)));
      if (d) { m.append(el('span', null, new Date(d.meta.t).toLocaleString('zh-CN', { hour12: false }))); m.append(el('span', 'scn', `${ROUTES.length > 1 && (d.meta.routeTitle || routeTitle(d.meta.route || d.st?.route)) ? `【${d.meta.routeTitle || routeTitle(d.meta.route || d.st?.route)}】` : ''}${d.meta.scene || ''}`)); m.append(el('span', null, `${d.meta.name ? d.meta.name + '：' : ''}${d.meta.text}`)); }
      else m.append(el('span', null, '— 空 —'));
      b.append(m);
      b.onclick = async () => {
        if (mode === 'save') {
          if (sl[0] === 'a') return toast('自动存档位只读');
          if (d && !(await confirmBox('覆盖这个存档？'))) return;
          if (await saveTo(sl)) { this.close(); this.saveload('save', page); }
        } else if (d) { if (ctl.mode !== 'game' || await confirmBox('读取这个存档？当前进度未保存的部分会丢失。')) loadFrom(sl); }
      };
      grid.append(b);
    }
    s.append(tabs, grid); this.show(s, 'saveload');
  },
  config() {
    const s = this.frame('设置', 'config');
    const g = el('div', 'cfg');
    const slider = (label, get, set, min, max, step) => {
      const lab = el('label', null, label); const r = el('input'); r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = get();
      r.id = `cfg-${g.children.length}`; lab.htmlFor = r.id; r.setAttribute('aria-label', label); g.append(lab);
      r.oninput = () => { set(Number(r.value)); saveCfg(); audio.applyVol(); }; g.append(r);
    };
    const toggle = (label, opts, get, set) => {
      g.append(el('label', null, label)); const row = el('div', 'row');
      if (opts.every(([v]) => typeof v === 'boolean')) {
        // 开/关类设置：role=switch 的按钮（Tab 可达，Enter/空格切换），皮肤图 ui_toggle_on/off，热区 88×44
        const on = opts.find(([v]) => v === true)[1], off = opts.find(([v]) => v === false)[1];
        const sw = el('button', 'switch'); sw.setAttribute('role', 'switch'); sw.setAttribute('aria-label', label);
        const st = el('span', 'swtext');
        const paint = () => { const c = !!get(); sw.setAttribute('aria-checked', String(c)); sw.classList.toggle('on', c); st.textContent = c ? on : off; };
        sw.onclick = () => { set(!get()); saveCfg(); paint(); audio.ui('click'); };
        paint(); row.append(sw, st); g.append(row); return;
      }
      for (const [v, t] of opts) { const b = el('button', `btn${get() === v ? ' on' : ''}`, t); b.onclick = () => { set(v); saveCfg(); [...row.children].forEach((x) => x.classList.remove('on')); b.classList.add('on'); view.applyDanger?.(vm.st, false); }; row.append(b); }
      g.append(row);
    };
    slider('主音量', () => cfg.vol.master, (v) => (cfg.vol.master = v), 0, 1, 0.05);
    slider('BGM', () => cfg.vol.bgm, (v) => (cfg.vol.bgm = v), 0, 1, 0.05);
    slider('音效', () => cfg.vol.se, (v) => (cfg.vol.se = v), 0, 1, 0.05);
    slider(NOVOICE ? '语气词音量' : '语音', () => cfg.vol.voice, (v) => (cfg.vol.voice = v), 0, 1, 0.05);
    slider('环境音', () => cfg.vol.amb, (v) => (cfg.vol.amb = v), 0, 1, 0.05);
    slider('文字速度', () => cfg.textSpeed, (v) => (cfg.textSpeed = v), 10, 200, 5);
    slider('自动等待（ms）', () => cfg.autoWait, (v) => (cfg.autoWait = v), 300, 5000, 100);
    slider('文字框不透明度', () => cfg.tbOpacity, (v) => { cfg.tbOpacity = v; stage.style.setProperty('--tb-op', v); }, 0.2, 1, 0.05);
    slider('竖屏亮度（%）', () => Math.round(cfg.portraitDim * 100), (v) => { cfg.portraitDim = clampDim(v / 100); orient.apply(); }, 10, 100, 1);
    toggle('跳过', [[false, '仅已读'], [true, '全部']], () => cfg.skipUnread, (v) => (cfg.skipUnread = v));
    toggle('语气词', [[true, '开'], [false, '关']], () => cfg.interj, (v) => (cfg.interj = v));
    toggle('H 场景语气词', [[true, '开'], [false, '关']], () => cfg.interjH, (v) => (cfg.interjH = v));
    if (!NOVOICE) toggle('翻页停止语音', [[true, '是'], [false, '否']], () => cfg.voiceStop, (v) => (cfg.voiceStop = v));
    toggle('危险演出', [['normal', '标准'], ['weak', '减弱（不震屏）']], () => cfg.dangerFx, (v) => (cfg.dangerFx = v));
    toggle('H 特效', [[true, '开'], [false, '关']], () => cfg.hfx !== false, (v) => { cfg.hfx = v; if (v) hfx.restore(vm.st); else hfx.clear(0); });
    g.append(el('label', null, '其他')); const row = el('div', 'row');
    if (document.fullscreenEnabled) { const f = el('button', 'btn', '全屏'); f.onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {})); row.append(f); }
    if (ctl.mode === 'game') {
      if (vm.st.h) { const b = el('button', 'btn', vm.st.recall ? '结束回想' : '跳过本段 H'); b.onclick = () => { this.closeAll(); ctl.handle(vm.skipH()); }; row.append(b); }
      const t = el('button', 'btn', '回到标题'); t.onclick = async () => { if (await confirmBox('回到标题？未保存的进度会丢失。')) ctl.toTitle(); }; row.append(t);
    }
    g.append(row);
    s.append(g); this.show(s, 'config');
  },
  backlog() {
    const s = this.frame('记录', 'backlog'); const list = el('div', 'log');
    for (const b of backlog) {
      const r = el('div', `row${b.choice ? ' choice-row' : ''}`);
      r.append(el('div', 'n', b.choice ? '选择' : (b.name || '')), el('div', 't', b.choice ? `→ ${b.text}` : b.text));
      if (b.voice && !NOVOICE) { const v = el('button', 'vbtn', document.body.classList.contains('sk-voice') ? '' : '▶'); v.title = '重放语音'; v.setAttribute('aria-label', '重放语音'); v.onclick = (e) => { e.stopPropagation(); audio.unlock(); audio.voice(b.voice); }; r.append(v); }
      list.append(r);
    }
    s.append(list); this.show(s, 'backlog'); list.scrollTop = list.scrollHeight;
  },
  recall(fromEnd = false, group = null) {
    if (fromEnd) { ctl.mode = 'title'; ctl.ev = null; this.closeAll(); view.clear(); vm.toTitle(); }
    const s = this.frame('回想', 'recall');
    const grid = el('div', 'grid'); grid.style.gridTemplateColumns = 'repeat(4, 256px)'; grid.classList.add('thumbs');
    const all = Object.values(P.hblocks), groups = orderGroups([...new Set(all.map(hGroup))]);
    const cur = groups.includes(group) ? group : groups.includes(store.get('grp.recall')) ? store.get('grp.recall') : (groups.find((g) => all.some((x) => hGroup(x) === g && sys.recall[x.id])) ?? groups[0]);
    const tabs = groupTabs('recall', groups, cur, (g) => { this.close(); this.recall(fromEnd, g); });
    if (tabs) s.append(tabs);
    for (const hb of all.filter((x) => groups.length <= 1 || hGroup(x) === cur)) {
      const ok = !!sys.recall[hb.id];
      const b = el('button', `thumb${ok ? '' : ' locked'}`);
      if (ok) { const tp = [`art/ui/thumb/thumb_${hb.id}.png`, `art/ui/thumb/thumb_${hb.cg}.png`].find(has); b.append(tp ? img(tp, '') : img(`art/cg/${hb.cg}.png`, hb.title)); }
      b.append(el('div', 'cap', ok ? hb.title : '？？？'));
      b.onclick = () => {
        if (!ok) return toast('尚未解锁');
        audio.unlock(); audio.ui('confirm');
        ctl.start(() => vm.startRecall(hb.id));
      };
      grid.append(b);
    }
    if (!Object.keys(P.hblocks).length) grid.append(el('div', null, '（暂无）'));
    s.append(grid); this.show(s, 'recall');
    // 回想界面 BGM
    audio.sync({ bgm: { id: DEFAULTS.recallBgm, vol: 1 }, loops: {}, amb: {} });
    if (fromEnd) s.querySelector('.close').onclick = () => this.title();
  },
  gallery(group = null) {
    const s = this.frame('CG 鉴赏', 'gallery');
    const grid = el('div', 'grid'); grid.style.gridTemplateColumns = 'repeat(4, 256px)'; grid.classList.add('thumbs');
    const all = Object.values(P.cgs), groups = orderGroups([...new Set(all.map(cgGroup))]);
    const cur = groups.includes(group) ? group : groups.includes(store.get('grp.gallery')) ? store.get('grp.gallery') : (groups.find((g) => all.some((x) => cgGroup(x) === g && sys.cg[x.id]?.base)) ?? groups[0]);
    const tabs = groupTabs('gallery', groups, cur, (g) => { this.close(); this.gallery(g); });
    if (tabs) s.append(tabs);
    for (const cg of all.filter((x) => groups.length <= 1 || cgGroup(x) === cur)) {
      const rec = sys.cg[cg.id] || {};
      const vars = ['base', ...cg.diffs].filter((d) => rec[d]);
      const ok = !!rec.base;
      const b = el('button', `thumb${ok ? '' : ' locked'}`);
      if (ok) { const tp = [`art/ui/thumb/thumb_${cg.id}_${vars.at(-1)}.png`, `art/ui/thumb/thumb_${cg.id}.png`].find(has); b.append(tp ? img(tp, '') : img(`art/cg/${cg.id}.png`, cg.title || cg.id)); }
      b.append(el('div', 'cap', ok ? (cg.title || cg.id) : '？？？'), el('div', 'cnt', `${vars.length}/${cg.total ?? 1 + cg.diffs.length}`));
      b.onclick = () => { if (!ok) return toast('尚未解锁'); this.viewer(cg, vars); };
      grid.append(b);
    }
    s.append(grid); this.show(s, 'gallery');
  },
  viewer(cg, vars) {
    const s = el('div', 'viewer'); s._name = 'viewer'; let i = 0;
    const draw = () => {
      s.replaceChildren(img(`art/cg/${cg.id}.png`, cg.id, 'fit'));
      if (vars[i] !== 'base') s.append(img(`art/cg/${cg.id}_${vars[i]}.png`, `${cg.id} 差分 ${vars[i]}`, 'fit'));
      const h = el('div', 'hint', `${cg.title || cg.id}　${i + 1}/${vars.length}　轻触切换差分 · 右上返回`); s.append(h);
      const x = el('button', 'btn close', '返回'); x.style.cssText = 'position:absolute;right:64px;top:24px'; x.onclick = (e) => { e.stopPropagation(); this.close(); }; s.append(x);
    };
    s.onclick = () => { i = (i + 1) % vars.length; draw(); };
    s.oncontextmenu = (e) => { e.preventDefault(); this.close(); };
    draw(); this.show(s, 'viewer');
  },
};
function confirmBox(msg) {
  return new Promise((res) => {
    const s = el('div', 'screen'); s._name = 'confirm'; s.style.cssText = 'justify-content:center;align-items:center;gap:32px;background:rgba(26,18,12,.8)';
    s.append(el('div', null, msg)); const row = el('div'); row.style.cssText = 'display:flex;gap:24px';
    const y = el('button', 'btn', '确定'), n = el('button', 'btn', '取消');
    y.style.minWidth = n.style.minWidth = '200px';
    y.onclick = () => { screens.close(); res(true); }; n.onclick = () => { screens.close(); res(false); };
    row.append(y, n); s.append(row); screens.show(s, 'confirm');
  });
}

// ---------------- 快捷按钮 ----------------
const QLABEL = { skip: '跳过', auto: '自动', log: '记录', save: '存档', load: '读档', config: '设置', hide: '隐藏' };
const qbtn = (id) => $(`#quick [data-q="${id}"]`);
function buildQuick() {
  const q = $('#quick'); q.replaceChildren();
  for (const id of Object.keys(QLABEL)) {
    const b = el('button', 'qbtn', QLABEL[id]); b.dataset.q = id;
    b.setAttribute('aria-label', QLABEL[id]);
    if (skin(`ui_btn_${id}_n`)) {
      // 常态 / 按下态（_p 缺图时按下仍用常态图）走 CSS 变量，:active 与开启状态（跳过/自动）切到 _p
      b.classList.add('skinned'); b.style.setProperty('--bn', `url(${R(`art/ui/ui_btn_${id}_n.png`)})`);
      b.style.setProperty('--bp', `url(${R(skin(`ui_btn_${id}_p`) ? `art/ui/ui_btn_${id}_p.png` : `art/ui/ui_btn_${id}_n.png`)})`);
      b.textContent = ''; b.title = QLABEL[id];
    }
    b.onclick = (e) => {
      e.stopPropagation(); audio.unlock(); audio.ui('click');
      if (ctl.mode !== 'game') return;
      ({
        skip: () => ctl.setSkip(!ctl.skip), auto: () => ctl.setAuto(!ctl.auto), log: () => screens.backlog(),
        save: () => screens.saveload('save'), load: () => screens.saveload('load'), config: () => (L.portrait && L.p.narrow ? qmenu() : screens.config()),
        hide: () => { ctl.userHide = true; view.applyUi(vm.st); },
      })[id]();
    };
    q.append(b);
  }
}

// 窄竖屏（<352）的“菜单”：读档 / 设置 / 隐藏（UI_SPEC §13.6）
function qmenu() {
  const s = screens.frame('菜单', 'qmenu'); const col = el('div', 'cfg');
  for (const [t, f] of [['读档', () => screens.saveload('load')], ['设置', () => screens.config()], ['隐藏', () => { screens.close(); ctl.userHide = true; view.applyUi(vm.st); }]]) {
    const b = el('button', 'btn', t); b.style.height = '56px'; b.onclick = () => { audio.ui('click'); f(); }; col.append(b);
  }
  s.append(col); screens.show(s, 'qmenu');
}

// ---------------- 布局 ----------------
let L;
const probe = el('div'); probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'; document.body.append(probe);
function relayout() {
  const cs = getComputedStyle(probe);
  const inset = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
  L = computeLayout(window.innerWidth, window.innerHeight, inset);
  const de = document.documentElement;
  if (L.portrait) {
    // 竖屏（UI_SPEC §13）：只有图像层缩放，UI 按 portrait.css 固定 CSS px 排在下方；清掉横屏写的内联坐标
    const p = L.p = portraitLayout(L.vw, L.vh, inset);
    stage.style.transform = 'none';
    de.style.setProperty('--p-top', `${p.safeTop}px`); de.style.setProperty('--p-sh', `${p.stage.h}px`);
    de.style.setProperty('--p-scale', String(p.stage.scale)); de.style.setProperty('--p-bot', `${p.safeBottom}px`);
    p.narrow ? (de.dataset.narrow = '1') : delete de.dataset.narrow;
    for (const e of [$('#textbox'), $('#namebox'), $('#text'), ...document.querySelectorAll('.qbtn'), $('#hud'), $('#danger-meter')]) for (const k of ['left', 'top', 'width', 'height', 'right']) e.style[k] = '';
    for (const b of document.querySelectorAll('#choices .choice')) for (const k of ['left', 'top', 'width', 'height']) b.style[k] = '';
    const cb = qbtn('config'); if (cb && !cb.classList.contains('skinned')) cb.textContent = p.narrow ? '菜单' : QLABEL.config;
    stage.style.setProperty('--hot', '44px');
    if (screens.open === 'title') screens.title();
    return;
  }
  delete de.dataset.narrow;
  { const cb = qbtn('config'); if (cb && !cb.classList.contains('skinned')) cb.textContent = QLABEL.config; }
  stage.style.transform = `translate(${L.offX}px, ${L.offY}px) scale(${L.scale})`;
  stage.style.setProperty('--hot', `${L.hot}px`);
  for (const r of hotspots(L)) {
    const e = r.id === 'textbox' ? $('#textbox') : r.id === 'namebox' ? $('#namebox') : r.id === 'text' ? $('#text') : qbtn(r.id);
    if (!e) continue; Object.assign(e.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px` }); if (r.id !== 'text') e.style.height = `${r.h}px`;
  }
  $('#hud').style.left = `${L.safe.left}px`; $('#hud').style.top = `${L.safe.top}px`;
  $('#danger-meter').style.right = `${L.safe.right}px`; $('#danger-meter').style.top = `${L.safe.top}px`;
  // 竖屏不再挡住画面：同一套等比缩放（上下黑边）+ 防偷窥压暗图像层（core/orient.mjs）
  if (screens.open === 'title') screens.title();
  if (ctl.ev?.type === 'choice' && $('#choices').classList.contains('on')) ctl.showChoice(ctl.ev);
}

// ---------------- 输入 ----------------
stage.addEventListener('click', (e) => { if (e.target.closest('.qbtn, .choice, .screen, .viewer')) return; ctl.click(); });
stage.addEventListener('contextmenu', (e) => { if (e.target.closest('.screen, .viewer')) return; e.preventDefault(); if (ctl.mode === 'game' && !screens.open) { ctl.userHide = !ctl.userHide; view.applyUi(vm.st); } });
stage.addEventListener('wheel', (e) => { if (ctl.mode === 'game' && !screens.open && e.deltaY < 0) screens.backlog(); }, { passive: true });
window.addEventListener('keydown', (e) => {
  if (ctl.mode !== 'game') return;
  if (e.key === 'Escape') { screens.open ? screens.close() : screens.config(); return; }
  if (screens.open) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctl.click(); }
  else if (e.key === 'Control' && !ctl.skip) ctl.setSkip(true);
  else if (e.key === 'a') ctl.setAuto(!ctl.auto);
  else if (e.key === 'F5') { e.preventDefault(); saveTo('q'); }
  else if (e.key === 'F9') { e.preventDefault(); loadFrom('q'); }
});
window.addEventListener('keyup', (e) => { if (e.key === 'Control' && ctl.skip) ctl.setSkip(false); });
const orient = watchOrientation(document.documentElement, null, () => cfg.portraitDim);
window.addEventListener('resize', relayout);
window.addEventListener('orientationchange', () => setTimeout(relayout, 200));
document.addEventListener('visibilitychange', () => { if (!audio.ctx) return; document.hidden ? audio.ctx.suspend() : audio.ctx.resume(); });
// 快速存读：长按“存档/读档”按钮 0.6s
for (const [id, fn] of [['save', () => saveTo('q')], ['load', () => loadFrom('q')]]) {
  let t = 0;
  document.addEventListener('pointerdown', (e) => { if (e.target.closest(`[data-q="${id}"]`)) t = setTimeout(() => { t = -1; fn(); }, 600); });
  document.addEventListener('pointerup', (e) => { if (t > 0) clearTimeout(t); if (t === -1 && e.target.closest(`[data-q="${id}"]`)) { e.target.closest('button').addEventListener('click', (ev) => ev.stopImmediatePropagation(), { once: true, capture: true }); } t = 0; });
}

// 竖屏：长按文字面板 = 隐藏 UI 看 stage（UI_SPEC §13.3）
{ let t = 0, fired = false;
  stage.addEventListener('pointerdown', (e) => { fired = false; if (!L?.portrait || ctl.mode !== 'game' || screens.open || !e.target.closest('#textbox')) return; t = setTimeout(() => { fired = true; ctl.userHide = true; view.applyUi(vm.st); }, 600); });
  stage.addEventListener('pointerup', () => clearTimeout(t));
  stage.addEventListener('click', (e) => { if (fired) { fired = false; e.stopImmediatePropagation(); } }, true);
}

// ---------------- 启动 ----------------
stage.style.setProperty('--tb-op', cfg.tbOpacity);
buildQuick(); relayout();
screens.splash();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW 注册失败', e));
window.__onsen = { routes: ROUTES, vm, ctl, view, audio, screens, game, saveTo, loadFrom, cfg, orient, hud, hfx }; // 调试用
