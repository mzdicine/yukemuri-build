// ADV 虚拟机：纯逻辑、可序列化，浏览器渲染与 Node（sim / smoke）共用。
// 关键规则：退出 H（正常 @h_end、跳出块、跳过、回想退出、读档离开、回标题）一律清空循环 SE 与环境音（BGM 不动）。
import { evalExpr } from './expr.mjs';
import { DEFAULTS } from './defaults.mjs';

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

export function newSystem() {
  return { read: {}, cg: {}, recall: {}, endings: {}, thresholds: {}, choices: {}, routeEnds: {} };
}

export function variantKey(cg) {
  if (!cg) return null;
  const parts = [cg.diff || 'base', ...[...(cg.layers || [])].sort()];
  return parts.join('+');
}

// 鉴赏/回想分组：CG 取 [cg] chara=，没写就取 id 前缀；回想取 H 块 id 前缀
export const cgGroup = (cg) => cg.chara || String(cg.id).split('_')[0];
export const hGroup = (hb) => String(hb.id).split('_')[0];

// 路线系统变量（跨存档）：clear_<路线>=该线有结局记录，end_<结局 id>=见过该结局
export function routeSysVars(program, sys) {
  const v = {};
  for (const r of program.routes || []) v[`clear_${r.id}`] = Object.keys(sys.routeEnds?.[r.id] || {}).length ? 1 : 0;
  for (const e of Object.keys(program.endings || {})) v[`end_${e}`] = sys.endings?.[e] ? 1 : 0;
  return v;
}
export function routeUnlocked(program, sys, route) {
  const r = typeof route === 'string' ? (program.routes || []).find((x) => x.id === route) : route;
  if (!r) return false;
  return !r.unlock || !!evalExpr(r.unlock, routeSysVars(program, sys));
}

export class VM {
  constructor(program, { hooks = {}, system = null, maxSteps = 20000 } = {}) {
    this.p = program;
    this.hooks = hooks;
    this.sys = system || newSystem();
    this.maxSteps = maxSteps;
    this.st = this.initialState();
  }

  initialState() {
    const vars = {};
    for (const [k, v] of Object.entries(this.p.vars)) vars[k] = v.init;
    return {
      pc: 0, cur: null, vars,
      bg: null, chars: {}, cg: null,
      audio: { bgm: null, loops: {}, amb: {} },
      h: null, recall: null, scene: null, uiHidden: false,
      danger: { active: false, kind: null },
      screen: {}, // 屏幕级 @fx（steam）：{ steam: { lv } }；换 @bg 自动关，进存档
      fx: { hearts: null }, // H 高潮特效持续状态（STAGING §12）：@hearts 档位；@moan 是瞬时的，不进存档
      last: null, ended: null, route: null,
    };
  }

  _hook(name, ...a) { const f = this.hooks[name]; if (f) return f(...a); }

  // start(标签) 或 start(标签, 路线 id)；不给路线时按入口标签找所属路线（单女主 = 默认路线）
  start(label = this.p.entry, route = null) {
    if (this.st.h) this.exitH('title');
    this.st = this.initialState();
    const rs = this.p.routes || [];
    this.st.route = route || rs.find((r) => r.entry === label)?.id || rs[0]?.id || null;
    const pc = this.p.labels[label];
    if (pc === undefined) throw new Error(`入口标签 *${label} 不存在`);
    this.st.pc = pc;
    return this.run();
  }

  // ---------- H ----------
  exitH(reason) {
    const st = this.st;
    if (!st.h) return false;
    const id = st.h.id;
    this._hook('hBeforeExit', reason, id, clone(st.audio), this);
    st.audio.loops = {};
    st.audio.amb = {};
    st.danger = { active: false, kind: null };
    st.fx = { hearts: null }; // §12.3：退出 H 块/回想时自动清除全部特效（与自动停音同处）
    st.h = null;
    this._hook('hExit', reason, id, this);
    return true;
  }

  skipH() {
    const st = this.st;
    if (!st.h) return null;
    const hb = this.p.hblocks[st.h.id];
    const inRecall = !!st.recall;
    this.exitH('skip');
    if (inRecall) return this._recallEnd();
    st.pc = hb.end + 1;
    return this.run();
  }

  startRecall(id, { allowLocked = false } = {}) {
    const hb = this.p.hblocks[id];
    if (!hb) throw new Error(`未知 h_block ${id}`);
    const rec = this.sys.recall[id];
    if (!rec && !allowLocked) throw new Error(`回想 ${id} 未解锁`);
    if (this.st.h) this.exitH('title');
    let st;
    if (rec && rec.snap) st = clone(rec.snap);
    else { st = this.initialState(); if (hb.cg) st.cg = { id: hb.cg, diff: null, layers: [] }; }
    st.h = null; st.recall = { id }; st.pc = hb.start; st.cur = null; st.ended = null;
    st.audio.loops = {}; st.audio.amb = {}; // 进回想不带入块外的循环音
    st.fx = { hearts: null };
    this.st = st;
    return this.run();
  }

  exitRecall() {
    const st = this.st;
    if (!st.recall) return;
    this.exitH('recall');
    const id = st.recall.id;
    st.recall = null; st.fx = { hearts: null };
    this._hook('recallExit', id, this);
  }

  _recallEnd() {
    const id = this.st.recall.id;
    if (this.st.h) this.exitH('recall');
    this.st.recall = null; this.st.fx = { hearts: null };
    this.st.ended = { recall: id };
    this._hook('recallExit', id, this);
    return { type: 'recallEnd', id };
  }

  // ---------- 存读档 ----------
  save(meta = {}) {
    const cur = this.st.cur ?? this.st.pc;
    const c = this.p.cmds[cur];
    return { v: 1, cur, key: c ? { lbl: c.lbl, off: c.off, op: c.op } : null, st: clone(this.st), meta };
  }

  load(data) {
    if (this.st.h) this.exitH('load');
    if (this.st.recall) this.exitRecall();
    const st = clone(data.st);
    let pc = data.cur;
    const c = this.p.cmds[pc];
    if (data.key && !(c && c.lbl === data.key.lbl && c.off === data.key.off)) {
      const found = this.p.cmds.findIndex((x) => x.lbl === data.key.lbl && x.off === data.key.off);
      if (found >= 0) pc = found;
    }
    for (const [k, v] of Object.entries(this.p.vars)) if (st.vars[k] === undefined) st.vars[k] = v.init;
    st.fx ||= { hearts: null };
    st.screen ||= {};
    if (st.route === undefined || st.route === null) st.route = (this.p.routes || [])[0]?.id || null; // 旧存档：归默认/第一条路线
    st.pc = pc; st.cur = null; st.ended = null;
    this.st = st;
    this._hook('loaded', this);
    return this.run();
  }

  toTitle() {
    if (this.st.h) this.exitH('title');
    if (this.st.recall) this.exitRecall();
    this.st = this.initialState();
  }

  // ---------- 选项 ----------
  visibleOptions(cmd) {
    return cmd.opts.map((o, i) => ({ ...o, i })).filter((o) => !o.cond || evalExpr(o.cond, this.st.vars));
  }

  choose(i) {
    const st = this.st;
    const cmd = this.p.cmds[st.cur];
    if (!cmd || cmd.op !== 'choice') throw new Error('当前不在选项');
    const opt = cmd.opts[i];
    if (!opt) throw new Error(`没有第 ${i} 个选项`);
    this.sys.choices[`${cmd.src}#${i}`] = 1;
    this._hook('chose', opt, cmd, this);
    st.pc = opt.to; st.cur = null;
    return this.run();
  }

  advance() { this.st.cur = null; return this.run(); }

  // ---------- 主循环 ----------
  run() {
    const st = this.st;
    const cmds = this.p.cmds;
    for (let steps = 0; steps < this.maxSteps; steps++) {
      if (st.pc >= cmds.length) return this._end('end', '结束');
      const pc = st.pc;
      const c = cmds[pc];
      if (this.trace) this.trace.add(pc);
      // 跳出 H 块：执行到块外指令即视为退出
      if (st.h && c.h !== st.h.id) {
        if (st.recall) return this._recallEnd();
        this.exitH('jumpout');
      }
      st.pc = pc + 1;
      switch (c.op) {
        case 'text': {
          st.cur = pc;
          const read = !!this.sys.read[c.key];
          this.sys.read[c.key] = 1;
          if (c.speaker && c.expr && st.chars[c.speaker]) { st.chars[c.speaker].expr = c.expr; this._hook('cmd', { op: 'char', chara: c.speaker, expr: c.expr, fromText: true }, this); }
          st.last = { speaker: c.speaker, name: c.name, text: c.text, voice: c.voice };
          if (c.voice) this._hook('sfx', { kind: 'voice', id: c.voice }, this);
          return { type: 'text', pc, read, speaker: c.speaker, name: c.name, expr: c.expr, text: c.text, voice: c.voice, key: c.key, h: c.h,
            interj: c.interj || null, curExpr: (c.speaker && st.chars[c.speaker]?.expr) || null, inH: !!st.h, danger: !!st.danger.active };
        }
        case 'choice': {
          st.cur = pc;
          const opts = this.visibleOptions(c).map((o) => ({ text: o.text, i: o.i, seen: !!this.sys.choices[`${c.src}#${o.i}`] }));
          return { type: 'choice', pc, inH: !!c.h, hstyle: !!c.hstyle, opts };
        }
        case 'wait': st.cur = pc; return { type: 'wait', pc, ms: c.ms };
        case 'jump': st.pc = c.to; break;
        case 'jmpif': if (evalExpr(c.cond, st.vars)) st.pc = c.to; break;
        case 'jmpifnot': if (!evalExpr(c.cond, st.vars)) st.pc = c.to; break;
        case 'set': this._set(c); break;
        case 'eof': break;
        case 'end':
          if (st.recall) return this._recallEnd();
          return this._end(c.ending, c.title);
        case 'hstart': {
          if (st.h) this.exitH('jumpout');
          const snap = clone(st); snap.h = null; snap.recall = null; snap.pc = pc; snap.cur = null;
          st.h = { id: c.id, snap: st.recall ? null : snap };
          this._hook('hEnter', c.id, this);
          break;
        }
        case 'hend': {
          const hs = st.h;
          if (st.recall) return this._recallEnd();
          this.exitH('end');
          if (hs && hs.snap) this._unlock('recall', c.id, null, { snap: hs.snap, title: this.p.hblocks[c.id]?.title });
          break;
        }
        case 'unlock':
          if (!st.recall) this._unlock(c.kind, c.id, c.diff, c.kind === 'recall' ? { snap: null, title: this.p.hblocks[c.id]?.title } : null);
          break;
        default: this._present(c);
      }
    }
    throw new Error(`疑似死循环：连续 ${this.maxSteps} 条指令没有遇到台词/选项（${cmds[st.pc]?.src}）`);
  }

  startRoute(id) {
    const r = (this.p.routes || []).find((x) => x.id === id);
    if (!r) throw new Error(`未知路线 ${id}`);
    return this.start(r.entry, r.id);
  }

  _end(ending, title) {
    const st = this.st;
    if (st.h) this.exitH('end');
    this.sys.endings[ending] = 1;
    if (st.route) ((this.sys.routeEnds ||= {})[st.route] ||= {})[ending] = 1; // 结局记录按路线存
    st.ended = { ending, title };
    st.cur = null;
    return { type: 'end', ending, title };
  }

  _unlock(kind, id, diff, extra) {
    if (kind === 'cg') {
      const rec = (this.sys.cg[id] ||= {});
      const k = diff || 'base';
      if (!rec[k]) { rec[k] = 1; this._hook('unlock', 'cg', id, k, this); }
    } else if (kind === 'recall') {
      const had = this.sys.recall[id];
      const snap = had?.snap || extra?.snap || null; // 回想用首次解锁时的快照
      this.sys.recall[id] = { title: extra?.title || id, snap, t: Date.now() };
      if (!had) this._hook('unlock', 'recall', id, null, this);
    }
  }

  _set(c) {
    const st = this.st;
    const def = this.p.vars[c.var] || { min: -Infinity, max: Infinity };
    const old = Number(st.vars[c.var] ?? 0);
    const v = evalExpr(c.expr, st.vars);
    let nv = c.mode === '+' ? old + v : c.mode === '-' ? old - v : v;
    if (Number.isFinite(def.min)) nv = Math.max(def.min, nv);
    if (Number.isFinite(def.max)) nv = Math.min(def.max, nv);
    st.vars[c.var] = nv;
    if (nv !== old) {
      this._hook('gauge', c.var, old, nv, !!c.silent, this);
      for (const t of def.th || []) if (old < t && nv >= t) {
        if (!st.recall) this.sys.thresholds[`${c.var}:${t}`] = 1;
        this._hook('threshold', c.var, t, this);
      }
    }
  }

  _present(c) {
    const st = this.st;
    const A = st.audio;
    switch (c.op) {
      case 'bg': {
        const time = c.time || st.bg?.time || 'day';
        st.bg = { loc: c.id, time, tint: c.tint || null };
        if (!c.keep) st.chars = {};
        st.cg = null;
        st.screen = {}; // §13.3②：换场自动关闭屏幕叠加
        break;
      }
      case 'daynight': if (st.bg) st.bg.time = c.time; break;
      case 'char': {
        const prev = st.chars[c.chara];
        const def = this.p.chars[c.chara] || {};
        const outfit = c.outfit || prev?.outfit || def.outfits?.[0] || 'default';
        const expr = c.expr || prev?.expr || def.expressions?.[0] || 'normal';
        const acc = c.acc === 'none' ? null : (c.acc || prev?.acc || def.defaultAcc || null);
        const pos = c.pos || prev?.pos || 'c';
        // 头顶特效：换表情/服装时淡出（清掉），fx=<名> 再加上；fx=none 清空
        let fx = prev?.fx && !(prev.expr !== expr || prev.outfit !== outfit) ? [...prev.fx] : [];
        if (c.fx === 'none') fx = []; else if (c.fx && !fx.includes(c.fx)) fx.push(c.fx);
        st.chars[c.chara] = { outfit, expr, acc, pos, ...(fx.length ? { fx } : {}) };
        break;
      }
      case 'hide': if (c.chara === 'all') st.chars = {}; else delete st.chars[c.chara]; break;
      case 'cg': {
        if (c.close) { st.cg = null; break; }
        if (c.id) {
          if (!st.cg || st.cg.id !== c.id) st.cg = { id: c.id, diff: null, layers: [] }; // 换 CG id 层自动清空
        } else if (!st.cg) { this._hook('warn', `${c.src}: @cg diff/层 但当前没有 CG`, this); break; }
        if (c.clear) st.cg.layers = [];
        if (c.diff !== null && c.diff !== undefined) st.cg.diff = c.diff === 'none' ? null : c.diff;
        for (const l of c.remove || []) st.cg.layers = st.cg.layers.filter((x) => x !== l);
        for (const l of c.add || []) if (!st.cg.layers.includes(l)) st.cg.layers.push(l);
        if (!st.recall) { this._unlock('cg', st.cg.id, 'base'); if (st.cg.diff) this._unlock('cg', st.cg.id, st.cg.diff); }
        break;
      }
      case 'bgm': A.bgm = { id: c.id, vol: c.vol ?? 1 }; break;
      case 'bgmstop': A.bgm = null; break;
      case 'se':
        if (c.loop) A.loops[c.id] = c.vol ?? 1;
        else this._hook('sfx', { kind: 'se', id: c.id, vol: c.vol }, this);
        break;
      case 'sestop':
        if (c.id === 'all') A.loops = {}; else delete A.loops[c.id];
        break;
      case 'ambient': A.amb[c.id] = c.vol ?? null; break;
      case 'ambientstop': if (c.id === 'all') A.amb = {}; else delete A.amb[c.id]; break;
      case 'ui': st.uiHidden = c.mode === 'hide'; break;
      case 'fx': {
        st.screen ||= {};
        const drop = (ch, n) => { if (!ch.fx) return; ch.fx = n ? ch.fx.filter((x) => x !== n) : []; if (!ch.fx.length) delete ch.fx; };
        if (c.all) { st.screen = {}; for (const ch of Object.values(st.chars)) drop(ch, null); break; }
        if (c.chara) { const ch = st.chars[c.chara]; if (!ch) { this._hook('warn', `${c.src}: @fx ${c.name} on=${c.chara} 但该角色不在场`, this); break; } ch.fx ||= []; if (!ch.fx.includes(c.name)) ch.fx.push(c.name); break; }
        if (c.lv !== undefined) { if (c.on) st.screen[c.name] = { lv: c.lv }; else delete st.screen[c.name]; break; }
        for (const ch of Object.values(st.chars)) drop(ch, c.name);
        break;
      }
      case 'hearts': st.fx ||= { hearts: null }; st.fx.hearts = c.stop ? null : { lv: c.lv, area: c.area, dur: c.dur ?? null }; break;
      case 'scene': st.scene = { code: c.code, title: c.title }; break;
      case 'danger': {
        // 引擎自动：上升 se_danger_up、结束 se_danger_clear、心跳循环（属循环 SE，@danger end / 退出 H 都会停）
        const D = DEFAULTS.danger;
        if (c.end) {
          const was = st.danger.active;
          st.danger = { active: false, kind: null };
          delete A.loops[D.heartbeat];
          if (was) this._hook('sfx', { kind: 'se', id: D.clearSe, engine: true }, this);
          break;
        }
        const def = this.p.vars.danger || { min: 0, max: 100 };
        const old = st.vars.danger || 0;
        let nv = c.mode === '+' ? old + c.n : c.mode === '-' ? old - c.n : c.n;
        nv = Math.max(def.min, Math.min(def.max, nv));
        st.vars.danger = nv;
        st.danger = { active: true, kind: c.kind || null };
        // 事件音：se= 优先（none = 不播）；否则按类型；不写类型不播
        const ev = c.se ? (c.se === 'none' ? null : c.se) : (c.kind ? D.kinds[c.kind] : null);
        if (ev) this._hook('sfx', { kind: 'se', id: ev, event: c.kind || 'custom' }, this);
        if (nv > old) this._hook('sfx', { kind: 'se', id: D.upSe, engine: true }, this);
        if (nv >= D.heartbeatMin) A.loops[D.heartbeat] = 1; else delete A.loops[D.heartbeat];
        this._hook('gauge', 'danger', old, nv, false, this);
        break;
      }
    }
    this._hook('cmd', c, this);
  }
}
