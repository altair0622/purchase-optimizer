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
