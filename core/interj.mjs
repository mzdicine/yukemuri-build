// 句末语气词：纯判断逻辑（浏览器播放与 smoke 共用）。规则见 INTERJ_SPEC_DRAFT §2。
import { DEFAULTS } from './defaults.mjs';

/**
 * 决定这句台词配哪个情绪的语气词。
 * @param ev     VM 的 text 事件（speaker, expr, curExpr, text, voice, interj, inH, danger）
 * @param ctx    { bank: {chara:{emo:[id…]}}, hasVoice(id)->bool, enabled, enabledH, skip }
 * @returns {{chara, emo, reason}|{skip:string}}
 */
export function decideInterj(ev, ctx, cfg = DEFAULTS.interj) {
  const who = ev.speaker;
  if (!who || !cfg.chars.includes(who)) return { skip: 'speaker' };          // 旁白 / 临时名 / hero / husband / 未登记角色
  const bank = ctx.bank?.[who];
  if (!bank) return { skip: 'nobank' };
  if (ctx.skip) return { skip: 'skip' };
  if (!ctx.enabled) return { skip: 'off' };
  if (ev.inH && (!cfg.inH || !ctx.enabledH)) return { skip: 'offH' };
  if (ev.danger && !ev.dzEvent && !cfg.inDanger && !(cfg.dangerOk || []).includes(ev.interj)) return { skip: 'danger' }; // N-dz1：随机事件正文里整条不生效 // @interj muffled 例外：危险中也照样播
  // 真语音存在才让位；无语音版（ctx.noVoice）一律当没有整句语音——是否配语气词只看下面的映射规则，「语音没加载」本身不是配的理由
  if (ev.voice && !ctx.noVoice && ctx.hasVoice?.(ev.voice)) return { skip: 'voice' };
  if (ev.interj === 'none') return { skip: 'none' };
  let emo;
  if (ev.interj) emo = ev.interj;                                             // 手动覆盖
  else {
    const text = String(ev.text || '');
    if (cfg.endsWithInterjRe.test(text) && !cfg.questionRe.test(text)) return { skip: 'ends' };
    if (cfg.questionRe.test(text)) {
      // 句末问号 → question；但“……欸？”这种已经以语气词收尾的也不配
      if (cfg.endsWithInterjRe.test(text)) return { skip: 'ends' };
      emo = 'question';
    } else {
      const ex = ev.expr || ev.curExpr || null;
      const base = cfg.map[who] || {};
      const h = ev.inH ? cfg.mapH[who] || {} : {};
      emo = (ex && h[ex]) || (ex && base[ex]) || (ev.inH && h._default) || base._default || null;
    }
  }
  if (!ev.inH && (cfg.hOnly || []).includes(emo) && !ev.interj) emo = (cfg.map[who] || {})._default;
  if (emo === 'none') return { skip: 'none' };                                // 映射值 'none' = 不配
  if (!emo || !bank[emo]?.length) return { skip: 'noemo', emo };
  return { chara: who, emo };
}

/** 变体：同角色同情绪随机，且不与上一次相同 */
export function pickVariant(list, last, rnd = Math.random) {
  if (!list?.length) return null;
  if (list.length === 1) return list[0];
  const pool = list.filter((x) => x !== last);
  return pool[Math.floor(rnd() * pool.length) % pool.length];
}

/** 频率控制：everyN / minGapMs */
export class InterjGate {
  constructor(cfg = DEFAULTS.interj) { this.cfg = cfg; this.n = 0; this.lastT = -Infinity; this.last = {}; }
  allow(now) {
    this.n++;
    if (this.cfg.everyN > 1 && (this.n - 1) % this.cfg.everyN !== 0) return false;
    if (now - this.lastT < this.cfg.minGapMs) return false;
    this.lastT = now; return true;
  }
  pick(bank, chara, emo, rnd) { const k = `${chara}:${emo}`; const v = pickVariant(bank[chara][emo], this.last[k], rnd); this.last[k] = v; return v; }
}

/** 由音频文件列表登记语气词库：audio/interj/<角色>/<角色>_<情绪>_<两位>.ogg */
export function scanInterj(files) {
  const bank = {}, bad = [];
  for (const f of files) {
    const m = /^audio\/interj\/([^/]+)\/([^/]+)\.(ogg|m4a)$/.exec(f);
    if (!m) continue;
    const [, dir, id, ext] = m;
    const n = /^([a-z][a-z0-9]*)_([a-z0-9]+(?:_[a-z0-9]+)*)_([0-9]{2})$/.exec(id);
    if (!n || n[1] !== dir) { bad.push(f); continue; }
    if (ext === 'm4a' && files.includes(f.replace(/\.m4a$/, '.ogg'))) continue;
    const list = ((bank[dir] ||= {})[n[2]] ||= []);
    if (!list.includes(id)) list.push(id);
  }
  for (const c of Object.values(bank)) for (const l of Object.values(c)) l.sort();
  return { bank, bad };
}
