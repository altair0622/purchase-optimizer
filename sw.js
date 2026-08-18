// PriceAfter 서비스워커 — 오프라인 지원 + PWA 설치 요건
// 전략: 같은 출처 요청은 네트워크 우선(항상 최신 버전·최신 rates.json), 실패 시 캐시(오프라인).
// 외부(포털 링크, 가격 조회 워커)는 건드리지 않는다.
// ⚠️ 이 파일 로직이나 PRECACHE를 바꾸면 CACHE 이름을 반드시 올릴 것(안 그러면 구버전이 남는다).
// 📷 스캐너(scanner.js · vendor/quagga2.min.js, 약 157KB)는 **일부러 PRECACHE 에 안 넣는다.**
// 넣으면 바코드를 한 번도 안 쓸 사람에게까지 첫 방문에 157KB 를 받게 한다 —
// "안 쓰는 사람에게 비용 0" 이 이 기능의 설계 전제다(리서치/바코드-매장스캔-조사.md 8-D).
// 대신 아래 fetch 핸들러가 같은 출처 GET 을 통과하며 자동으로 캐시하므로,
// **한 번이라도 쓴 사람은 그다음부터 오프라인에서도 스캔된다.** 그게 우리가 원하는 동작이라
// PRECACHE 도 CACHE 이름도 건드릴 필요가 없다.
// ⚠️ 오프라인 + 캐시 없음이면 scanner.js 요청이 실패하고 아래 폴백이 index.html 을 돌려주는데,
//    HTML 은 모듈로 파싱되지 않아 import() 가 거부되고, index.html 의 글루가 그걸 받아
//    "스캐너 코드를 받지 못했어" 로 끝낸다. 조용히 실패하지 않는다.
const CACHE = 'purchopt-v4';
const PRECACHE = ['./', 'index.html', 'manifest.json', 'rates.json', 'icons/icon-192.png?v=4', 'icons/icon-512.png?v=4'];

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
