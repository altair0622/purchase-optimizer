/**
 * price-proxy — 상품 페이지에서 "가격만" 뽑아 JSON으로 돌려주는 Cloudflare Worker
 *
 * 왜 만들었나
 *  - 계산기는 정적 페이지(GitHub Pages)라 상품 사이트를 직접 못 부른다(CORS).
 *  - 그래서 공개 CORS 프록시 3개를 돌려썼는데, 2026-08-11 점검 결과
 *    corsproxy.io = 403, allorigins = 무응답. 사실상 한 곳만 살아 있었다.
 *  - 서버(=이 워커)를 두면 CORS가 사라지고, 프록시 생사에 의존하지 않는다.
 *
 * 설계 결정
 *  1) HTML을 그대로 돌려주지 않고 **가격만 파싱해서 반환**한다.
 *     → 아무나 쓸 수 있는 범용 오픈 프록시가 되는 걸 막고, 응답도 훨씬 작아진다.
 *  2) SSRF 차단 — 사설/내부 IP와 클라우드 메타데이터 주소는 거부한다.
 *  3) 30분 캐시 — 같은 상품을 여러 번 열어도 원 사이트엔 한 번만 간다.
 *
 * 한계(솔직히)
 *  - 봇 차단이 강한 곳(Best Buy 등)은 서버로 불러도 막힌다. CORS는 풀리지만
 *    봇 탐지는 안 풀린다. 실패하면 price:null을 주고, 계산기는 직접 입력을 안내한다.
 */

// 계산기가 올라가 있는 오리진만 허용. 'null'은 file:// 로컬 테스트용.
const ALLOW_ORIGINS = [
  'https://altair0622.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'null',
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
const MAX_HTML = 2_000_000;   // 2MB 넘으면 잘라서 파싱(메모리 보호)
const FETCH_TIMEOUT = 12_000;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'GET만 지원해' }, 405, cors);

    const target = new URL(request.url).searchParams.get('url');
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
      const res = await fetchWithTimeout(t.href, FETCH_TIMEOUT);
      status = res.status;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!/text\/html|xhtml|text\/plain|application\/json/.test(ct)) {
        return json({ price: null, status, error: 'HTML 응답이 아니야 (' + (ct || '알 수 없음') + ')' }, 200, cors);
      }
      html = (await res.text()).slice(0, MAX_HTML);
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

// ===== 응답 헬퍼 =====
function corsHeaders(origin) {
  const allowed = ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow', signal: ctrl.signal });
  } finally { clearTimeout(timer); }
}

// ===== SSRF 차단 =====
// 사설망·루프백·링크로컬·클라우드 메타데이터로 요청이 새어나가지 않게 막는다.
function isBlockedHost(host) {
  const h = (host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return true;   // IPv6 ULA/링크로컬
  if (h === 'metadata.google.internal') return true;

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;   // AWS/GCP 메타데이터 169.254.169.254
    if (a >= 224) return true;                 // 멀티캐스트/예약
  }
  return false;
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
