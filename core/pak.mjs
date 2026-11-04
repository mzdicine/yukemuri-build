// 语音/语气词包（.pak）读写：浏览器（main.js）与 Node（build / smoke）共用，零依赖。
// 格式 OPAK v1（小端）：
//   0   4B  魔数 "OPAK"
//   4   u16 版本号 = 1
//   6   u16 保留 = 0
//   8   u32 索引长度 L（字节）
//   12  L B 索引：UTF-8 JSON {"v":1,"fmt":"ogg"|"m4a","e":[[id, 偏移, 长度], …]}；偏移从文件开头算
//   之后 补 0 到 4 字节对齐，再拼接各段原始编码数据（ogg/Opus 或 m4a/AAC 整文件，不改动）
//   去重：内容完全相同的条目只存一段，索引里多个 id 指向同一（偏移, 长度）
// 运行时 fetch 整个 pak → readPakIndex → slicePak(id) 得到独立 ArrayBuffer → decodeAudioData。
export const PAK_MAGIC = 'OPAK';
export const PAK_VERSION = 1;
const HEAD = 12;

// entries: [{ id, data: Uint8Array }]；返回 Uint8Array
export function writePak(entries, fmt) {
  const ids = new Set();
  for (const e of entries) { if (!e.id || ids.has(e.id)) throw new Error(`pak：id 为空或重复 ${e.id}`); ids.add(e.id); }
  // 去重：逐字节相同的数据共用一段（按长度分桶再比较）
  const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
  const segs = [], segOf = [], byLen = new Map();
  for (const x of entries) {
    const bucket = byLen.get(x.data.length) || []; let k = bucket.find((j) => same(segs[j], x.data));
    if (k === undefined) { k = segs.length; segs.push(x.data); bucket.push(k); byLen.set(x.data.length, bucket); }
    segOf.push(k);
  }
  // 索引里的偏移取决于索引长度；数字位数会变，迭代到稳定
  let dataStart = 0, json = '', enc;
  for (let k = 0; k < 8; k++) {
    const offs = []; let off = dataStart; for (const d of segs) { offs.push(off); off += d.length; }
    const e = entries.map((x, i) => [x.id, offs[segOf[i]], x.data.length]);
    json = JSON.stringify({ v: PAK_VERSION, fmt, e });
    enc = new TextEncoder().encode(json);
    const want = (HEAD + enc.length + 3) & ~3;
    if (want === dataStart) break;
    dataStart = want;
  }
  const total = dataStart + segs.reduce((n, d) => n + d.length, 0);
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = PAK_MAGIC.charCodeAt(i);
  dv.setUint16(4, PAK_VERSION, true); dv.setUint16(6, 0, true); dv.setUint32(8, enc.length, true);
  out.set(enc, HEAD);
  let off = dataStart; for (const d of segs) { out.set(d, off); off += d.length; }
  return out;
}

// buf: ArrayBuffer | Uint8Array；返回 { v, fmt, map: Map(id → [偏移, 长度]), dataStart }
export function readPakIndex(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < HEAD) throw new Error('pak：文件太短');
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== PAK_MAGIC) throw new Error(`pak：魔数不对（${magic}）`);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const v = dv.getUint16(4, true);
  if (v !== PAK_VERSION) throw new Error(`pak：不支持的版本 ${v}（引擎支持 ${PAK_VERSION}）`);
  const L = dv.getUint32(8, true);
  if (HEAD + L > u8.length) throw new Error('pak：索引越界');
  const idx = JSON.parse(new TextDecoder().decode(u8.subarray(HEAD, HEAD + L)));
  const map = new Map();
  for (const [id, off, len] of idx.e) {
    if (!(off >= HEAD + L && off + len <= u8.length)) throw new Error(`pak：${id} 数据越界`);
    map.set(id, [off, len]);
  }
  return { v, fmt: idx.fmt, map, dataStart: (HEAD + L + 3) & ~3 };
}

// 切出一条：返回独立的 ArrayBuffer（decodeAudioData 会 detach 传入的 buffer，所以必须复制）
export function slicePak(buf, index, id) {
  const r = index.map.get(id); if (!r) return null;
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return u8.slice(r[0], r[0] + r[1]).buffer;
}
