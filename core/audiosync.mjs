// 声明式音频同步：VM 状态 st.audio 是“应该在响的东西”，这里算出播放器要做的动作。
// 浏览器渲染器与 smoke 共用，保证“退出 H 后循环 SE / 环境音为 0”可以在 Node 里验证。
export function diffAudio(playing, want) {
  // playing / want: { bgm: {id,vol}|null, loops: {id:vol}, amb: {id:vol} }
  const acts = [];
  const pb = playing.bgm?.id || null, wb = want.bgm?.id || null;
  if (pb !== wb) {
    if (pb) acts.push({ act: 'stop', ch: 'bgm', id: pb });
    if (wb) acts.push({ act: 'play', ch: 'bgm', id: wb, vol: want.bgm.vol ?? 1, loop: true });
  } else if (wb && (playing.bgm.vol ?? 1) !== (want.bgm.vol ?? 1)) acts.push({ act: 'vol', ch: 'bgm', id: wb, vol: want.bgm.vol ?? 1 });
  for (const ch of ['loops', 'amb']) {
    const P = playing[ch] || {}, Wt = want[ch] || {};
    for (const id of Object.keys(P)) if (!(id in Wt)) acts.push({ act: 'stop', ch, id });
    for (const id of Object.keys(Wt)) if (!(id in P)) acts.push({ act: 'play', ch, id, vol: Wt[id], loop: true });
  }
  return acts;
}

export function applyActs(playing, acts) {
  const p = { bgm: playing.bgm ? { ...playing.bgm } : null, loops: { ...playing.loops }, amb: { ...playing.amb } };
  for (const a of acts) {
    if (a.ch === 'bgm') p.bgm = a.act === 'stop' ? null : { id: a.id, vol: a.vol };
    else if (a.act === 'stop') delete p[a.ch][a.id];
    else p[a.ch][a.id] = a.vol;
  }
  return p;
}
