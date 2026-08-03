// êµ¬ë§¤ ìµœì í™” ê³„ì‚°ê¸° ì„œë¹„ìŠ¤ì›Œì»¤ â€” ì˜¤í”„ë¼ì¸ ì§€ì› + PWA ì„¤ì¹˜ ìš”ê±´
// ì „ëžµ: ê°™ì€ ì¶œì²˜ ìš”ì²­ì€ ë„¤íŠ¸ì›Œí¬ ìš°ì„ (í•­ìƒ ìµœì‹  ë²„ì „Â·ìµœì‹  rates.json), ì‹¤íŒ¨ ì‹œ ìºì‹œ(ì˜¤í”„ë¼ì¸).
// ì™¸ë¶€(í¬í„¸ ë§í¬, ê°€ê²© ì¡°íšŒ í”„ë¡ì‹œ)ëŠ” ê±´ë“œë¦¬ì§€ ì•ŠëŠ”ë‹¤.
const CACHE = 'purchopt-v3';
const PRECACHE = ['./', 'index.html', 'manifest.json', 'rates.json', 'icons/icon-192.png?v=3', 'icons/icon-512.png?v=3'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() =>
      caches.match(req).then(m => m || caches.match('index.html'))
    )
  );
});
