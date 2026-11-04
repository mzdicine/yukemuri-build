// 脚本解析器：script/*.txt + characters.txt → program（JSON）+ 诊断列表。
// 浏览器和 Node 通用（无 DOM / fs 依赖）。语法见 engine/SCRIPT_SYNTAX.md。
import { parseExpr, exprVars } from './expr.mjs';

export const ID_RE = /^[a-z0-9_]+$/;
export const WORD_RE = /^[a-z0-9]+$/;            // 表情 / 服装 / 配饰 / 差分 / 层名：不含下划线
export const CG_RE = /^([a-z][a-z0-9]*)_(h?)(\d{2})$/;
export const HBLOCK_RE = /^([a-z][a-z0-9]*)_h(\d{2})_(\d{2})$/;
export const LABEL_RE = /^[a-z0-9_]+$/;
export const DEFAULT_VOICE_PATTERN = '^(hitozuma|gal|bucho|okami|husband)_[a-z0-9]+_[0-9]{4}$';

import { DEFAULTS as _D } from './defaults.mjs';
const ENGINE_DANGER_SE = new Set([_D.danger.upSe, _D.danger.clearSe, _D.danger.heartbeat]);
const PRESENTATION = new Set(['bg', 'daynight', 'char', 'hide', 'cg', 'bgm', 'bgmstop', 'se', 'sestop', 'ambient',
  'ambientstop', 'wait', 'shake', 'flash', 'ui', 'set', 'scene', 'unlock', 'interj', 'hearts', 'moan', 'fx']);

function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); }

// ---------- characters.txt ----------
export function parseCharacters(text, file = 'characters.txt', diag = []) {
  const chars = {}, cgdefs = {}, routes = {};
  let cur = null;
  const list = (v) => v.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const L = i + 1;
    if (!line || line.startsWith('#')) return;
    let m;
    if ((m = line.match(/^\[\s*cg\s+([^\]\s]+)\s*\]$/))) {
      const id = m[1];
      if (!CG_RE.test(id)) diag.push({ level: 'error', file, line: L, msg: `CG id「${id}」不符合 <角色>_<两位> / <角色>_h<两位>` });
      cur = cgdefs[id] = { kind: 'cg', id, diffs: [], layers: [], title: '' };
      return;
    }
    if ((m = line.match(/^\[\s*route\s+([^\]\s]+)\s*\]$/))) {
      // 路线声明（多女主）：[route <id>] + title / heroine / entry / unlock / order / thumb
      const id = m[1];
      if (!/^[a-z][a-z0-9]*$/.test(id)) diag.push({ level: 'error', file, line: L, msg: `路线 id「${id}」只能用小写字母数字，且不含下划线` });
      if (routes[id]) diag.push({ level: 'error', file, line: L, msg: `路线 ${id} 重复声明` });
      cur = routes[id] = { kind: 'route', id, title: id, heroine: null, entry: null, unlock: null, unlockSrc: null, order: Object.keys(routes).length, thumb: null, src: { file, line: L } };
      return;
    }
    if ((m = line.match(/^\[\s*([^\]\s]+)\s*\]$/))) {
      const id = m[1];
      if (!/^[a-z][a-z0-9]*$/.test(id)) diag.push({ level: 'error', file, line: L, msg: `角色 id「${id}」只能用小写字母数字，且不含下划线` });
      cur = chars[id] = { kind: 'char', id, name: id, color: '#fff8ee', outfits: [], expressions: [], acc: [], defaultAcc: null, head: null, sprite: true, voice: true, note: '' };
      return;
    }
    if ((m = line.match(/^([a-z]+)\s*[=:：]\s*(.*)$/))) {
      if (!cur) { diag.push({ level: 'error', file, line: L, msg: '属性写在任何 [角色] 段之前' }); return; }
      const [, k, v] = m;
      if (cur.kind === 'route') {
        const S = { file, line: L };
        if (k === 'title') cur.title = v;
        else if (k === 'heroine' || k === 'chara') cur.heroine = v || null;
        else if (k === 'entry') cur.entry = v.replace(/^\*/, '');
        else if (k === 'unlock') { cur.unlockSrc = v || null; if (v) { try { cur.unlock = parseExpr(v); } catch (e) { diag.push({ level: 'error', ...S, msg: `路线 ${cur.id} unlock：${e.message}` }); } } }
        else if (k === 'order') { const n = Number(v); if (Number.isFinite(n)) cur.order = n; else diag.push({ level: 'error', ...S, msg: `路线 ${cur.id} order 需要数字：${v}` }); }
        else if (k === 'thumb') cur.thumb = v || null;
        else diag.push({ level: 'warn', ...S, msg: `未知路线属性 ${k}` });
        return;
      }
      if (cur.kind === 'cg') {
        if (k === 'diffs' || k === 'layers') cur[k] = list(v);
        else if (k === 'title') cur.title = v;
        else if (k === 'chara') cur.chara = v || null;
        else diag.push({ level: 'warn', file, line: L, msg: `未知 CG 属性 ${k}` });
        for (const w of (k === 'diffs' || k === 'layers') ? cur[k] : []) if (!WORD_RE.test(w)) diag.push({ level: 'error', file, line: L, msg: `差分/层名「${w}」只能用小写字母数字，不含下划线` });
        return;
      }
      switch (k) {
        case 'name': cur.name = v; break;
        case 'color': cur.color = v; break;
        case 'outfits': case 'outfit': cur.outfits = list(v); break;
        case 'expressions': case 'expr': cur.expressions = list(v); break;
        case 'acc': cur.acc = list(v); break;
        case 'defaultacc': cur.defaultAcc = v || null; break;
        case 'head': { const h = v.split(/[,，\s]+/).map(Number); if (h.length === 2 && h.every(Number.isFinite)) cur.head = h; else diag.push({ level: 'error', file, line: L, msg: `head 需要 x,y（立绘画布 1080×1620 坐标）：${v}` }); break; }
        case 'sprite': cur.sprite = !/^(no|false|0|none)$/i.test(v); break;
        case 'voice': cur.voice = !/^(no|false|0|none)$/i.test(v); break;
        case 'note': cur.note = cur.note ? cur.note + '\n' + v : v; break;
        default: diag.push({ level: 'warn', file, line: L, msg: `未知角色属性 ${k}` });
      }
      if (['outfits', 'outfit', 'expressions', 'expr', 'acc'].includes(k)) {
        for (const w of list(v)) if (!WORD_RE.test(w)) diag.push({ level: 'error', file, line: L, msg: `「${w}」不合法：表情/服装/配饰名只能是小写字母数字单词，不含下划线` });
      }
      return;
    }
    diag.push({ level: 'error', file, line: L, msg: `characters.txt 无法识别：${raw.trim()}` });
  });
  for (const c of Object.values(chars)) {
    const exprSet = new Set(c.expressions);
    for (const a of c.acc) if (exprSet.has(a)) diag.push({ level: 'error', file, line: 0, msg: `角色 ${c.id}：配饰名「${a}」和表情重名（立绘层文件名会冲突）` });
    if (c.defaultAcc && !c.acc.includes(c.defaultAcc)) diag.push({ level: 'warn', file, line: 0, msg: `角色 ${c.id}：defaultacc ${c.defaultAcc} 不在 acc 列表` });
  }
  return { chars, cgdefs, routes };
}

// ---------- 参数切分 ----------
export function splitArgs(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let tok = '';
    while (i < s.length && !/\s/.test(s[i])) {
      if (s[i] === '"' || s[i] === '「') {
        const close = s[i] === '"' ? '"' : '」'; i++;
        while (i < s.length && s[i] !== close) tok += s[i++];
        i++;
      } else tok += s[i++];
    }
    out.push(tok);
  }
  const pos = [], kv = {};
  for (const t of out) {
    const m = t.match(/^([a-z]+)=(.*)$/);
    if (m) kv[m[1]] = m[2]; else pos.push(t);
  }
  return { pos, kv, raw: out };
}

// ---------- 主编译 ----------
export function compile({ files, characters, charactersFile = 'characters.txt', voicePattern = null, entry = 'start' }) {
  const diag = [];
  const interjUses = [];
  const { chars, cgdefs, routes: routeDefs } = parseCharacters(characters, charactersFile, diag);
  const nameIndex = {};
  for (const c of Object.values(chars)) if (c.name && !/^[a-z0-9_]+$/.test(c.name)) nameIndex[c.name] = c.id;
  // 语音 idPattern 默认按 characters.txt 登记的全部角色 id 自动生成（只出声音的角色写 sprite = no 即可）
  if (!voicePattern) {
    const ids = Object.keys(chars).filter((k) => /^[a-z][a-z0-9]*$/.test(k)).sort((a, b) => b.length - a.length);
    voicePattern = ids.length ? `^(${ids.join('|')})_[a-z0-9]+_[0-9]{4}$` : DEFAULT_VOICE_PATTERN;
  }
  const voiceRe = new RegExp(voicePattern);
  const cmds = [], labels = {}, labelSrc = {}, vars = {
    danger: { init: 0, min: 0, max: 100, gauge: 'danger', chara: null, label: '危险', th: [], builtin: true },
  };
  const hblocks = {}, cgs = {}, endings = {}, scenes = {};
  const pendingVars = []; // [{name, src}]
  const E = (src, msg) => diag.push({ level: 'error', file: src.file, line: src.line, msg });
  const W = (src, msg) => diag.push({ level: 'warn', file: src.file, line: src.line, msg });
  const I = (src, msg) => diag.push({ level: 'info', file: src.file, line: src.line, msg });
  const useVar = (name, src) => pendingVars.push({ name, src });
  const expr = (s, src) => { try { const a = parseExpr(s); for (const v of exprVars(a)) useVar(v, src); return a; } catch (e) { E(src, e.message); return { k: 'n', v: 0 }; } };
  const num = (v, d, src, what) => { if (v === undefined) return d; const n = Number(v); if (!Number.isFinite(n)) { E(src, `${what} 需要数字：${v}`); return d; } return n; };
  const checkId = (id, src, what) => { if (!id) { E(src, `${what} 缺少 id`); return false; } if (!ID_RE.test(id)) { E(src, `${what} id「${id}」只能用小写字母、数字、下划线`); return false; } return true; };
  const chk = (c, k) => c && c[k];

  for (const f of files) {
    const fname = f.name;
    let curLbl = null, off = 0, curH = null, hStartSrc = null, ifStack = [], choice = null, pendingVoice = null, pendingInterj = null;
    const push = (cmd, src) => {
      cmd.src = `${fname}:${src.line}`; cmd.lbl = curLbl; cmd.off = off++; cmd.h = curH;
      cmds.push(cmd); return cmds.length - 1;
    };
    const lines = String(f.text).split(/\r?\n/);
    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li];
      const src = { file: fname, line: li + 1 };
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;

      // 选项段内
      if (choice) {
        if (/^@endchoice\b/.test(line)) {
          if (!choice.cmd.opts.length) E(src, '@choice 没有任何选项');
          if (choice.cmd.opts.length > 3) W(src, `选项 ${choice.cmd.opts.length} 个，UI_SPEC 建议最多 3 个`);
          choice = null; continue;
        }
        const m = line.match(/^[-－]\s*(.+?)\s*->\s*([a-z0-9_]+)(?:\s+if\s+(.+))?$/);
        if (!m) { E(src, `选项行格式应为「- 文本 -> 标签 [if 条件]」：${line}`); continue; }
        const opt = { text: m[1], target: m[2], cond: m[3] ? expr(m[3], src) : null, condSrc: m[3] || null, src: `${fname}:${src.line}` };
        choice.cmd.opts.push(opt);
        continue;
      }

      // 标签
      if (line.startsWith('*')) {
        const name = line.slice(1).trim();
        if (!LABEL_RE.test(name)) { E(src, `标签名「${name}」只能用小写字母、数字、下划线`); continue; }
        if (labels[name] !== undefined) E(src, `标签 *${name} 重复（首次在 ${labelSrc[name]}）`);
        labels[name] = cmds.length; labelSrc[name] = `${fname}:${src.line}`;
        if (ifStack.length) W(src, `标签 *${name} 写在 @if 块里，跳进来会绕过条件`);
        curLbl = name; off = 0;
        if (curH) (hblocks[curH].labels ||= []).push(name);
        continue;
      }

      if (line.startsWith('@')) {
        const sp = line.match(/^@([a-z_]+)\s*(.*)$/);
        if (!sp) { E(src, `无法识别的指令：${line}`); continue; }
        let op = sp[1]; const rest = sp[2];
        const a = splitArgs(rest);
        if (op === 'chara') { W(src, '@chara 已改名为 @char，请改写（暂按别名执行）'); op = 'char'; }
        if (pendingInterj && op !== 'voice' && !PRESENTATION.has(op)) { W(pendingInterj.src, `@interj ${pendingInterj.emo} 后面没有紧跟台词`); pendingInterj = null; }
        if (pendingVoice && op !== 'voice' && !PRESENTATION.has(op)) { W(pendingVoice.src, `@voice ${pendingVoice.id} 后面没有紧跟台词`); pendingVoice = null; }
        switch (op) {
          case 'interj': {
            const emo = a.pos[0];
            if (!emo) { E(src, '@interj 需要情绪名（如 think）或 none'); break; }
            if (emo !== 'none' && !WORD_RE.test(emo)) { E(src, `@interj 情绪名「${emo}」只能是小写字母数字（不含下划线）`); break; }
            if (pendingInterj) W(src, `连续两条 @interj，前一条 ${pendingInterj.emo} 被覆盖`);
            pendingInterj = { emo, src };
            break;
          }
          case 'voice': {
            const id = a.pos[0];
            if (!checkId(id, src, '@voice')) break;
            if (!voiceRe.test(id)) E(src, `语音 id「${id}」不符合 idPattern ${voicePattern}`);
            if (pendingVoice) W(src, `连续两条 @voice，前一条 ${pendingVoice.id} 被覆盖`);
            pendingVoice = { id, src };
            break;
          }
          case 'bg': {
            let id = a.pos[0]; let time = a.kv.time || null;
            for (const p of a.pos.slice(1)) { if (p === 'day' || p === 'night' || p === 'dusk') time = p; else E(src, `@bg 多余参数 ${p}`); }
            if (!checkId(id, src, '@bg')) break;
            let m2;
            if ((m2 = id.match(/^bg_(.+)_(day|night|dusk)$/))) { id = m2[1]; time = time || m2[2]; W(src, `@bg 建议写地点 id「${id}」+ time=，不写 bg_ 前缀`); }
            else if (id.startsWith('bg_')) { id = id.slice(3); W(src, '@bg 不要写 bg_ 前缀'); }
            if (time && !['day', 'night', 'dusk'].includes(time)) E(src, `@bg time 只能是 day / night / dusk：${time}`);
            const tint = a.kv.tint || null;
            if (tint && tint !== 'dusk' && tint !== 'none') W(src, `未知 tint「${tint}」（目前只有 dusk）`);
            const trans = a.kv.trans || 'crossfade';
            if (!['crossfade', 'fade', 'wipe', 'white', 'black', 'none'].includes(trans)) E(src, `未知转场 ${trans}`);
            push({ op: 'bg', id, time, tint: tint === 'none' ? null : tint, trans, dur: num(a.kv.dur, null, src, 'dur'), dir: a.kv.dir || 'r', keep: a.kv.keep === '1' }, src);
            break;
          }
          case 'daynight': {
            const t = a.pos[0];
            if (!['day', 'night', 'dusk'].includes(t)) E(src, '@daynight 需要 day / night / dusk');
            push({ op: 'daynight', time: t, dur: num(a.kv.dur, null, src, 'dur') }, src);
            break;
          }
          case 'char': {
            const [cid, p1, p2, ...more] = a.pos;
            if (more.length) E(src, `@char 多余参数 ${more.join(' ')}`);
            const c = chars[cid];
            if (!cid) { E(src, '@char 缺少角色'); break; }
            if (!c) E(src, `角色「${cid}」未登记在 characters.txt`);
            else if (!c.sprite) W(src, `角色 ${cid} 登记为无立绘（sprite = no）`);
            let outfit = null, ex = null;
            if (p2 !== undefined) { outfit = p1; ex = p2; }
            else if (p1 !== undefined) { if (c && c.outfits.includes(p1) && !c.expressions.includes(p1)) outfit = p1; else ex = p1; }
            if (c && outfit && !c.outfits.includes(outfit)) W(src, `角色 ${cid} 的服装「${outfit}」未登记`);
            if (c && ex && !c.expressions.includes(ex)) W(src, `角色 ${cid} 的表情「${ex}」未登记，请加进 characters.txt`);
            if (ex && !WORD_RE.test(ex)) E(src, `表情名「${ex}」不能含下划线或大写`);
            const acc = a.kv.acc || null;
            if (acc && c && acc !== 'none' && !c.acc.includes(acc)) W(src, `角色 ${cid} 的配饰「${acc}」未登记`);
            const pos = a.kv.pos || null;
            if (pos && !['l', 'lc', 'c', 'rc', 'r'].includes(pos)) E(src, `pos 只能是 l/lc/c/rc/r：${pos}`);
            const inn = a.kv.in || null;
            if (inn && !['fade', 'slide', 'none'].includes(inn)) E(src, `in 只能是 fade/slide/none`);
            const fx = a.kv.fx || null; // E-fxlayer：= @fx <名> on=<该角色> 的简写（none = 清掉该角色全部头顶特效）
            if (fx && fx !== 'none' && !WORD_RE.test(fx)) E(src, `@char fx 名「${fx}」只能是小写字母数字`);
            if (fx && _D.fxlayer.screen[fx]) W(src, `@char fx=${fx}：${fx} 是屏幕级效果，请用 @fx ${fx} on`);
            push({ op: 'char', chara: cid, outfit, expr: ex, acc, pos, in: inn, fx, dur: num(a.kv.dur, null, src, 'dur') }, src);
            break;
          }
          case 'hide': {
            const who = a.pos[0] || 'all';
            if (who !== 'all' && !chars[who]) E(src, `@hide 角色「${who}」未登记`);
            push({ op: 'hide', chara: who, out: a.kv.out || 'fade', dur: num(a.kv.dur, null, src, 'dur') }, src);
            break;
          }
          case 'cg': {
            let id = null, off_ = false; const add = [], remove = [];
            for (const p of a.pos) {
              if (p === 'off') off_ = true;
              else if (p.startsWith('+')) add.push(p.slice(1));
              else if (p.startsWith('-')) remove.push(p.slice(1));
              else if (!id) id = p; else E(src, `@cg 多余参数 ${p}`);
            }
            const diff = a.kv.diff ?? null;
            if (id) {
              if (!checkId(id, src, '@cg')) break;
              const m2 = id.match(CG_RE);
              if (!m2) E(src, `CG id「${id}」不符合 <角色>_<两位> / <角色>_h<两位>`);
              else if (!chars[m2[1]]) W(src, `CG ${id} 的角色前缀 ${m2[1]} 未登记`);
              const rec = cgs[id] ||= { id, chara: cgdefs[id]?.chara || (m2 ? m2[1] : null), h: !!(m2 && m2[2]), diffs: [...(cgdefs[id]?.diffs || [])], layers: [...(cgdefs[id]?.layers || [])], title: cgdefs[id]?.title || '' };
              if (diff && diff !== 'none' && !rec.diffs.includes(diff)) rec.diffs.push(diff);
              for (const l of add) if (!rec.layers.includes(l)) rec.layers.push(l);
            } else if (!off_ && diff === null && !add.length && !remove.length) E(src, '@cg 需要 id、off 或 diff=/+层/-层');
            if (diff && diff !== 'none' && !WORD_RE.test(diff)) E(src, `差分名「${diff}」只能是小写字母数字（如 a、d1）`);
            for (const l of [...add, ...remove]) if (!WORD_RE.test(l)) E(src, `层名「${l}」只能是小写字母数字`);
            if (id && cgdefs[id]) {
              if (diff && diff !== 'none' && cgdefs[id].diffs.length && !cgdefs[id].diffs.includes(diff)) W(src, `CG ${id} 的差分 ${diff} 未在 characters.txt [cg ${id}] 登记`);
              for (const l of add) if (cgdefs[id].layers.length && !cgdefs[id].layers.includes(l) && !_D.fxlayer.overlays[l]) W(src, `CG ${id} 的层 ${l} 未登记`);
            }
            push({ op: 'cg', id, close: off_, diff, add, remove, clear: a.kv.clear === '1', trans: a.kv.trans || 'crossfade', dur: num(a.kv.dur, null, src, 'dur') }, src);
            break;
          }
          case 'bgm': {
            const id = a.pos[0];
            if (!checkId(id, src, '@bgm')) break;
            if (!id.startsWith('bgm_')) W(src, `BGM id 建议以 bgm_ 开头：${id}`);
            push({ op: 'bgm', id, fade: num(a.kv.fade, null, src, 'fade'), vol: num(a.kv.vol, 1, src, 'vol') }, src);
            break;
          }
          case 'bgmstop': push({ op: 'bgmstop', fade: num(a.kv.fade, null, src, 'fade') }, src); break;
          case 'se': {
            const id = a.pos[0];
            if (!checkId(id, src, '@se')) break;
            if (!id.startsWith('se_') && !voiceRe.test(id)) W(src, `SE id 建议以 se_ 开头：${id}`);
            const loop = a.pos.includes('loop') || a.kv.loop === '1';
            if (ENGINE_DANGER_SE.has(id)) W(src, `${id} 由引擎在 @danger 时自动播放/停止，脚本不要手写 @se ${id}`);
            if (loop && !/_loop/.test(id) && !voiceRe.test(id)) I(src, `循环 SE ${id} 名字里没有 _loop（AUDIO_SPEC 约定循环型以 _loop 结尾）`);
            push({ op: 'se', id, loop, vol: num(a.kv.vol, 1, src, 'vol') }, src);
            break;
          }
          case 'sestop': push({ op: 'sestop', id: a.pos[0] || 'all' }, src); break;
          case 'ambient': {
            const id = a.pos[0];
            if (!checkId(id, src, '@ambient')) break;
            if (!id.startsWith('amb_')) W(src, `环境音 id 建议以 amb_ 开头：${id}`);
            push({ op: 'ambient', id, vol: num(a.kv.vol, null, src, 'vol') }, src);
            break;
          }
          case 'ambientstop': {
            if (!a.pos[0]) E(src, '@ambientstop 需要 id 或 all');
            push({ op: 'ambientstop', id: a.pos[0] || 'all' }, src); break;
          }
          case 'hearts': {
            // STAGING §12.1：@hearts <1|2|3> [dur=ms] [area=full|lower|edges] / @hearts stop [fade=600]
            if (!curH) W(src, '@hearts 写在 @h_block 外（只用于 H 高潮段落）');
            if (a.pos[0] === 'stop') { const f = a.kv.fade ?? (/^\d+$/.test(a.pos[1] || '') ? a.pos[1] : null); push({ op: 'hearts', stop: true, fade: num((f) ?? undefined, _D.hfx.fadeStop, src, 'fade') }, src); break; }
            const lv = Number(a.pos[0]);
            if (![1, 2, 3].includes(lv)) { E(src, `@hearts 档位只能 1–3（写的是「${a.pos[0] ?? ''}」）`); break; }
            let dur = a.kv.dur ?? null, area = a.kv.area ?? null;
            for (const p of a.pos.slice(1)) { if (/^\d+$/.test(p) && dur === null) dur = p; else if (['full', 'lower', 'edges'].includes(p) && !area) area = p; else E(src, `@hearts 多余参数 ${p}`); }
            area ||= _D.hfx.areaDefault;
            if (!['full', 'lower', 'edges'].includes(area)) { E(src, `@hearts area 只能 full / lower / edges（写的是 ${area}）`); area = _D.hfx.areaDefault; }
            push({ op: 'hearts', lv, area, dur: num((dur) ?? undefined, null, src, 'dur') }, src); break;
          }
          case 'moan': {
            // STAGING §12.2：@moan "文本" [lv] [pos] [dur] / @moan burst <lv> [n] [lang] [gap] / @moan clear
            if (!curH) W(src, '@moan 写在 @h_block 外（只用于 H 高潮段落）');
            const POS = ['auto', ..._D.hfx.positions], LANG = ['ja', 'zh', 'mix'];
            const quoted = /^\s*["「]/.test(rest);
            if (!quoted && a.pos[0] === 'clear') { push({ op: 'moan', clear: true }, src); break; }
            const lvOk = (v, what) => { const n = Number(v); if (![1, 2, 3].includes(n)) { E(src, `@moan ${what}档位只能 1–3（写的是「${v ?? ''}」）`); return null; } return n; };
            if (!quoted && a.pos[0] === 'burst') {
              const lv = lvOk(a.kv.lv ?? a.pos[1], 'burst '); if (lv === null) break;
              let n = a.kv.n ?? null, lang = a.kv.lang ?? null, gap = a.kv.gap ?? null;
              for (const p of a.pos.slice(2)) { if (LANG.includes(p) && !lang) lang = p; else if (/^\d+$/.test(p) && n === null) n = p; else if (/^\d+$/.test(p) && gap === null) gap = p; else E(src, `@moan burst 多余参数 ${p}`); }
              lang ||= _D.hfx.burstDefault.lang;
              if (!LANG.includes(lang)) { E(src, `@moan burst lang 只能 ja / zh / mix（写的是 ${lang}）`); lang = 'mix'; }
              const nn = num((n) ?? undefined, _D.hfx.burstDefault.n, src, 'n');
              if (!(nn >= 1 && nn <= 8)) W(src, `@moan burst n=${nn} 建议 1–8`);
              push({ op: 'moan', burst: true, lv, n: nn, lang, gap: num((gap) ?? undefined, _D.hfx.burstDefault.gap, src, 'gap') }, src); break;
            }
            const text = quoted ? a.pos[0] ?? '' : null;
            if (text === null) { E(src, '@moan 需要 "文本"、burst 或 clear'); break; }
            const len = [...text.trim()].length;
            if (!len) { E(src, '@moan 文本不能为空'); break; }
            if (len > _D.hfx.moanMaxLen) E(src, `@moan 文本「${text}」${len} 字，超过 ${_D.hfx.moanMaxLen} 字`);
            let lv = a.kv.lv ?? null, pos = a.kv.pos ?? null, dur = a.kv.dur ?? null;
            for (const p of a.pos.slice(1)) { if (POS.includes(p) && !pos) pos = p; else if (/^[123]$/.test(p) && lv === null) lv = p; else if (/^\d+$/.test(p) && dur === null) dur = p; else E(src, `@moan 多余参数 ${p}`); }
            const lvn = lv === null ? 1 : lvOk(lv, ''); if (lvn === null) break;
            pos ||= 'auto'; if (!POS.includes(pos)) { E(src, `@moan pos 只能 ${POS.join(' / ')}（写的是 ${pos}）`); pos = 'auto'; }
            push({ op: 'moan', text: text.trim(), lv: lvn, pos, dur: num((dur) ?? undefined, null, src, 'dur') }, src); break;
          }
          case 'fx': { // E-fxsteam：@fx <名> on|off [lv=1-3] [fade=ms]
            const [name, mode, ...more] = a.pos;
            if (!name) { E(src, '@fx 需要效果名，如 @fx steam on / @fx smoke on=gal / @fx off'); break; }
            if (name === 'off') { if (mode) E(src, `@fx off 多余参数 ${a.pos.slice(1).join(' ')}`); push({ op: 'fx', name: null, on: false, all: true, fade: num(a.kv.fade, null, src, 'fade') }, src); break; }
            if (!WORD_RE.test(name)) { E(src, `@fx 效果名「${name}」只能是小写字母数字`); break; }
            if (a.kv.on !== undefined) { // 头顶锚定：@fx <名> on=<角色> [pos=head]
              if (mode || more.length) E(src, `@fx ${name} on=… 多余参数 ${a.pos.slice(1).join(' ')}`);
              const who = a.kv.on;
              if (_D.fxlayer.screen[name]) { W(src, `@fx ${name} 是屏幕级效果，不能 on=角色，已忽略`); break; }
              if (!chars[who]) { E(src, `@fx ${name} on=「${who}」未登记在 characters.txt`); break; }
              if (chars[who].sprite === false) W(src, `@fx ${name} on=${who}：该角色无立绘，特效不会显示`);
              if (a.kv.pos && a.kv.pos !== 'head') E(src, `@fx pos 目前只支持 head（写的是 ${a.kv.pos}）`);
              push({ op: 'fx', name, on: true, chara: who, anchor: 'head' }, src); break;
            }
            if (mode === 'off' && !_D.fxlayer.screen[name]) { if (more.length) E(src, `@fx 多余参数 ${more.join(' ')}`); push({ op: 'fx', name, on: false, chara: null, fade: num(a.kv.fade, null, src, 'fade') }, src); break; }
            if (more.length) E(src, `@fx 多余参数 ${more.join(' ')}`);
            if (!_D.fxlayer.screen[name]) { W(src, `@fx 未知效果「${name}」（可用：${Object.keys(_D.fxlayer.screen).join(' / ')}），已忽略`); break; }
            if (!['on', 'off'].includes(mode)) { E(src, `@fx ${name} 需要 on 或 off`); break; }
            const lv = num(a.kv.lv, 1, src, 'lv');
            if (![1, 2, 3].includes(lv)) E(src, `@fx lv 只能是 1-3（写的是 ${a.kv.lv}）`);
            push({ op: 'fx', name, on: mode === 'on', lv: [1, 2, 3].includes(lv) ? lv : 1, fade: num(a.kv.fade, null, src, 'fade') }, src); break;
          }
          case 'shake': {
            const lv = a.pos[0] || 'm';
            if (!['s', 'm', 'l'].includes(lv)) E(src, '@shake 档位 s/m/l');
            push({ op: 'shake', level: lv, dur: num(a.kv.dur, null, src, 'dur'), dir: a.kv.dir || 'xy' }, src); break;
          }
          case 'flash': {
            const color = a.pos[0] || 'white';
            if (!['white', 'pink', 'red'].includes(color)) E(src, '@flash 颜色 white/pink/red');
            push({ op: 'flash', color, dur: num(a.kv.dur, null, src, 'dur'), count: num(a.kv.count, 1, src, 'count') }, src); break;
          }
          case 'wait': push({ op: 'wait', ms: num(a.pos[0], 500, src, '@wait') }, src); break;
          case 'ui': {
            if (!['hide', 'show'].includes(a.pos[0])) E(src, '@ui hide|show');
            push({ op: 'ui', mode: a.pos[0] }, src); break;
          }
          case 'danger': {
            const v = a.pos[0];
            if (v === 'end') { push({ op: 'danger', end: true }, src); break; }
            const m2 = String(v || '').match(/^([+\-=])(\d+)$/);
            if (!m2) { E(src, '@danger 需要 +n / -n / =n / end'); break; }
            const kind = a.pos[1] || a.kv.kind || null;
            if (kind && !['knock', 'voice', 'phone', 'snore'].includes(kind)) W(src, `未知危险事件类型 ${kind}（只有 knock / voice / phone / snore）`);
            let se = a.kv.se || null;
            if (se && se !== 'none') { if (!checkId(se, src, '@danger se=')) se = null; else if (!se.startsWith('se_')) W(src, `@danger se=${se} 建议用 se_ 前缀的音效 id`); }
            push({ op: 'danger', mode: m2[1], n: Number(m2[2]), kind, se }, src); break;
          }
          case 'scene': {
            const code = a.pos[0];
            if (!code || !/^[a-z0-9]+$/.test(code)) E(src, '@scene 需要场景代号（小写字母数字，如 s01）');
            scenes[code] = { code, title: a.kv.title || a.pos.slice(1).join(' ') || code, file: fname };
            push({ op: 'scene', code, title: scenes[code]?.title || code }, src); break;
          }
          case 'var': {
            const name = a.pos[0];
            if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) { E(src, `@var 变量名不合法：${name}`); break; }
            if (vars[name] && !vars[name].builtin) E(src, `变量 ${name} 重复声明`);
            const th = a.kv.th ? a.kv.th.split(',').map(Number).filter(Number.isFinite) : [];
            vars[name] = { init: num(a.pos[1], 0, src, 'init'), min: num(a.kv.min, 0, src, 'min'), max: num(a.kv.max, 100, src, 'max'), gauge: a.kv.gauge || null, chara: a.kv.chara || null, label: a.kv.label || name, th, src: `${fname}:${src.line}` };
            if (a.kv.gauge && !['aff', 'lust'].includes(a.kv.gauge)) W(src, `gauge 建议 aff / lust：${a.kv.gauge}`);
            if (a.kv.chara && !chars[a.kv.chara]) W(src, `变量 ${name} 的 chara ${a.kv.chara} 未登记`);
            break;
          }
          case 'set': case 'add': {
            // 静默参数：silent（正式名），quiet 为别名；只认独立的词，不误伤变量名
            const quiet = a.raw.includes('silent') || a.raw.includes('quiet');
            const body = rest.replace(/(^|\s)(silent|quiet)(?=\s|$)/g, ' ').trim();
            const m2 = body.match(/^([a-z][a-z0-9_]*)\s*(?:(=|\+=|-=)\s*)?(.+)$/);
            if (!m2) { E(src, `@${op} 格式：@${op} 变量 [=] 值 [silent]`); break; }
            useVar(m2[1], src);
            let mode = op === 'add' ? '+' : '=';
            if (m2[2] === '+=') mode = '+'; else if (m2[2] === '-=') mode = '-';
            push({ op: 'set', var: m2[1], mode, expr: expr(m2[3], src), silent: quiet }, src);
            break;
          }
          case 'jump': {
            const t = a.pos[0];
            if (!t) { E(src, '@jump 缺少标签'); break; }
            push({ op: 'jump', target: t, to: null }, src); break;
          }
          case 'if': {
            const m2 = rest.match(/^(.+?)\s*->\s*([a-z0-9_]+)\s*$/);
            if (m2) { push({ op: 'jmpif', cond: expr(m2[1], src), condSrc: m2[1], target: m2[2], to: null }, src); break; }
            const at = push({ op: 'jmpifnot', cond: expr(rest, src), condSrc: rest, to: null }, src);
            ifStack.push({ next: at, ends: [], src, hasElse: false });
            break;
          }
          case 'elif': case 'else': {
            const top = ifStack[ifStack.length - 1];
            if (!top) { E(src, `@${op} 没有对应的 @if`); break; }
            if (top.hasElse) { E(src, `@${op} 出现在 @else 之后`); break; }
            top.ends.push(push({ op: 'jump', to: null, internal: true }, src));
            cmds[top.next].to = cmds.length;
            if (op === 'elif') top.next = push({ op: 'jmpifnot', cond: expr(rest, src), condSrc: rest, to: null }, src);
            else { top.next = null; top.hasElse = true; }
            break;
          }
          case 'endif': {
            const top = ifStack.pop();
            if (!top) { E(src, '@endif 没有对应的 @if'); break; }
            if (top.next !== null) cmds[top.next].to = cmds.length;
            for (const e of top.ends) cmds[e].to = cmds.length;
            break;
          }
          case 'choice': {
            const h = a.pos.includes('h');
            if (h && !curH) W(src, '@choice h（H 中途选项）写在 @h_block 外');
            const at = push({ op: 'choice', hstyle: h, opts: [] }, src);
            choice = { cmd: cmds[at] };
            break;
          }
          case 'endchoice': E(src, '@endchoice 没有对应的 @choice'); break;
          case 'h_block': {
            const id = a.pos[0];
            if (!checkId(id, src, '@h_block')) break;
            const m2 = id.match(HBLOCK_RE);
            if (!m2) E(src, `h_block id「${id}」不符合 <角色>_h<两位>_<两位>`);
            if (curH) { E(src, `@h_block ${id} 嵌套在 ${curH} 里（缺 @h_end？）`); break; }
            if (hblocks[id]) E(src, `h_block ${id} 重复`);
            if (m2 && !chars[m2[1]]) W(src, `h_block ${id} 的角色前缀 ${m2[1]} 未登记`);
            curH = id; hStartSrc = src;
            const at = push({ op: 'hstart', id, title: a.kv.title || id }, src);
            hblocks[id] = { id, start: at, end: null, title: a.kv.title || id, chara: m2 ? m2[1] : null, cg: m2 ? `${m2[1]}_h${m2[2]}` : null, src: `${fname}:${src.line}`, labels: [] };
            break;
          }
          case 'h_end': {
            if (!curH) { E(src, '@h_end 没有对应的 @h_block'); break; }
            const at = push({ op: 'hend', id: curH }, src);
            hblocks[curH].end = at;
            tailStopCheck(cmds, hblocks[curH], src, W);
            curH = null;
            break;
          }
          case 'end': {
            const id = a.pos[0] || 'end';
            if (!ID_RE.test(id)) E(src, `结局 id 不合法：${id}`);
            endings[id] = { id, title: a.kv.title || endings[id]?.title || id, src: `${fname}:${src.line}` };
            push({ op: 'end', ending: id, title: endings[id].title }, src); break;
          }
          case 'unlock': {
            const kind = a.pos[0];
            if (kind === 'cg') push({ op: 'unlock', kind, id: a.pos[1], diff: a.pos[2] || a.kv.diff || 'base' }, src);
            else if (kind === 'recall') push({ op: 'unlock', kind, id: a.pos[1] }, src);
            else E(src, '@unlock cg <id> [diff] / @unlock recall <h_block>');
            break;
          }
          default: E(src, `未知指令 @${op}`);
        }
        continue;
      }

      // 台词 / 旁白
      let speaker = null, name = null, ex = null, text = line, m;
      if ((m = line.match(/^([a-z][a-z0-9]*)(?:\(([^)]*)\))?\s*[:：]\s*(.*)$/))) {
        speaker = m[1]; ex = m[2] || null; text = m[3];
        const c = chars[speaker];
        if (!c) E(src, `角色「${speaker}」未登记在 characters.txt`);
        else {
          name = c.name;
          if (ex && !c.expressions.includes(ex)) W(src, `角色 ${speaker} 的表情「${ex}」未登记，请加进 characters.txt`);
        }
        if (ex && !WORD_RE.test(ex)) E(src, `表情名「${ex}」不能含下划线或大写`);
      } else if ((m = line.match(/^\[([^\]]+)\]\s*[:：]\s*(.*)$/))) { name = m[1]; text = m[2]; }
      else if ((m = line.match(/^([^\s:：\[\]@*#（(「]{1,12})\s*[:：]\s*(.*)$/)) && nameIndex[m[1]]) {
        // 用 characters.txt 里登记的显示名开头（如「澄香：」「主人公：」）也认作该角色
        speaker = nameIndex[m[1]]; name = chars[speaker].name; text = m[2];
      }
      text = text.replace(/\\n/g, '\n');
      const voice = pendingVoice ? pendingVoice.id : null;
      if (pendingVoice && speaker && !pendingVoice.id.startsWith(speaker + '_')) W(pendingVoice.src, `语音 ${pendingVoice.id} 的角色前缀和说话人 ${speaker} 不一致`);
      if (pendingVoice && !speaker && !name) W(pendingVoice.src, `语音 ${pendingVoice.id} 挂在旁白上`);
      pendingVoice = null;
      let interj = null;
      if (pendingInterj) {
        interj = pendingInterj.emo;
        if (!speaker) W(pendingInterj.src, `@interj ${interj} 挂在旁白 / 临时名台词上，不会播放`);
        else interjUses.push({ chara: speaker, emo: interj, src: pendingInterj.src, h: !!curH });
        pendingInterj = null;
      }
      const key = `${curLbl || '_'}|${fnv((speaker || name || '') + '\u0000' + text)}`;
      push({ op: 'text', speaker, name, expr: ex, text, voice, key, ...(interj ? { interj } : {}) }, src);
    }
    if (choice) E({ file: fname, line: lines.length }, '文件结束时 @choice 未闭合（缺 @endchoice）');
    if (ifStack.length) E(ifStack[ifStack.length - 1].src, '@if 未闭合（缺 @endif）');
    if (curH) E(hStartSrc, `@h_block ${curH} 未闭合（缺 @h_end）`);
    if (pendingVoice) W(pendingVoice.src, `@voice ${pendingVoice.id} 后面没有台词`);
    if (pendingInterj) W(pendingInterj.src, `@interj ${pendingInterj.emo} 后面没有台词`);
    const last = cmds[cmds.length - 1];
    if (cmds.length && last && !['jump', 'end', 'choice'].includes(last.op)) W({ file: fname, line: lines.length }, '文件末尾不是 @jump / @end，会接着执行下一个文件（或直接结束）');
    // 文件边界：防止重复 key 冲突
    cmds.push({ op: 'eof', src: `${fname}:${lines.length}`, lbl: curLbl, off: off++, h: null });
  }

  // 解析标签
  const resolve = (t, srcStr) => {
    if (labels[t] === undefined) { const [file, line] = srcStr.split(':'); diag.push({ level: 'error', file, line: +line, msg: `未定义的标签 *${t}` }); return null; }
    return labels[t];
  };
  for (const c of cmds) {
    if ((c.op === 'jump' || c.op === 'jmpif') && c.target) c.to = resolve(c.target, c.src);
    if (c.op === 'choice') for (const o of c.opts) o.to = resolve(o.target, o.src);
    if (c.op === 'unlock' && c.kind === 'recall' && c.id && !hblocks[c.id]) { const [file, line] = c.src.split(':'); diag.push({ level: 'error', file, line: +line, msg: `@unlock recall 未知 h_block ${c.id}` }); }
  }
  // 跳进 H 块中间
  for (const c of cmds) {
    const targets = c.op === 'choice' ? c.opts.map((o) => o.to) : (c.op === 'jump' || c.op === 'jmpif') && c.target ? [c.to] : [];
    for (const t of targets) {
      if (t == null) continue;
      const th = cmds[t]?.h;
      if (th && th !== c.h && cmds[t].op !== 'hstart') { const [file, line] = c.src.split(':'); diag.push({ level: 'error', file, line: +line, msg: `从块外跳进 h_block ${th} 中间（只能从 @h_block 开头进入）` }); }
      if (c.h && th !== c.h) { const [file, line] = c.src.split(':'); diag.push({ level: 'info', file, line: +line, msg: `从 h_block ${c.h} 中途跳出（引擎会兜底停循环 SE/环境音）` }); }
    }
  }
  // H 中途选项目标必须在本块内
  for (const c of cmds) if (c.op === 'choice' && c.hstyle) for (const o of c.opts) {
    if (o.to != null && cmds[o.to]?.h !== c.h) { const [file, line] = o.src.split(':'); diag.push({ level: 'error', file, line: +line, msg: `H 中途选项目标 *${o.target} 不在本块 ${c.h || '(块外)'} 内` }); }
  }
  // 同意句检查（沿所有前驱路径往回找紧贴的角色台词）
  const preds = buildPreds(cmds);
  for (const hb of Object.values(hblocks)) {
    if (!consentOk(cmds, preds, hb.start)) { const [file, line] = hb.src.split(':'); diag.push({ level: 'warn', file, line: +line, msg: `@h_block ${hb.id} 前没有紧贴的角色台词（同意句须在块外、紧贴块调用；中间只能隔演出/变量/跳转），请人工确认` }); }
  }
  for (const { name, src } of pendingVars) if (!vars[name]) E(src, `变量 ${name} 未用 @var 声明`);
  // 路线：不声明 = 一条默认路线（entry = *start，标题页与单女主时一致）
  const routes = [];
  const sysVars = new Set();
  for (const r of Object.values(routeDefs)) { sysVars.add(`clear_${r.id}`); }
  for (const e of Object.keys(endings)) sysVars.add(`end_${e}`);
  for (const r of Object.values(routeDefs)) {
    const S = r.src;
    if (!r.entry) diag.push({ level: 'error', ...S, msg: `路线 ${r.id} 缺少 entry=标签` });
    else if (labels[r.entry] === undefined) diag.push({ level: 'error', ...S, msg: `路线 ${r.id} 的 entry 标签 *${r.entry} 不存在` });
    if (!r.heroine) diag.push({ level: 'warn', ...S, msg: `路线 ${r.id} 没写 heroine=` });
    else if (!chars[r.heroine]) diag.push({ level: 'warn', ...S, msg: `路线 ${r.id} 的女主 ${r.heroine} 没在 characters.txt 登记` });
    if (r.unlock) for (const v of exprVars(r.unlock)) if (!sysVars.has(v)) diag.push({ level: 'error', ...S, msg: `路线 ${r.id} unlock 用了未知系统变量 ${v}（可用：clear_<路线>、end_<结局 id>）` });
    routes.push({ id: r.id, title: r.title, heroine: r.heroine, entry: r.entry || entry, unlock: r.unlock, unlockSrc: r.unlockSrc, order: r.order, thumb: r.thumb });
  }
  routes.sort((a, b) => a.order - b.order);
  const declared = routes.length > 0;
  if (!declared) routes.push({ id: 'main', title: '', heroine: null, entry, unlock: null, unlockSrc: null, order: 0, thumb: null, implicit: true });
  if (!declared && labels[entry] === undefined && cmds.length) diag.push({ level: 'error', file: files[0]?.name || '-', line: 0, msg: `缺少入口标签 *${entry}` });
  for (const id of Object.keys(cgdefs)) if (!cgs[id]) cgs[id] = { id, chara: cgdefs[id].chara || id.split('_')[0], h: /_h\d\d$/.test(id), diffs: [...cgdefs[id].diffs], layers: [...cgdefs[id].layers], title: cgdefs[id].title };
  for (const [id, d] of Object.entries(cgdefs)) { const r = cgs[id]; for (const x of d.diffs) if (!r.diffs.includes(x)) r.diffs.push(x); }

  const program = {
    format: 'onsen-adv/1', entry: routes[0].entry, routes, chars, vars, labels, cmds, hblocks, cgs, endings, scenes, voicePattern, interjUses,
  };
  return { program, diag };
}

function buildPreds(cmds) {
  const preds = cmds.map(() => []);
  cmds.forEach((c, i) => {
    const falls = !['jump', 'end', 'choice'].includes(c.op) && !(c.op === 'eof' && i === cmds.length - 1);
    if (falls && i + 1 < cmds.length) preds[i + 1].push(i);
    if ((c.op === 'jump' || c.op === 'jmpif' || c.op === 'jmpifnot') && c.to != null) preds[c.to]?.push(i);
    if (c.op === 'choice') for (const o of c.opts) if (o.to != null) preds[o.to]?.push(i);
  });
  return preds;
}

const PASS = new Set([...PRESENTATION, 'jump', 'jmpif', 'jmpifnot', 'eof']);
function consentOk(cmds, preds, at) {
  // 每条进入路径往回走，越过演出/变量/跳转指令，第一条“实质”指令必须是角色台词
  const seen = new Set();
  const stack = [...preds[at]];
  if (!stack.length) return false;
  while (stack.length) {
    const i = stack.pop();
    if (seen.has(i)) continue;
    seen.add(i);
    const c = cmds[i];
    if (c.op === 'text') { if (c.speaker || c.name) continue; return false; }
    if (!PASS.has(c.op)) return false;
    if (c.op === 'eof') return false;
    if (!preds[i].length) return false;
    stack.push(...preds[i]);
  }
  return true;
}

function tailStopCheck(cmds, hb, src, W) {
  let hasLoop = false;
  for (let i = hb.start; i < cmds.length; i++) { const c = cmds[i]; if ((c.op === 'se' && c.loop) || c.op === 'ambient') hasLoop = true; }
  let se = false, amb = false;
  for (let i = cmds.length - 2; i > hb.start; i--) {
    const c = cmds[i];
    if (c.op === 'sestop' && c.id === 'all') se = true;
    else if (c.op === 'ambientstop' && c.id === 'all') amb = true;
    else if (!PRESENTATION.has(c.op)) break;
  }
  if (!se || !amb) W(src, `h_block ${hb.id} 块尾缺少显式 ${!se ? '@sestop all ' : ''}${!amb ? '@ambientstop all' : ''}（引擎会兜底，但规范要求显式写${hasLoop ? '' : '；本块自己没开循环音，块外带进来的环境音会被兜底停掉'}）`);
}
