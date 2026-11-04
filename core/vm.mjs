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

// N-dz1：可复现的伪随机（mulberry32）。状态是一个 32 位整数，存在 st.dz.rng 里（进存档 → 读档后抽签结果不变）
export function dzRand(state) {
  const s = (state + 0x6D2B79F5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}
const hashStr = (str) => { let h = 2166136261; for (const ch of String(str)) h = Math.imul(h ^ ch.codePointAt(0), 16777619); return h >>> 0; };
export const dzTierOf = (peak) => DEFAULTS.danger.tiers.filter((t) => peak >= t).length;

// 按阶段抽签（DANGER_SPEC §4.2 / §6.2）：同一轮不重复；上一轮的第一个不当这一轮的第一个；exclude；slot1
export function dzDraw(pool, stage, last, rand) {
  const d = pool.draw[stage];
  if (!d) return { slots: {}, picked: [] };
  let n = d.n;
  if (d.extra && rand() * 100 < d.extra) n++;
  n = Math.min(2, n);
  const cand = pool.order.filter((id) => !(pool.exclude[stage] || []).includes(id));
  const picked = [];
  for (let k = 0; k < n; k++) {
    let c = cand.filter((x) => !picked.includes(x));
    if (k === 0 && last) { const alt = c.filter((x) => x !== last); if (alt.length) c = alt; } // 只剩它一个时只能放行
    if (!c.length) break;
    picked.push(c[Math.floor(rand() * c.length)]);
  }
  const slots = {};
  if (picked.length === 2) { slots[1] = picked[0]; slots[2] = picked[1]; }
  else if (picked.length === 1) slots[(pool.slot1 || []).includes(Number(stage)) ? 1 : rand() < 0.5 ? 1 : 2] = picked[0];
  return { slots, picked };
}

export class VM {
  constructor(program, { hooks = {}, system = null, maxSteps = 20000, seed = null } = {}) {
    this.p = program;
    this.hooks = hooks;
    this.sys = system || newSystem();
    this.maxSteps = maxSteps;
    this.seed = seed; // N-dz1：给定时抽签可复现（sim / smoke 用）；不给就每轮随机
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
      dz: null, // N-dz1 危险值玩法的这一轮（@danger_run start 建，见 _dzStart）
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
    // N-dz1：跳过 H 也跳过事件位；这一轮按 tier 0 结算、dzlust 归 0
    const run = st.dz;
    if (run && !run.done && !run.recall) {
      run.skipped = true; run.slots = {}; run.ev = null; run.held = false; run.fixed = null;
      const P = this.p.pools?.[run.pool];
      if (P?.dzlust) st.vars[P.dzlust] = 0;
    }
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
    st.danger = { active: false, kind: null };
    // N-dz1：回想里照样抽事件、照样计时（不加数值、不解锁、不留记录）；只回想块（_90）按固定版本走
    st.dz = null;
    const pools = this.p.pools || {};
    if (hb.recallOnly) st.dz = this._dzNewRun(null, { recall: true, special: true });
    else if (hb.slots?.length) {
      const pid = (rec?.snap?.dz?.pool && pools[rec.snap.dz.pool]) ? rec.snap.dz.pool : Object.keys(pools).find((k) => pools[k].chara === hb.chara);
      if (pid) {
        st.dz = this._dzNewRun(pid, { recall: true });
        st.vars.danger = 0; st.vars.danger_peak = 0;
        this._dzDrawInto(st.dz, st);
      }
    }
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
    if (st.dz === undefined) st.dz = null; // 旧存档：没有这一轮
    if (st.dz?.ev?.retKey) { // 事件子程序的返回点按 (标签, 偏移) 重新定位（脚本改过也能回到原句后面）
      const k = st.dz.ev.retKey, at = this.p.cmds[st.dz.ev.ret];
      if (!(at && at.lbl === k.lbl && at.off === k.off)) { const f = this.p.cmds.findIndex((x) => x.lbl === k.lbl && x.off === k.off); if (f >= 0) st.dz.ev.ret = f; }
    }
    this.st = st;
    this._noRisePc = st.dz?.ev || st.dz?.special ? pc : null; // 读档重放当前这句：不再 +2
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
    // N-dz1：限时选项选了 default（①）之后不再按句上涨；②③ 照涨
    if (cmd.timeout && st.dz) { const m = this._dzMode(cmd); if (m === 'event' || m === 'special') st.dz.held = i === cmd.def - 1; st.dz.ticks = 0; }
    st.pc = opt.to; st.cur = null;
    return this.run();
  }

  advance() { this.st.cur = null; return this.run(); }

  // ---------- N-dz1 危险值玩法 ----------
  // 限时选项按秒上涨：UI 在第 1、第 2 秒满时各调一次 dangerTick('sec')（+3）；第 3 秒满不加、直接超时选 default。
  // 只在随机事件 / 只回想块里、计量亮着时生效；每个选项最多 secMax 次；按秒不会打满（最多到 capNoFull）。返回新值或 null（没涨）
  dangerTick(kind = 'sec') {
    const st = this.st, D = DEFAULTS.danger;
    if (kind !== 'sec') return null;
    const c = this.p.cmds[st.cur];
    if (!c || c.op !== 'choice' || !c.timeout || !st.dz || !st.danger.active) return null;
    const m = this._dzMode(c);
    if (m !== 'event' && m !== 'special') return null;
    if ((st.dz.ticks || 0) >= D.secMax) return null;
    st.dz.ticks = (st.dz.ticks || 0) + 1;
    this._dzAdd(D.perSec, 'sec', { cap: D.capNoFull });
    return st.vars.danger;
  }

  // 回想列表（§6.7⑨）：_90 只回想块带 special:'danger'，排在同一女主 h02 块之后，没解锁也列出（unlocked:false）
  recall() {
    const all = Object.values(this.p.hblocks);
    const list = all.filter((h) => !h.recallOnly);
    for (const sp of all.filter((h) => h.recallOnly)) {
      const g = hGroup(sp);
      let at = -1;
      list.forEach((h, i) => { if (hGroup(h) === g && /_h02_/.test(h.id)) at = i; });
      if (at < 0) list.forEach((h, i) => { if (hGroup(h) === g) at = i; });
      list.splice(at < 0 ? list.length : at + 1, 0, sp);
    }
    return list.map((h) => ({ id: h.id, title: h.title, chara: h.chara, group: hGroup(h), cg: h.cg, unlocked: !!this.sys.recall[h.id], ...(h.special ? { special: h.special } : {}) }));
  }

  // 测试 / sim 用：直接把某个事件当子程序跑一遍（返回到 recallEnd 形式的终点，不动系统存档）
  debugEvent(pool, id) {
    const P = this.p.pools?.[pool]; const E = P?.events[id];
    if (!E) throw new Error(`未知事件 ${pool}/${id}`);
    this.st = this.initialState();
    this.st.dz = this._dzNewRun(pool, { recall: true });
    // 单独走事件时补上 CG 上下文：取这个池子角色的、带事件位的块里第一个事件位之前的 CG 状态（否则 @cg diff= 会报「当前没有 CG」）
    this.st.cg = this._dzSlotCg(P);
    this.st.dz.ev = { key: `${pool}:${id}`, id, ret: -1, retKey: null, entered: false, cg: this.st.cg ? { ...this.st.cg, layers: [...this.st.cg.layers] } : null };
    this.st.pc = E.start;
    return this.run();
  }

  _dzSlotCg(P) {
    const cmds = this.p.cmds; let cg = null;
    for (let i = 0; i < cmds.length; i++) {
      const c = cmds[i];
      if (c.op === 'eof') cg = null; // CG 状态按文件顺序线性推（@cg <id> 多写在块外、紧贴 @h_block 前）
      if (c.op === 'cg') {
        if (c.close) cg = null;
        else if (c.id) { if (!cg || cg.id !== c.id) cg = { id: c.id, diff: null, layers: [] }; }
        if (cg && !c.close) {
          if (c.clear) cg.layers = [];
          if (c.diff && c.diff !== 'prev') cg.diff = c.diff === 'none' ? null : c.diff;
          for (const l of c.add || []) if (!cg.layers.includes(l)) cg.layers.push(l);
          for (const l of c.remove || []) cg.layers = cg.layers.filter((x) => x !== l);
        }
      }
      if (c.op === 'dzslot' && c.h && cg && this.p.cgs?.[cg.id]?.chara === P.chara) return cg;
    }
    return null;
  }

  _dzNewRun(pool, extra = {}) {
    const P = this.p.pools?.[pool];
    let seed = this.seed !== null && this.seed !== undefined ? (this.seed ^ hashStr(`${pool}:${P ? this.st?.vars?.[P.stage] : ''}`)) >>> 0 : (Math.random() * 4294967296) >>> 0;
    if (extra.seed !== null && extra.seed !== undefined) seed = extra.seed >>> 0;
    return { pool, defuse: null, defuseTo: null, seed, rng: seed, slots: {}, picked: [], peak: 0, held: false, ticks: 0, ev: null, fixed: null,
      done: false, defused: false, skipped: false, recall: false, special: false, spCg: null, ...extra, ...(extra.seed !== undefined ? { seed } : {}) };
  }

  _dzDrawInto(run, st) {
    const P = this.p.pools?.[run.pool];
    if (!P) return;
    const stage = Number(st.vars[P.stage] ?? 0);
    const last = run.recall ? null : (st.vars[P.last] || null);
    const r = dzDraw(P, stage, last, () => { const [x, n] = dzRand(run.rng); run.rng = n; return x; });
    run.slots = r.slots; run.picked = r.picked; run.stage = stage;
    if (!run.recall && r.picked.length && P.last) st.vars[P.last] = r.picked[0];
  }

  // 当前指令属于哪种危险上下文：event（随机事件正文）/ special（只回想块）/ fixed（这一轮里的固定段）/ legacy（旧行为）
  _dzMode(c) {
    const st = this.st;
    if (c.ev && st.dz?.ev?.key === c.ev) return 'event';
    if (c.h && this.p.hblocks[c.h]?.recallOnly && st.dz?.special) return 'special';
    if (st.dz && !st.dz.done && !st.dz.recall) return 'fixed';
    return 'legacy';
  }

  _dzGauge(old, nv, reason) {
    this._hook('gauge', 'danger', old, nv, false, this, { value: nv, peak: this.st.dz?.peak ?? 0, kind: this.st.danger.kind || null, reason });
  }

  // 随机事件 / 只回想块里的涨落。返回 true = 满格（只在随机事件里、cap 允许到 100 时）
  _dzAdd(delta, reason, { cap = DEFAULTS.danger.full, peak = true } = {}) {
    const st = this.st, D = DEFAULTS.danger;
    const old = Number(st.vars.danger || 0);
    let nv = Math.max(0, Math.min(cap, old + delta));
    if (st.dz?.special && delta > 0) nv = Math.min(nv, D.capNoFull); // 只回想块：不触发满格
    st.vars.danger = nv;
    if (peak && st.dz && !st.dz.special && st.dz.ev) { st.dz.peak = Math.max(st.dz.peak, nv); if (!st.dz.recall) st.vars.danger_peak = st.dz.peak; else st.vars.danger_peak = st.dz.peak; }
    if (nv >= D.heartbeatMin && st.danger.active) st.audio.loops[D.heartbeat] = 1;
    if (nv !== old) this._dzGauge(old, nv, reason);
    return !!(st.dz?.ev && !st.dz.special && nv >= D.full);
  }

  _dzMeterOff(withClear) {
    const st = this.st, D = DEFAULTS.danger;
    const was = st.danger.active;
    st.danger = { active: false, kind: null };
    delete st.audio.loops[D.heartbeat];
    if (was && withClear) this._hook('sfx', { kind: 'se', id: D.clearSe, engine: true }, this);
    this._hook('cmd', { op: 'danger', end: true, dz: true }, this);
  }

  // 满格（§6.2b）：屏住呼吸 → 收计量（化解音只播一次）→ 像跳过一样离开 H（不走 @h_end、不解锁回想）→ 按事件分流到化解标签
  _dzDefuse() {
    const st = this.st, run = st.dz, P = this.p.pools?.[run.pool];
    const id = run.ev?.id;
    run.peak = Math.max(run.peak, DEFAULTS.danger.full);
    this._hook('defuse', { text: P?.toast || DEFAULTS.danger.defuseText, event: id, pool: run.pool, recall: !!run.recall }, this);
    this._dzMeterOff(true);
    st.vars.danger = 0;
    run.ev = null; run.slots = {}; run.held = false; run.ticks = 0;
    st.cur = null;
    if (st.recall) return this._recallEnd();
    run.defused = true;
    st.vars.danger_peak = run.peak; st.vars.danger_defused = 1;
    if (P?.dzlust) st.vars[P.dzlust] = 0;
    this.exitH('defuse');
    const lb = run.defuseTo?.[id] || run.defuse;
    const to = this.p.labels[lb];
    if (to === undefined) throw new Error(`满格化解标签 *${lb} 不存在`);
    st.pc = to;
    return null;
  }

  _dzRunCmd(c) {
    const st = this.st, D = DEFAULTS.danger;
    if (c.mode === 'start') {
      if (st.recall) return;
      const P = this.p.pools?.[c.pool];
      if (!P) throw new Error(`${c.src}: 未知事件池 ${c.pool}`);
      st.dz = null;
      const run = this._dzNewRun(c.pool, { defuse: c.defuse, defuseTo: c.defuseTo || null, ...(c.seed !== null && c.seed !== undefined ? { seed: c.seed } : {}) });
      st.dz = run;
      st.vars.danger = 0; st.vars.danger_peak = 0; st.vars.danger_tier = 0; st.vars.danger_defused = 0;
      if (P.dzlust) st.vars[P.dzlust] = 0;
      if (st.danger.active) this._dzMeterOff(false);
      this._dzDrawInto(run, st);
      this._hook('dzRun', 'start', { pool: c.pool, stage: run.stage, slots: { ...run.slots }, seed: run.seed }, this);
      return;
    }
    // end：只结算一次；没有这一轮（旧存档）= 安全空操作，tier=0
    const run = st.dz;
    if (!run) { st.vars.danger_tier = 0; return; }
    if (run.done || run.recall) return;
    const P = this.p.pools?.[run.pool];
    const tier = run.defused || run.skipped ? 0 : dzTierOf(run.peak);
    st.vars.danger_tier = tier;
    const replay = P?.replay ? Number(st.vars[P.replay] || 0) !== 0 : false;
    let lust = 0, aff = 0;
    if (!run.defused && !run.skipped && !replay && P) {
      lust = (D.tierLust[tier] || 0) + Number(P.dzlust ? st.vars[P.dzlust] || 0 : 0);
      aff = tier === 3 ? D.tier3Aff : 0;
      if (lust && P.lust) this._dzSetVar(P.lust, lust);
      if (aff && P.aff) this._dzSetVar(P.aff, aff);
    }
    if (st.danger.active) this._dzMeterOff(false);
    st.vars.danger = 0;
    run.done = true; run.slots = {}; run.ev = null; run.fixed = null; run.held = false;
    this._hook('dzRun', 'end', { pool: run.pool, tier, peak: run.peak, defused: run.defused, skipped: run.skipped, replay, lust, aff }, this);
  }

  // 结算奖励：和普通 @add 一样走钳制 / gauge / 阈值钩子
  _dzSetVar(name, delta) {
    this._set({ var: name, mode: '+', expr: { k: 'n', v: delta }, silent: false });
  }

  _dzSlot(c, pc) {
    const st = this.st, run = st.dz;
    if (!run || run.done || run.skipped || run.defused || run.special || run.ev) return;
    const id = run.slots[c.n];
    if (!id) return; // 没分到事件的位直接跳过
    delete run.slots[c.n];
    const E = this.p.pools[run.pool].events[id];
    const nx = this.p.cmds[pc + 1];
    run.ev = { key: `${run.pool}:${id}`, id, ret: pc + 1, retKey: nx ? { lbl: nx.lbl, off: nx.off } : null, entered: false, cg: null };
    run.held = false; run.ticks = 0;
    st.pc = E.start;
  }

  // @danger_event 开头：起始值 + 事件音 + 计量登场
  _dzEvStart(c) {
    const st = this.st, run = st.dz, D = DEFAULTS.danger;
    const f = run?.ev;
    if (!f || f.key !== `${c.pool}:${c.id}` || f.entered) { st.pc = c.endAt + 1; return null; } // 顺序执行掉进事件块：整块跳过
    f.entered = true;
    f.cg = st.cg ? { id: st.cg.id, diff: st.cg.diff, layers: [...st.cg.layers] } : null; // diff=prev 用（含叠加层）
    run.held = false;
    const old = Number(st.vars.danger || 0);
    st.danger = { active: true, kind: c.kind || null };
    const ev = c.se ? (c.se === 'none' ? null : c.se) : (c.kind ? D.kinds[c.kind] : null);
    if (ev) this._hook('sfx', { kind: 'se', id: ev, event: c.kind || 'custom' }, this);
    const nv = Math.min(D.full, old + c.add);
    if (nv > old) this._hook('sfx', { kind: 'se', id: D.upSe, engine: true }, this);
    const full = this._dzAdd(c.add, 'event');
    if (st.vars.danger >= D.heartbeatMin) st.audio.loops[D.heartbeat] = 1;
    this._hook('cmd', { op: 'danger', mode: '+', n: c.add, kind: c.kind, se: c.se, dz: 'event', src: c.src }, this);
    if (full) return this._dzDefuse() || 'cont';
    return null;
  }

  // @end_event：先发 gauge(reason 'end'，新值 = 40%)，再收计量；回到事件位下一句
  _dzEvEnd(c) {
    const st = this.st, run = st.dz, D = DEFAULTS.danger;
    const f = run?.ev;
    if (!f) return null;
    const old = Number(st.vars.danger || 0);
    const nv = Math.floor(old * D.endKeep);
    st.vars.danger = nv;
    this._dzGauge(old, nv, 'end');
    this._dzMeterOff(true);
    run.ev = null; run.held = false; run.ticks = 0;
    if (f.ret === -1) return { type: 'recallEnd', id: '__dz_event' }; // debugEvent
    st.pc = f.ret;
    return null;
  }

  // @danger：按上下文分派。返回 run() 要交出去的事件（满格化解进回想结束）或 null
  _dzDanger(c) {
    const st = this.st, D = DEFAULTS.danger;
    const m = this._dzMode(c);
    if (m === 'legacy') { this._present(c); return null; }
    if (m === 'fixed') {
      // 固定段：值不计入 peak、不会满格；用独立底数（0）算，@danger end 后恢复成固定段前的随机累计值
      const run = st.dz;
      if (c.end) {
        const wasFixed = !!run.fixed;
        this._present(c);
        if (wasFixed) { const old = st.vars.danger; st.vars.danger = run.fixed.saved; run.fixed = null; if (old !== st.vars.danger) this._dzGauge(old, st.vars.danger, 'fixed'); }
        return null;
      }
      if (!run.fixed) { run.fixed = { saved: Number(st.vars.danger || 0) }; st.vars.danger = 0; }
      this._present(c, { reason: 'fixed' });
      return null;
    }
    // event / special
    if (c.end) {
      const old = Number(st.vars.danger || 0), nv = Math.floor(old * D.endKeep);
      st.vars.danger = nv;
      if (old !== nv) this._dzGauge(old, nv, 'end');
      this._dzMeterOff(true);
      st.dz.held = false; st.dz.ticks = 0;
      return null;
    }
    const old = Number(st.vars.danger || 0);
    if (!st.danger.active && m === 'special') st.dz.spCg = st.cg ? { id: st.cg.id, diff: st.cg.diff, layers: [...st.cg.layers] } : null;
    st.danger = { active: true, kind: c.kind || st.danger.kind || null };
    const evSe = c.se ? (c.se === 'none' ? null : c.se) : (c.kind ? D.kinds[c.kind] : null);
    if (evSe) this._hook('sfx', { kind: 'se', id: evSe, event: c.kind || 'custom' }, this);
    const target = c.mode === '+' ? old + c.n : c.mode === '-' ? old - c.n : c.n;
    const full = this._dzAdd(target - old, m === 'special' && !c.kind ? 'choice' : m === 'special' ? 'event' : 'choice', { cap: m === 'special' ? D.capNoFull : D.full });
    if (st.vars.danger > old) this._hook('sfx', { kind: 'se', id: D.upSe, engine: true }, this);
    if (st.vars.danger >= D.heartbeatMin) st.audio.loops[D.heartbeat] = 1; else delete st.audio.loops[D.heartbeat];
    this._hook('cmd', c, this);
    if (full) return this._dzDefuse() || 'cont';
    return null;
  }

  // ---------- 主循环 ----------
  run() {
    const st = this.st;
    const cmds = this.p.cmds;
    for (let steps = 0; steps < this.maxSteps; steps++) {
      if (st.pc >= cmds.length) return this._end('end', '结束');
      const pc = st.pc;
      const c = cmds[pc];
      if (this.trace) this.trace.add(pc);
      // 跳出 H 块：执行到块外指令即视为退出（N-dz1：事件位调用的事件正文算在 H 块里，H 状态不断）
      if (st.h && c.h !== st.h.id && !(c.ev && st.dz?.ev?.key === c.ev)) {
        if (st.recall) return this._recallEnd();
        this.exitH('jumpout');
      }
      st.pc = pc + 1;
      switch (c.op) {
        case 'text': {
          // N-dz1：随机事件 / 只回想块里，计量亮着时每推进一句 +2（选 ① 之后不涨；读档重放这句不重复加）
          if (st.dz && st.danger.active && !st.dz.held && this._noRisePc !== pc) {
            const m = this._dzMode(c);
            if (m === 'event' || m === 'special') {
              if (this._dzAdd(DEFAULTS.danger.perLine, 'line', { cap: m === 'special' ? DEFAULTS.danger.capNoFull : DEFAULTS.danger.full })) {
                const r = this._dzDefuse(); if (r) return r; break;
              }
            }
          }
          this._noRisePc = null;
          st.cur = pc;
          const read = !!this.sys.read[c.key];
          this.sys.read[c.key] = 1;
          if (c.speaker && c.expr && st.chars[c.speaker]) { st.chars[c.speaker].expr = c.expr; this._hook('cmd', { op: 'char', chara: c.speaker, expr: c.expr, fromText: true }, this); }
          st.last = { speaker: c.speaker, name: c.name, text: c.text, voice: c.voice };
          if (c.voice) this._hook('sfx', { kind: 'voice', id: c.voice }, this);
          return { type: 'text', pc, read, speaker: c.speaker, name: c.name, expr: c.expr, text: c.text, voice: c.voice, key: c.key, h: c.h,
            interj: c.interj || null, curExpr: (c.speaker && st.chars[c.speaker]?.expr) || null, inH: !!st.h, danger: !!st.danger.active,
            ...(c.ev && st.dz?.ev ? { dzEvent: true } : {}) };
        }
        case 'choice': {
          st.cur = pc;
          this._noRisePc = null;
          const opts = this.visibleOptions(c).map((o) => ({ text: o.text, i: o.i, seen: !!this.sys.choices[`${c.src}#${o.i}`], ...(o.hush ? { hush: true } : {}) }));
          const ev = { type: 'choice', pc, inH: !!c.h || !!(c.ev && st.h), hstyle: !!c.hstyle, opts };
          if (c.timeout) {
            // N-dz1 限时选项：UI 计时（VM 不碰真实时间）；default = 超时要 choose 的选项下标（被条件隐藏时取第一个可见项）
            const d = opts.find((o) => o.i === c.def - 1) || opts[0];
            Object.assign(ev, { timeout: c.timeout, default: d ? d.i : 0, hush: opts.some((o) => o.hush) });
            if (st.dz) st.dz.ticks = 0;
          }
          this._hook('choice', ev, this);
          return ev;
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
        // ---------- N-dz1 ----------
        case 'danger': { const r = this._dzDanger(c); if (r && r !== 'cont') return r; break; }
        case 'dzrun': this._dzRunCmd(c); break;
        case 'dzslot': this._dzSlot(c, pc); break;
        case 'dzev': { const r = this._dzEvStart(c); if (r && r !== 'cont') return r; break; }
        case 'dzevend': { const r = this._dzEvEnd(c); if (r) return r; break; }
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

  _present(c, dzInfo = null) {
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
        if (c.diff === 'prev') {
          // N-dz1：回到进入事件时的差分，叠加层（blush / sweat / smoke…）一起恢复
          const snap = st.dz?.ev?.cg || st.dz?.spCg || null;
          if (snap && snap.id === st.cg.id) { st.cg.diff = snap.diff; st.cg.layers = [...snap.layers]; }
        } else if (c.diff !== null && c.diff !== undefined) st.cg.diff = c.diff === 'none' ? null : c.diff;
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
        this._hook('gauge', 'danger', old, nv, false, this, { value: nv, peak: st.dz?.peak ?? 0, kind: st.danger.kind, reason: dzInfo?.reason || 'fixed' });
        break;
      }
    }
    this._hook('cmd', c, this);
  }
}
