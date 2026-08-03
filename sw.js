// 구매 최적화 계산기 서비스워커 — 오프라인 지원 + PWA 설치 요건
// 전략: 같은 출처 요청은 네트워크 우선(항상 최신 버전·최신 rates.json), 실패 시 캐시(오프라인).
// 외부(포털 링크, 가격 조회 프록시)는 건드리지 않는다.
const CACHE = 'purchopt-v2';
const PRECACHE = ['./', 'index.html', 'manifest.json', 'rates.json', 'icons/icon-192.png?v=2', 'icons/icon-512.png?v=2'];

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
