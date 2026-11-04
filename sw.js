// Service Worker：版本化缓存。build 会替换版本占位符 / 预缓存清单。
// 发布版只预缓存核心 + 首屏（标题 + 第一个场景，含该场景的语音 pak：audio/pak/ogg/voice_<场景>.pak）；
// CG、后续场景的语音 pak（ogg/m4a）、语气词 pak 等第一次请求时运行时缓存（cache-first，整包一次）。
const VERSION = '0.1.0+202611041931.ae9e977a';
const RELEASE = true;
const PRECACHE = ["./","index.html","style.css","portrait.css","main.js","manifest.webmanifest","icon.svg","game.json","core/audiosync.mjs","core/defaults.mjs","core/expr.mjs","core/interj.mjs","core/layout.mjs","core/orient.mjs","core/pak.mjs","core/parser.mjs","core/vm.mjs","fonts/moan.woff2","fonts/moan_fb.woff2","art/bg/bg_rotenburo_night.webp","art/ui/thumb/thumb_route_gal.webp","art/ui/thumb/thumb_route_hitozuma.webp","art/ui/ui_btn_auto_n.webp","art/ui/ui_btn_auto_p.webp","art/ui/ui_btn_config_n.webp","art/ui/ui_btn_config_p.webp","art/ui/ui_btn_hide_n.webp","art/ui/ui_btn_hide_p.webp","art/ui/ui_btn_load_n.webp","art/ui/ui_btn_load_p.webp","art/ui/ui_btn_log_n.webp","art/ui/ui_btn_log_p.webp","art/ui/ui_btn_menu_n.webp","art/ui/ui_btn_menu_p.webp","art/ui/ui_btn_save_n.webp","art/ui/ui_btn_save_p.webp","art/ui/ui_btn_skip_n.webp","art/ui/ui_btn_skip_p.webp","art/ui/ui_btn_voice_n.webp","art/ui/ui_btn_voice_p.webp","art/ui/ui_choice_h_n.webp","art/ui/ui_choice_h_p.webp","art/ui/ui_choice_n.webp","art/ui/ui_choice_p.webp","art/ui/ui_choice_seen.webp","art/ui/ui_danger_fill.webp","art/ui/ui_danger_frame.webp","art/ui/ui_gauge_aff.webp","art/ui/ui_gauge_frame.webp","art/ui/ui_gauge_lust.webp","art/ui/ui_namebox.webp","art/ui/ui_next_icon.webp","art/ui/ui_rotate_hint.webp","art/ui/ui_saveslot.webp","art/ui/ui_saveslot_empty.webp","art/ui/ui_slider_bar.webp","art/ui/ui_slider_knob.webp","art/ui/ui_textbox.webp","art/ui/ui_thumb_locked.webp","art/ui/ui_title_bg.webp","art/ui/ui_title_chara.webp","art/ui/ui_title_frame.webp","art/ui/ui_toggle_off.webp","art/ui/ui_toggle_on.webp","art/ui/ui_vignette_red.webp","art/bg/bg_corridor_day.webp","art/bg/bg_terrace_dusk.webp","art/chara/hitozuma_yukata_demure.webp","art/chara/hitozuma_yukata_hairflip.webp","art/chara/hitozuma_yukata_smug.webp","art/chara/hitozuma_yukata_tease.webp","art/chara/okami_kimono_knowing.webp","art/chara/okami_kimono_smile.webp","art/chara/okami_kimono_wink.webp","audio/bgm/bgm_title.ogg","audio/se/se_ui_click.ogg","audio/se/se_ui_confirm.ogg","audio/se/se_ui_cancel.ogg","audio/se/se_unlock.ogg","audio/ambient/amb_corridor.ogg","audio/ambient/amb_night_insects.ogg","audio/bgm/bgm_daily.ogg","audio/bgm/bgm_tease.ogg","audio/se/se_phone_ring.ogg","audio/se/se_tatami_step.ogg"];
const CACHE = `onsen-${VERSION}`;

self.addEventListener('install', (e) => {
  self.skipWaiting();
  if (!RELEASE) return;
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 逐个加，缺一个不影响整体
    await Promise.all(PRECACHE.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('onsen-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (!RELEASE) return; // 开发版：直接走网络
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    } catch (err) {
      return hit || new Response('', { status: 504 });
    }
  })());
});
