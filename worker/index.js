/**
 * price-proxy — 계산기가 쓰는 Cloudflare Worker. 엔드포인트 2개.
 *
 *   GET  /?url=<상품 URL>    → 상품 페이지에서 "가격만" 뽑아 JSON
 *   GET  /rate?store=<슬러그> → Rakuten·TopCashback 캐시백 요율을 그 한 곳만 라이브 조회 (v0.29)
 *   POST /vision              → 사진에서 "검색어 후보"를 뽑아 JSON (v0.31)
 *
 * 왜 만들었나
 *  - 계산기는 정적 페이지(GitHub Pages)라 상품 사이트를 직접 못 부른다(CORS).
 *  - 그래서 공개 CORS 프록시 3개를 돌려썼는데, 2026-08-11 점검 결과
 *    corsproxy.io = 403, allorigins = 무응답. 사실상 한 곳만 살아 있었다.
 *  - 서버(=이 워커)를 두면 CORS가 사라지고, 프록시 생사에 의존하지 않는다.
 *
 * 설계 결정
 *  1) HTML을 그대로 돌려주지 않고 **필요한 값만 파싱해서 반환**한다.
 *     → 아무나 쓸 수 있는 범용 오픈 프록시가 되는 걸 막고, 응답도 훨씬 작아진다.
 *  2) SSRF 차단 — 사설/내부 IP와 클라우드 메타데이터 주소는 거부한다.
 *     `/rate` 는 한 발 더 나가서 **목적지가 두 도메인으로 고정**돼 있다(아래).
 *  3) 캐시 — 같은 상품/상점을 여러 번 열어도 원 사이트엔 한 번만 간다.
 *
 * ===== 프라이버시 (이 파일이 근거다) =====
 * `/rate` 는 "이 사용자가 어떤 매장을 궁금해했는지"를 서버가 잠깐 보게 만든다.
 * 그건 쇼핑 이력이고 우리 원칙 H3(읽은 데이터는 기기 밖으로 안 나간다)와 부딪히므로,
 * 아래 네 가지를 코드에서 지킨다. 문서상의 약속이 아니라 **지목 가능한 위치**로 둔다.
 *
 *  P-1. 로그를 남기지 않는다 — 이 파일 전체에 console.* 호출이 **0개**다. 요청 내용을
 *       변수 밖으로 내보내는 경로(로깅 서비스·Analytics Engine·KV·D1·외부 비콘)가 없다.
 *       플랫폼 쪽 로깅도 `wrangler.toml` 의 `[observability] enabled = false` 로 꺼 둔다
 *       (켜져 있으면 Cloudflare가 요청 URL = 매장 이름을 며칠 보관한다).
 *  P-2. 요청자 식별 정보를 읽지도 저장하지도 않는다 — `CF-Connecting-IP`,
 *       `request.cf`, 쿠키, `User-Agent` 중 어느 것도 이 워커가 읽지 않는다.
 *       코드에서 `request.headers.get` 을 부르는 곳은 `Origin`(CORS 판정) 한 군데뿐이고,
 *       그 값도 응답 헤더에 쓰일 뿐 저장되지 않는다.
 *  P-3. 엣지 캐시 키는 **매장 슬러그 하나**로만 만든다(`rateCacheKey`). 오리진·IP·헤더가
 *       섞이지 않으므로 사용자 단위 캐시가 생길 수 없고, 캐시는 매장 단위 공용이다.
 *  P-4. 응답에 원문 HTML을 담지 않는다 — 요율 숫자와 상태 문자열만 나간다.
 *
 * `/vision` 은 여기서 한 발 더 나간다 — **사진이 제3자(비전 API)로 나간다.** 이건 이 워커에서
 * 가장 큰 완화이고, 그래서 조건을 하나 못 지킨다. **숨기지 않고 여기 적는다.**
 *
 *  V-1. 로그를 남기지 않는다 — 위 P-1 그대로. 이 파일에 console.* 는 여전히 **0개**다.
 *  V-2. 요청자 식별 정보를 읽지 않는다 — 위 P-2 그대로. headers.get 은 Origin 한 곳뿐이다.
 *       ⚠️ 그래서 **IP 단위 레이트리밋을 코드로 못 넣는다**(넣으려면 요청자를 식별해야 하므로).
 *       남용 방어는 Cloudflare 대시보드의 엣지 레이트리밋과 제공자 콘솔의 월 예산 상한으로
 *       건다 — 우리 손에 데이터가 안 남는 방식이다. worker/README.md 에 절차를 적어뒀다.
 *  V-3. 🔴 **캐시가 없다 — 이 조건은 못 지킨다.** 이미지는 사람마다 달라서 공용 캐시 키를
 *       만들 수 없다. `/rate` 가 "매장 단위 공용 캐시"로 지키던 자리를 여기서는 못 지킨다.
 *       대신 **통과시키고 버린다** — 사진을 R2·KV·D1 어디에도 넣지 않는다(아래 V-4).
 *  V-4. 사진을 저장하지 않는다 — 이 엔드포인트는 스토리지 바인딩을 하나도 안 쓴다.
 *       Cloudflare 문서가 *"may be stored by Cloudflare **if you specifically use a storage
 *       service**"* 라고 적고 있고, 우리는 안 쓰므로 저장되지 않는다. `wrangler.toml` 에
 *       스토리지 바인딩이 없는 것이 그 근거다.
 *  V-5. 응답에 사진을 되돌려주지 않는다 — 검색어 문자열과 짧은 판단 근거만 나간다.
 *
 * 한계(솔직히)
 *  - 봇 차단이 강한 곳(Best Buy 등)은 서버로 불러도 막힌다. CORS는 풀리지만
 *    봇 탐지는 안 풀린다. 실패하면 price:null을 주고, 계산기는 직접 입력을 안내한다.
 *  - `/rate` 도 마찬가지로 **실패는 실패라고 말한다.** 조회에 실패했을 때 0%를 돌려주지
 *    않는다 — "0%"와 "모름"은 다른 값이고, 0%로 뭉개면 계산기가 조용히 틀린 순위를 낸다.
 */

// 계산기가 올라가 있는 오리진만 허용. 'null'은 file:// 로컬 테스트용.
// 로컬 포트는 흔한 개발 서버 포트를 '명시적으로' 나열한다 — 정규식으로 반사하면
// 허용목록 밖의 값이 Access-Control-Allow-Origin 에 실려나가므로 그렇게 하지 않는다.
const LOCAL_PORTS = [3000, 4173, 5000, 5173, 8000, 8080, 8081, 8888];
const ALLOW_ORIGINS = [
  'https://altair0622.github.io',
  'null',
  ...LOCAL_PORTS.flatMap(p => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]),
];

// 평범한 브라우저처럼 보이게 — 헤더가 없으면 대부분의 소매 사이트가 바로 막는다.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
};

const CACHE_SECONDS = 1800;   // 30분 — 가격은 분 단위로 안 바뀐다
const MAX_HTML = 2_000_000;   // 파싱에 쓰는 최대 글자 수
const MAX_BYTES = 4_000_000;  // 네트워크에서 실제로 읽는 최대 바이트 (여기서 끊는다)
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT = 12_000;

// ===== /rate — 온디맨드 요율 조회 =====
// 목적지는 **이 표에 적힌 두 도메인으로 고정**이다. 사용자가 주는 건 URL이 아니라
// 슬러그 하나뿐이고, 그 슬러그는 [a-z0-9-] 로만 이루어져야 통과한다(RATE_SLUG).
// 그래서 `/?url=` 쪽처럼 "임의의 호스트를 검사해서 거른다"가 아니라
// **애초에 다른 곳으로 갈 수 있는 문자열을 만들 수 없다.** 공격면이 한 단계 좁다.
const RATE_PORTALS = [
  { key: 'rk',  hosts: ['www.rakuten.com', 'rakuten.com'],
    url: s => `https://www.rakuten.com/shop/${s}`, parse: parseRakuten },
  { key: 'tcb', hosts: ['www.topcashback.com', 'topcashback.com'],
    url: s => `https://www.topcashback.com/${s}/`, parse: parseTopcashback },
];
// 앞뒤가 영숫자이고 가운데만 하이픈. 점·슬래시·콜론·@·% 가 없으니 경로를 벗어날 수 없다.
const RATE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const RATE_CACHE_SECONDS = 21_600;  // 6시간 — 포털 기본율은 하루 단위로 움직인다
const RATE_FAIL_CACHE_SECONDS = 120; // 실패는 짧게만 — 일시적 실패가 6시간 눌러앉으면 안 된다
const RATE_MAX_HTML = 300_000;       // 요율은 <title>·요율 요소에 있다. 상품 페이지만큼 읽을 이유가 없다

export default {
  async fetch(request, env, ctx) {
    // ⚠️ headers.get 을 부르는 곳은 여기 하나뿐이다 (P-2). IP·쿠키·UA·request.cf 는 안 읽는다.
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const reqUrl = new URL(request.url);
    const path = reqUrl.pathname.replace(/\/+$/, '');

    // /vision 만 POST 다. 사진을 쿼리스트링에 담을 수 없기 때문이기도 하지만, 더 중요하게는
    // **URL 은 남는 자리**다 — 리퍼러·중간 프록시 접근로그·브라우저 히스토리. 본문은 안 남는다.
    if (path === '/vision') {
      if (request.method !== 'POST') return json({ error: '/vision 은 POST만 지원해' }, 405, cors);
      return handleVision(request, env, cors);
    }

    if (request.method !== 'GET') return json({ error: 'GET만 지원해' }, 405, cors);
    if (path === '/rate') {
      return handleRate(reqUrl.searchParams.get('store'), ctx, cors);
    }

    const target = reqUrl.searchParams.get('url');
    if (!target) return json({ error: 'url 파라미터가 필요해' }, 400, cors);

    let t;
    try { t = new URL(target); }
    catch { return json({ error: 'URL 형식이 아니야' }, 400, cors); }

    if (t.protocol !== 'http:' && t.protocol !== 'https:') {
      return json({ error: 'http(s)만 허용돼' }, 400, cors);
    }
    if (isBlockedHost(t.hostname)) {
      return json({ error: '허용되지 않은 호스트야' }, 400, cors);
    }

    // 캐시 조회
    const cacheKey = new Request('https://price-proxy.internal/' + encodeURIComponent(t.href));
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const body = await cached.json();
      return json({ ...body, cached: true }, 200, cors);
    }

    let html = '', status = 0;
    try {
      const res = await fetchFollowing(t.href, FETCH_TIMEOUT);
      status = res.status;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!/text\/html|xhtml|text\/plain|application\/json/.test(ct)) {
        return json({ price: null, status, error: 'HTML 응답이 아니야 (' + (ct || '알 수 없음') + ')' }, 200, cors);
      }
      html = await readCapped(res);
    } catch (e) {
      // 봇 차단·타임아웃 — 실패를 200으로 알려서 계산기가 조용히 직접입력으로 넘어가게 한다
      return json({ price: null, status, error: '가져오기 실패: ' + (e && e.message || e) }, 200, cors);
    }

    if (isChallengePage(html)) {
      return json({ price: null, status, error: '봇 차단 페이지를 받았어 — 이 사이트는 자동조회가 막혀 있어' }, 200, cors);
    }

    const { price, confidence } = parsePrice(html);
    const out = { price, confidence, title: parseTitle(html), status };

    if (out.price) {
      ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(out), {
        headers: {
          'content-type': 'application/json',
          'cache-control': 'max-age=' + CACHE_SECONDS,
        },
      })));
    }
    return json(out, 200, cors);
  },
};

// ===== /rate — 온디맨드 캐시백 요율 조회 =====
//
// 왜 이게 있나: 요율 사전(`rates.json`)은 114곳뿐이고, 그 밖의 판매처는 계산기에서
// "0%가 아니라 **모름**"으로 뜬다. 전수 수집(Rakuten 4,743 · TCB 9,826)은 일 2만 요청이라
// 차단 위험이 크고, **차단당하면 지금 잘 도는 114곳까지 같이 죽는다.** 그래서 벌크 대신
// "사용자가 실제로 물어본 한 곳만" 그때 조회한다.
//
// 응답 (포털별로 셋 중 하나 — 이 셋을 뭉개지 않는 게 핵심이다)
//   { pct: 8,    listed: true,  status: 'found' }        요율 확인
//   { pct: 0,    listed: true,  status: 'listed-zero' }  등재돼 있는데 캐시백 0% (쿠폰만)
//   { pct: null, listed: false, status: 'no-page' }      그 슬러그로는 상점 페이지가 없음
//   { pct: null, listed: null,  status: 'lookup-failed', error } 조회 실패 = **모름**
// `upTo: true`(≤N%), `flat: 5`($ 고정)는 rates.json 과 같은 뜻·같은 이름이다.
async function handleRate(rawStore, ctx, cors) {
  const store = String(rawStore == null ? '' : rawStore).trim().toLowerCase();
  if (!store) return json({ error: 'store 파라미터가 필요해' }, 400, cors);
  if (!RATE_SLUG.test(store)) {
    return json({ error: '상점 슬러그는 영문 소문자·숫자·하이픈만 돼 (최대 60자)' }, 400, cors);
  }

  // P-3: 캐시 키 재료는 슬러그 하나뿐. 오리진·IP·헤더가 안 들어가므로 사용자 단위 캐시가
  // 생길 수 없고, 같은 매장을 물어본 모든 사람이 같은 항목을 공유한다.
  const cacheKey = new Request('https://rate-proxy.internal/rate/' + store);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return json({ ...(await cached.json()), cached: true }, 200, cors);

  const results = await Promise.all(RATE_PORTALS.map(p => lookupRate(p, store)));
  const out = { store, checkedAt: new Date().toISOString() };
  RATE_PORTALS.forEach((p, i) => { out[p.key] = results[i]; });

  // 실패는 짧게만 캐시한다 — 일시적 봇 차단이 6시간 눌러앉으면 "모름"이 굳어버린다.
  const anyFail = results.some(r => r.status === 'lookup-failed');
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(out), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'max-age=' + (anyFail ? RATE_FAIL_CACHE_SECONDS : RATE_CACHE_SECONDS),
    },
  })));
  return json(out, 200, cors);
}

// 포털 한 곳 조회. 어떤 이유로 실패하든 예외를 밖으로 내보내지 않고
// 'lookup-failed'(= 모름)로 바꿔서 돌려준다. 절대 0%로 뭉개지 않는다.
async function lookupRate(portal, store) {
  try {
    const res = await fetchPinned(portal, portal.url(store), FETCH_TIMEOUT);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (res.status === 404) return { pct: null, listed: false, status: 'no-page' };
    if (res.status >= 400) return rateFailed(`포털이 HTTP ${res.status} 를 줬어`);
    if (ct && !/text\/html|xhtml/.test(ct)) return rateFailed('HTML 응답이 아니야 (' + ct + ')');
    const html = (await readCapped(res)).slice(0, RATE_MAX_HTML);
    if (isChallengePage(html)) return rateFailed('봇 차단 페이지를 받았어');
    return portal.parse(html);
  } catch (e) {
    return rateFailed((e && e.message) || String(e));
  }
}
const rateFailed = why => ({ pct: null, listed: null, status: 'lookup-failed', error: why });

// 리다이렉트를 따라가되 **그 포털의 도메인 밖으로는 한 발도 안 나간다.**
// `/?url=` 쪽 fetchFollowing 은 "사설 IP가 아니면 통과"지만, 여기선 목적지가 이미 정해져
// 있으므로 호스트 허용목록으로 못 박는다 — 포털이 302로 아무 데나 보내도 안 따라간다.
async function fetchPinned(portal, startUrl, ms) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isPinnedUrl(portal, url)) throw new Error('허용된 포털 도메인이 아니야');
    const res = await fetchOnce(url, ms);
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers.get('Location');
    if (!loc) return res;
    let next;
    try { next = new URL(loc, url); }
    catch { throw new Error('리다이렉트 주소가 잘못됐어'); }
    if (!isPinnedUrl(portal, next.href)) throw new Error('포털이 밖으로 넘겼어 — 따라가지 않아');
    url = next.href;
  }
  throw new Error('리다이렉트가 너무 많아');
}
function isPinnedUrl(portal, u) {
  let p;
  try { p = new URL(u); } catch { return false; }
  return p.protocol === 'https:' && portal.hosts.includes(p.hostname.toLowerCase());
}

// Rakuten — 상점 페이지 <title> 에 요율이 실려 있다.
//   "Nike Coupons, Promo Codes & 8% Cash Back - August 2026 | Rakuten"
//   "Best Buy … & Up to 7% Cash Back …"   → upTo
//   "Amazon … & $5 Cash Back …"           → flat
//   "… & No Cash Back …" / "… & Coupons Only …" → 0%
// 상점이 없으면 홈으로 리다이렉트되고 타이틀이 "Rakuten: Shop…" 으로 바뀐다 → 페이지 없음.
// (파서는 scripts/update-rates.mjs 와 같은 규칙이다. 규칙이 바뀌면 두 곳을 같이 고쳐야 한다.)
function parseRakuten(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = m ? m[1].replace(/\s+/g, ' ').trim() : '';
  if (!title) return rateFailed('타이틀을 못 찾았어');
  if (/^Rakuten\s*:/i.test(title)) return { pct: null, listed: false, status: 'no-page' };
  if (/No Cash Back|Coupons Only/i.test(title)) return { pct: 0, listed: true, status: 'listed-zero' };
  let r = title.match(/(Up to )?(\d+(?:\.\d+)?)%\s*Cash Back/i);
  if (r) {
    const o = { pct: +r[2], listed: true, status: 'found' };
    if (r[1]) o.upTo = true;
    return o;
  }
  r = title.match(/\$(\d+(?:\.\d+)?)\s*Cash Back/i);
  if (r) return { pct: null, flat: +r[1], listed: true, status: 'found' };
  return rateFailed('타이틀에서 요율을 못 읽었어');   // ← 0% 아님. 모름이다.
}

// TopCashback — class="merch-offer__rate" 요소에 "10% Cash Back" / "Up to 8% …".
// 요소가 없는데 상점 h1("… Cash Back Offers")이 있으면 쿠폰만 있는 0% 상점.
// 페이지 자체가 없으면 no-page.
function parseTopcashback(html) {
  const m = html.match(/merch-offer__rate[^>]*>([^<]+)</i);
  if (m) {
    const r = m[1].match(/(Up to )?(\d+(?:\.\d+)?)%/i);
    if (r) {
      const o = { pct: +r[2], listed: true, status: 'found' };
      if (r[1]) o.upTo = true;
      return o;
    }
  }
  if (/Page not found|Page Not Found/i.test(html)) return { pct: null, listed: false, status: 'no-page' };
  if (/<h1[^>]*>[^<]*Cash Back Offers/i.test(html)) return { pct: 0, listed: true, status: 'listed-zero' };
  return rateFailed('요율 요소를 못 찾았어');          // ← 0% 아님. 모름이다.
}

// ===== /vision — 사진에서 "검색어 후보"를 뽑는다 (v0.31) =====
//
// 근거 문서: 리서치/사진-상품인식-조사.md 6장(설계의 급소) · 4장(프라이버시) · 5-C(남용)
//            리서치/workers-ai-비전-실측-2026-08-20.md (Workers AI 가 왜 탈락했나)
//
// ⚠️ 이 엔드포인트가 만드는 것은 **검색어**다. 가격도, 최저가도, 상품 확정도 아니다.
//
// 설계의 핵심 두 줄 (조사 6-A·6-B — 이걸 모르면 아래 코드가 과해 보인다):
//   1. **모델이 말하는 신뢰도 숫자는 못 쓴다.** verbalized confidence 는 80~100% 에
//      5의 배수로 몰려서(ICLR 2024) `confidence < 70 이면 되묻기` 같은 게이트는 안 열린다.
//   2. 그래서 신뢰도 대신 **사실 보고**를 시킨다 — `read`(이미지에서 실제로 읽은 글자)와
//      `guessed`(짐작)를 갈라 받고, 후보를 여러 개 받는다. 되묻기 판단은 모델의 자기평가가
//      아니라 **`read` 가 비었는가**로 한다.
//
// 그리고 **모델이 그 계약을 지킬 거라고 믿지 않는다.** 아래 normalizeVision() 이
// 응답을 우리 쪽에서 다시 검사한다. 특히 auditGuessed() 는 실측에서 실제로 관찰된
// 실패(모델번호를 틀리게 읽고 read 에 넣는 것)를 겨냥한 자리다.

const VISION_MAX_IMAGES = 2;            // 되묻기까지 두 장. 세 번째는 없다 (조사 6-C)
const VISION_MAX_B64 = 1_800_000;       // base64 합계 상한. 1024px q0.75 두 장이면 여유가 크다
const VISION_TIMEOUT = 25_000;          // 매장에서 기다리는 시간이다. 넉넉하되 무한은 아니다
const VISION_MAX_CANDIDATES = 3;        // 조사 6-B 겹 1 (Google PAIR 의 N-best 권고)
const VISION_MAX_TOKENS = 700;          // ⚠️ 짧게 유지한다 — 실측에서 출력 토큰이 지연을 지배했다

// 되묻기 사유. **문구는 여기 없다** — 클라이언트(vision.js)가 이 열거값을 받아
// 자기 언어로 그린다. 모델에게 한국어 문구를 짓게 하면 (a)영어판이 깨지고
// (b)"다시 찍어 주세요" 같은 뭉뚱그린 문장이 나온다(조사 9장 #5가 금지한 것).
const VISION_ASK_REASONS = ['none', 'no-brand', 'no-model', 'packaging', 'too-far', 'multiple', 'none-recognized'];

// 모델에게 주는 스키마. 도구 호출(Anthropic)·responseSchema(Gemini) 양쪽에 그대로 쓴다.
// 형식을 강제로 못 박으면 "JSON 으로 답해줘" 보다 훨씬 안정적이다.
// ⚠️ null 을 안 쓴다 — 두 제공자의 스키마 방언에서 nullable 처리가 갈린다.
//    "되묻지 않음"은 ask.reason = 'none' 으로 표현하고, 정규화에서 null 로 바꾼다.
function visionSchema() {
  const str = d => ({ type: 'string', description: d });
  return {
    type: 'object',
    properties: {
      category: str('What kind of product this is, in the requested language. Empty string if unknown.'),
      candidates: {
        type: 'array',
        description: 'Up to 3 search queries that MEANINGFULLY DIFFER from each other. Empty if you cannot identify the product.',
        items: {
          type: 'object',
          properties: {
            query: str('An English search query for a US retailer.'),
            why: str('One short phrase, in the requested language, saying what this query is based on.'),
          },
          required: ['query', 'why'],
        },
      },
      read: {
        type: 'array',
        description: 'Verbatim strings of characters literally visible in the image, copied character by character. Nothing else - no descriptions, no explanations. Empty array if you can read no text.',
        items: { type: 'string' },
      },
      guessed: {
        type: 'array',
        description: 'Things you inferred that are NOT printed anywhere in the image. In the requested language.',
        items: { type: 'string' },
      },
      ask: {
        type: 'object',
        properties: {
          reason: { type: 'string', enum: VISION_ASK_REASONS, description: 'Use none if you do not need another photo.' },
          detail: str('Optional: what you did manage to see. Requested language. Empty string if nothing to add.'),
        },
        required: ['reason'],
      },
    },
    required: ['category', 'candidates', 'read', 'guessed', 'ask'],
  };
}

// 프롬프트. **"확신하냐"고 묻지 않는다 — "무엇을 보았냐"고 묻는다**(조사 6-B 근거 1).
// 모델이 잘하는 과제(사실 보고·나열)만 시키고, 못하는 과제(확률 보정)는 안 시킨다.
function visionPrompt(lang, nImages) {
  const langName = lang === 'en' ? 'English' : 'Korean';
  return [
    'A shopper is standing in a store and photographed a product. Your job is to produce SEARCH QUERIES they can use to find this exact product on US retail sites. You are not asked to find a price.',
    nImages > 1 ? 'There are ' + nImages + ' photos OF THE SAME PRODUCT. Use them together - one may show the shape, another may show the label.' : '',
    '',
    'These rules outrank being helpful:',
    '1. "read" is ONLY verbatim strings of characters you can literally see printed in the image, copied character by character. If you are unsure of even one character of a string, LEAVE IT OUT of "read".',
    '1b. "read" must contain NOTHING BUT those verbatim strings. No descriptions, no explanations, no language of your own. Write "OLED65C2", never "the box says OLED65C2". A logo with no letters is not text - if you recognise a swoosh but read no letters, that belongs in "guessed", not "read". Put your reasoning in "why" instead.',
    '2. NEVER put a model number in "read" unless you can read every character of it. A model number that is one character wrong sends the shopper to the wrong product.',
    '3. "guessed" is anything you inferred that is NOT printed in the image - a model year inferred from the shape, a product line inferred from a logo. If a candidate query contains something you did not read, it MUST appear in "guessed".',
    '4. Give up to 3 candidates that MEANINGFULLY DIFFER - e.g. one specific, one broader, one alternative reading. If you only know the brand, make the queries broader. DO NOT invent a model number to fill a slot. Two candidates, or one, is a fine answer.',
    '5. If you cannot identify the product at all, return "candidates": [] and set ask.reason to "none-recognized". Do NOT offer a similar product instead.',
    '',
    'Set ask.reason to ask for one more photo when it would help:',
    '  "no-brand"   - you cannot tell the brand; a logo or brand name needs to be in frame',
    '  "no-model"   - you know the brand but not which model; a model-number sticker, tag or label would settle it',
    '  "packaging"  - the item appears to have a box or packaging whose printed text would identify it',
    '  "too-far"    - the text is there but too small or too far away to read',
    '  "multiple"   - several different products are in frame and you cannot tell which one they mean',
    '  "none"       - you do not need another photo',
    '',
    'Search queries ("query") must be in English. Write "category", "why" and "detail" in ' + langName + '.',
  ].filter(Boolean).join('\n');
}

async function handleVision(request, env, cors) {
  const provider = String((env && env.VISION_PROVIDER) || 'anthropic').toLowerCase();
  if (provider !== 'anthropic' && provider !== 'gemini') {
    return visionErr('bad-config', '알 수 없는 제공자 설정이야: ' + provider, cors, 503);
  }

  const key = env && env.VISION_API_KEY;
  if (!key) {
    // 키가 없는 것은 "장애"가 아니라 "아직 안 켰다"이다. 클라이언트는 이 코드를 보고
    // 사진 버튼을 조용히 숨긴다 — 눌러서 실패하게 두지 않는다.
    return visionErr('no-key', '사진 인식이 아직 켜져 있지 않아요', cors, 503);
  }

  // ⚠️ Gemini 함정 (조사 9장 #1): 무료 티어 약관에 "human reviewers may read, annotate,
  // and process your API input and output" 이 있다. **사람이 사용자의 매장 사진을 읽는다.**
  // 그런데 키만 봐서는 무료인지 유료인지 알 수 없다 → 코드로는 구분이 불가능하다.
  // 그래서 운영자가 명시적으로 확인하게 만든다. 이걸 안 켜면 고지 문구가 조용히 거짓이 된다.
  if (provider === 'gemini' && String(env.VISION_GEMINI_PAID_TIER || '') !== 'confirmed') {
    return visionErr('gemini-tier-unconfirmed',
      'Gemini 는 유료 티어 확인 없이는 안 써 — VISION_GEMINI_PAID_TIER=confirmed 가 필요해', cors, 503);
  }

  let body;
  try { body = await request.json(); }
  catch { return visionErr('bad-request', 'JSON 본문이 필요해', cors, 400); }

  const images = Array.isArray(body && body.images) ? body.images : [];
  if (!images.length) return visionErr('bad-request', 'images 가 비어 있어', cors, 400);
  if (images.length > VISION_MAX_IMAGES) {
    return visionErr('bad-request', '사진은 최대 ' + VISION_MAX_IMAGES + '장까지야', cors, 400);
  }
  let total = 0;
  for (const im of images) {
    if (typeof im !== 'string' || !im) return visionErr('bad-request', '사진 형식이 잘못됐어', cors, 400);
    // base64 만 받는다. 다른 문자가 섞여 있으면 우리 클라이언트가 만든 게 아니다.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(im)) return visionErr('bad-request', '사진이 base64 가 아니야', cors, 400);
    total += im.length;
  }
  if (total > VISION_MAX_B64) return visionErr('too-large', '사진이 너무 커 — 더 작게 줄여서 보내줘', cors, 413);

  const lang = body && body.lang === 'en' ? 'en' : 'ko';
  const model = String(env.VISION_MODEL || (provider === 'gemini' ? 'gemini-2.5-flash-lite' : 'claude-haiku-4-5'));
  const call = provider === 'gemini' ? callGeminiVision : callAnthropicVision;

  let raw;
  try {
    raw = await call({ key, model, images, prompt: visionPrompt(lang, images.length), env });
  } catch (e) {
    // 실패는 실패라고 말한다. **추측한 검색어를 대신 내놓지 않는다**
    // (조사 8장 "조용히 틀리지 않는 구조" 마지막 줄).
    return visionErr('provider-error', (e && e.message) || String(e), cors, 200);
  }
  if (!raw || typeof raw !== 'object') return visionErr('provider-refused', '인식 결과를 받지 못했어', cors, 200);

  return json({ ok: true, ...normalizeVision(raw) }, 200, cors);
}

const visionErr = (code, why, cors, status) =>
  json({ ok: false, errorCode: code, error: why }, status || 200, cors);

// ---------------------------------------------------------------------------
// 응답 정규화 — **모델이 계약을 지킬 거라고 믿지 않는다**
// ---------------------------------------------------------------------------
// 실측(workers-ai-비전-실측-2026-08-20.md 4-D)에서 관찰된 것: 형식은 맞는데 내용이
// 전부 어긋났다. read 에 틀린 모델번호가 들어갔고, 후보 3개가 같은 문자열의 접두사였고,
// guessed 와 read 가 뒤집혀 있었다. 그 중 **코드로 잡을 수 있는 것은 여기서 잡는다.**
function normalizeVision(r) {
  const s = (v, max) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  const arr = (v, max, cap) => (Array.isArray(v) ? v : []).map(x => s(x, max)).filter(Boolean).slice(0, cap);

  const read = arr(r.read, 80, 6);
  const guessed = arr(r.guessed, 160, 6);

  // 후보 — 빈 query 는 버리고, **같은 검색어는 합친다.**
  // 왜 합치나: 후보 여러 개의 값어치는 "갈리는 것 자체가 불확실성 신호"라는 데 있다(조사 6-B 겹 1).
  // 실측에서 세 후보가 같은 문자열의 접두사로 나온 적이 있는데, 그걸 3개인 척 보여주면
  // **없는 확실성을 지어내는 것**이다. 하나로 줄어들면 줄어든 대로 보여준다.
  const seen = new Set();
  const candidates = [];
  for (const c of (Array.isArray(r.candidates) ? r.candidates : [])) {
    const query = s(c && c.query, 120);
    if (!query) continue;
    const k = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    candidates.push({ query, why: s(c && c.why, 160) });
    if (candidates.length >= VISION_MAX_CANDIDATES) break;
  }

  let reason = (r.ask && VISION_ASK_REASONS.includes(r.ask.reason)) ? r.ask.reason : 'none';
  // 후보가 없으면 되묻기 사유는 무조건 "못 알아봤다"이다. 모델이 none 이라 해도 덮는다 —
  // 후보 0개 + 되묻기 없음 = 사용자가 갈 곳이 없는 화면이다.
  if (!candidates.length && reason === 'none') reason = 'none-recognized';

  return {
    category: s(r.category, 60),
    candidates,
    read,
    guessed: auditGuessed(candidates, read, guessed),
    ask: reason === 'none' ? null : { reason, detail: s(r.ask && r.ask.detail, 160) },
  };
}

// ⭐ 이 함수가 이 엔드포인트에서 가장 중요한 자리다.
//
// 실측에서 모델은 OLED65C2 를 OLED-D65C2 로, KX-7742B 를 KX-7744B 로 읽고
// **그것을 read(= 실제로 읽은 글자) 에 넣었다.** 화면에는 "박스에서 …를 읽었어요" 로
// 나가므로, 그대로 두면 **거짓말이 사용자 눈앞에 인쇄된다.**
//
// 모델이 정직해지게 만들 방법은 없다. 대신 **검색어에 들어간 모델번호가 read 에
// 뒷받침되는지 우리가 대조한다.** 뒷받침이 없으면 그건 정의상 짐작이므로 guessed 로 옮긴다.
// 그러면 화면에 ⚠️ "'…'는 사진에서 확인하지 못했어요" 가 뜨고, 사용자가 손에 든 물건과
// 대조할 수 있다 — 보정 문제를 사용자에게 떠넘기는 게 아니라 **검증 가능한 형태로 바꾸는 것**이다.
//
// 무엇을 모델번호로 보는가: **영문자와 숫자가 섞인 4자 이상 토큰.**
// OLED65C2·KX-7742B·WH-1000XM5 가 걸리고, Nike·sneakers·65(순수 숫자)는 안 걸린다.
// 순수 숫자를 뺀 이유: "65인치"·"40oz" 같은 치수는 사진에서 못 읽어도 카테고리로 짐작할 수 있고,
// 한 글자 틀려도 검색 결과가 눈에 띄게 어긋나서 사용자가 바로 안다. 모델번호는 그렇지 않다.
//
// ⚠️ 대조는 **구두점을 지우고** 한다 — read 에 "OLED65C2", 검색어에 "OLED-65C2" 로
//    나오는 경우를 다른 값으로 세면 멀쩡한 걸 짐작이라고 표시하게 된다.
function auditGuessed(candidates, read, guessed) {
  const haystack = read.join(' ').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const already = guessed.join(' ').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const out = guessed.slice();
  const flagged = new Set();

  for (const c of candidates) {
    for (const tok of String(c.query).split(/[\s,]+/)) {
      const t = tok.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '');
      if (t.length < 4) continue;
      if (!/[A-Za-z]/.test(t) || !/[0-9]/.test(t)) continue;          // 문자+숫자 혼합만
      const flat = t.toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (!flat || flagged.has(flat)) continue;
      flagged.add(flat);
      if (haystack.includes(flat)) continue;                          // read 가 뒷받침한다
      if (already.includes(flat)) continue;                           // 모델이 이미 짐작이라고 밝혔다
      out.push('UNVERIFIED:' + t);   // 문구는 클라이언트가 붙인다 (언어별로 달라야 하므로)
    }
  }
  return out.slice(0, 8);
}

// ---------------------------------------------------------------------------
// 제공자 호출
// ---------------------------------------------------------------------------
// 두 곳 다 **구조화 출력**을 강제한다 — "JSON 으로 답해줘"는 형식이 깨진다.
//
// ⚠️ cf-aig-collect-log: false 를 항상 붙인다. 지금은 제공자를 직접 부르므로 이 헤더가
//    무시되지만, 나중에 누가 VISION_BASE_URL 을 Cloudflare AI Gateway 로 돌리면
//    **게이트웨이가 기본값으로 프롬프트와 응답(= 사진과 인식 결과)을 로그에 저장한다**(조사 5-C).
//    그때 이 줄이 없으면 조용히 사진이 쌓인다. 미리 박아 둔다 — 대시보드 옵트아웃과 둘 다 해야 한다.
const AI_GATEWAY_NO_LOG = { 'cf-aig-collect-log': 'false' };

async function visionFetch(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VISION_TIMEOUT);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

async function callAnthropicVision({ key, model, images, prompt, env }) {
  const base = String(env.VISION_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const content = images.map(data => ({
    type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data },
  }));
  content.push({ type: 'text', text: prompt });

  const res = await visionFetch(base + '/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      ...AI_GATEWAY_NO_LOG,
    },
    body: JSON.stringify({
      model,
      max_tokens: VISION_MAX_TOKENS,
      tools: [{
        name: 'report_product',
        description: 'Report what you can and cannot read on the product in the photo.',
        input_schema: visionSchema(),
      }],
      tool_choice: { type: 'tool', name: 'report_product' },
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) throw new Error('인식 서버가 HTTP ' + res.status + ' 를 줬어');
  const j = await res.json();
  const tu = (j && Array.isArray(j.content) ? j.content : []).find(b => b && b.type === 'tool_use');
  return tu ? tu.input : null;
}

async function callGeminiVision({ key, model, images, prompt, env }) {
  const base = String(env.VISION_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const parts = images.map(data => ({ inline_data: { mime_type: 'image/jpeg', data } }));
  parts.push({ text: prompt });

  const res = await visionFetch(base + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key, ...AI_GATEWAY_NO_LOG },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        maxOutputTokens: VISION_MAX_TOKENS,
        responseMimeType: 'application/json',
        responseSchema: visionSchema(),
      },
    }),
  });
  if (!res.ok) throw new Error('인식 서버가 HTTP ' + res.status + ' 를 줬어');
  const j = await res.json();
  const txt = j && j.candidates && j.candidates[0] && j.candidates[0].content
    && j.candidates[0].content.parts && j.candidates[0].content.parts[0]
    && j.candidates[0].content.parts[0].text;
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { throw new Error('인식 결과가 JSON 이 아니야'); }
}

// ===== 응답 헬퍼 =====
function corsHeaders(origin) {
  const allowed = ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors },
  });
}
async function fetchOnce(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    // redirect:'manual' — 자동 추적을 쓰면 호스트 검사가 '최초 URL'에만 걸린다.
    // 공개 URL이 302로 내부 주소를 가리키면 그대로 통과해버리므로, 홉마다 직접 검사한다.
    return await fetch(url, { headers: BROWSER_HEADERS, redirect: 'manual', signal: ctrl.signal });
  } finally { clearTimeout(timer); }
}
// 리다이렉트를 직접 따라가되, 홉마다 목적지 호스트를 다시 검사한다.
// 소매 사이트는 http→https, non-www→www, 로케일 등으로 여러 번 넘기므로 추적은 필요하다.
async function fetchFollowing(startUrl, ms) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchOnce(url, ms);
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers.get('Location');
    if (!loc) return res;                       // 3xx인데 Location이 없으면 그대로 넘긴다
    let next;
    try { next = new URL(loc, url); }
    catch { throw new Error('리다이렉트 주소가 잘못됐어'); }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new Error('리다이렉트가 http(s)가 아닌 곳을 가리켜');
    }
    if (isBlockedHost(next.hostname)) {
      throw new Error('리다이렉트가 허용되지 않은 호스트로 향해');
    }
    url = next.href;
  }
  throw new Error('리다이렉트가 너무 많아');
}
// 응답 본문을 상한까지만 읽는다.
// res.text()는 자르기 전에 전부 버퍼링해서, 거대 응답이면 Worker 메모리 한도(128MB)에
// 걸린다. MAX_HTML은 '파싱량'만 제한할 뿐 '읽는 양'은 못 막는다.
async function readCapped(res) {
  const cl = +(res.headers.get('content-length') || 0);
  if (cl && cl > MAX_BYTES) throw new Error(`응답이 너무 커 (${(cl / 1e6).toFixed(1)}MB)`);
  if (!res.body || typeof res.body.getReader !== 'function') {
    return (await res.text()).slice(0, MAX_HTML);   // 스트림이 없는 환경(테스트 스텁 등)
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let out = '', total = 0;
  try {
    while (total < MAX_BYTES && out.length < MAX_HTML) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      out += dec.decode(value, { stream: true });
    }
    out += dec.decode();
  } finally {
    try { await reader.cancel(); } catch { /* 이미 닫혔으면 무시 */ }
  }
  return out.slice(0, MAX_HTML);
}

// ===== SSRF 차단 =====
// 방침: **IP 리터럴은 전부 거부하고 도메인만 허용한다.**
//
// 처음엔 사설 대역을 하나씩 나열했는데, 퍼즈 테스트(2026-08-11)에서
// `[::ffff:127.0.0.1]`(IPv4 매핑 IPv6)이 그물을 빠져나갔다. 나열식은 변종이 나올 때마다
// 뚫린다 — NAT64(`64:ff9b::`), IPv4 호환 IPv6, 8진/16진 표기 등 끝이 없다.
// 상품 페이지 URL이 raw IP인 경우는 실질적으로 없으므로, 대역을 쫓는 대신
// "IP 리터럴이면 무조건 거부"가 훨씬 단순하고 강하다.
function isBlockedHost(host) {
  const h = (host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;

  // 1) 이름 기반
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  if (h === 'metadata.google.internal') return true;

  // 2) IP 리터럴 — 형태를 가리지 않고 전부 거부
  if (h.includes(':')) return true;                    // IPv6 (::1, ::ffff:7f00:1, 64:ff9b::, fd00:: …)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;  // IPv4 점4자리
  if (/^\d+$/.test(h)) return true;                    // 10진 정수형(2130706433) — URL 정규화 전 방어
  if (/^0x[0-9a-f]+$/.test(h)) return true;            // 16진형 — 같은 이유

  // 3) 이름 안에 사설 IP가 박힌 와일드카드 DNS (nip.io / sslip.io 류)
  //    169.254.169.254.nip.io → DNS가 169.254.169.254 를 돌려준다.
  //    ⚠️ 이건 DNS 리바인딩 '일반'의 해결이 아니다. 임의의 도메인이 사설 IP를 가리키는지는
  //       이름만 봐서는 알 수 없고, Workers에선 해석 결과를 볼 수 없다.
  //       여기서 막는 건 '이름에 IP를 담는' 알려진 패턴뿐이다.
  for (const seg of h.match(/(\d{1,3})[.-](\d{1,3})[.-](\d{1,3})[.-](\d{1,3})/g) || []) {
    const p = seg.split(/[.-]/).map(Number);
    if (p.every(n => n <= 255) && isPrivateV4(p)) return true;
  }
  return false;
}
function isPrivateV4([a, b]) {
  return a === 10 || a === 127 || a === 0 ||
         (a === 192 && b === 168) ||
         (a === 172 && b >= 16 && b <= 31) ||
         (a === 169 && b === 254) ||          // 클라우드 메타데이터
         a >= 224;                            // 멀티캐스트/예약
}

// ===== 봇 차단 페이지 감지 =====
// Walmart 등은 차단해도 HTTP 200을 준다. 내용이 "Robot or human?" 같은 챌린지 페이지라
// "가격 못 찾음"이 아니라 "차단당함"이라고 정확히 말해야 한다.
function isChallengePage(html) {
  const head = html.slice(0, 4000).toLowerCase();
  return /robot or human|are you a human|access denied|verify you are|captcha|unusual traffic|pardon our interruption/.test(head);
}

// ===== 가격 파싱 =====
// 신뢰도 순서: JSON-LD → 메타태그 → JSON 키 → 본문 텍스트
// 앞의 셋은 '가격'이라고 명시된 자리라 신뢰(high). 마지막 본문 $텍스트는 추측(low)이다.
//   예) Amazon은 본문에 $29.00(다른 항목)이 먼저 나오고 진짜 가격은 "priceAmount":249.00 에 있다.
//       JSON 키를 텍스트보다 먼저 보지 않으면 249 대신 29를 집는다.
function parsePrice(html) {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const p = findLdPrice(JSON.parse(m[1].trim()));
      if (p) return { price: p, confidence: 'high' };
    } catch { /* 깨진 JSON-LD는 흔하다 — 조용히 넘어간다 */ }
  }
  let m =
    html.match(/(?:og|product):price:amount["'][^>]*content=["']\$?([\d,]+(?:\.\d{1,2})?)/i) ||
    html.match(/content=["']\$?([\d,]+(?:\.\d{1,2})?)["'][^>]*(?:og|product):price:amount/i) ||
    html.match(/itemprop=["']price["'][^>]*content=["']\$?([\d,]+(?:\.\d{1,2})?)/i);
  if (m) { const n = +m[1].replace(/,/g, ''); if (n > 0) return { price: n, confidence: 'high' }; }

  // "첫 매치"가 아니라 "0보다 큰 첫 매치" — 자리표시자 0이 앞에 오는 페이지가 흔하다
  // (Crocs는 본문에 $0.00 이 $34.99 보다 앞선다)
  for (const mm of html.matchAll(/"(?:priceAmount|price|currentPrice|salePrice|listPrice)"\s*:\s*"?\$?(\d{1,7}(?:\.\d{1,2})?)"?/gi)) {
    const n = +mm[1];
    if (n > 0) return { price: n, confidence: 'high' };
  }
  for (const mm of html.matchAll(/\$\s?(\d{1,3}(?:,\d{3})*\.\d{2})/g)) {
    const n = +mm[1].replace(/,/g, '');
    if (n > 0) return { price: n, confidence: 'low' };
  }
  return { price: null, confidence: null };
}
function findLdPrice(j) {
  if (!j) return null;
  if (Array.isArray(j)) { for (const x of j) { const p = findLdPrice(x); if (p) return p; } return null; }
  if (typeof j === 'object') {
    if (j.offers) {
      const o = Array.isArray(j.offers) ? j.offers[0] : j.offers;
      const raw = o && (o.price != null ? o.price : o.lowPrice);
      if (raw != null) { const n = +String(raw).replace(/[^0-9.]/g, ''); if (n > 0) return n; }
    }
    for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item']) {
      if (j[k]) { const p = findLdPrice(j[k]); if (p) return p; }
    }
  }
  return null;
}

// 상품명 — 계산기가 URL 슬러그로 추정하는 것보다 정확하다
function parseTitle(html) {
  let m = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']{2,120})/i)
       || html.match(/<title[^>]*>([^<]{2,120})/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}
