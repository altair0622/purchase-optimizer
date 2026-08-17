/* v0.25 price-proxy 워커 퍼즈 테스트
 *
 * 실제 네트워크는 절대 안 쓴다 — globalThis.fetch 를 스텁으로 바꿔서
 * ① 적대적 URL(SSRF 우회 시도·이상한 스킴·인코딩) ② 적대적 응답(봇차단·거대응답·깨진 JSON-LD)
 * 을 먹이고, 워커가 지켜야 할 불변식을 검사한다.
 *
 * 검사하는 불변식
 *  1. 어떤 입력에도 예외를 던지지 않고 Response 를 돌려준다
 *  2. 차단 대상 호스트로는 fetch 가 나가지 않는다 (SSRF)
 *  3. CORS Allow-Origin 은 항상 허용 목록 안의 값이다 (임의 오리진 반사 금지)
 *  4. 응답은 항상 파싱 가능한 JSON이고, price 는 null 또는 유한 양수다
 *  5. 원본 HTML 을 그대로 돌려주지 않는다 (범용 오픈 프록시 금지)
 *  6. GET 이외 메서드는 405 + fetch 안 나감
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = process.argv[2];

// 원본은 ESM(export default)인데 확장자가 .js 라 CJS로 잡힌다 → .mjs 사본으로 임포트
const dir = mkdtempSync(join(tmpdir(), 'wfuzz-'));
const copy = join(dir, 'worker.mjs');
writeFileSync(copy, readFileSync(SRC));

// ===== Cloudflare 런타임 스텁 =====
// 실제 Cloudflare caches.default.match() 는 매번 새 Response 를 준다 →
// 본문(text)만 저장하고 match 마다 새로 만들어야 한다. (처음에 clone 을 저장했다가
// "Body has already been read" 예외 19건이 나왔는데, 그건 워커 버그가 아니라 이 스텁 버그였다.)
const cacheStore = new Map();
globalThis.caches = {
  default: {
    async match(req) {
      const hit = cacheStore.get(req.url);
      return hit === undefined ? undefined : new Response(hit, { headers: { 'content-type': 'application/json' } });
    },
    async put(req, res) { cacheStore.set(req.url, await res.text()); },
  },
};
const ctx = { waitUntil: p => { if (p && p.catch) p.catch(() => {}); } };

// ===== fetch 스텁 — 나간 요청을 기록하고 적대적 응답을 준다 =====
let fetchLog = [];
let responder = () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
// 실제 런타임처럼 redirect 옵션을 존중한다. 'manual' 이 아니면 **스텁이 알아서 따라간다**.
// 이게 없으면 워커가 redirect:'follow' 로 되돌아가도(=런타임이 몰래 따라가서 호스트 검사를
// 우회하는 상황) 스텁이 302 를 워커에 그대로 넘겨줘 워커의 홉 검사가 계속 작동하는 것처럼
// 보인다 — 음성 대조군에서 실제로 안 잡혔다.
const STUB_MAX_HOPS = 10;
globalThis.fetch = async (url, opt) => {
  opt = opt || {};
  let cur = String(url);
  for (let i = 0; i < STUB_MAX_HOPS; i++) {
    fetchLog.push(cur);
    const res = await responder(cur, opt);
    const loc = res.headers && res.headers.get ? res.headers.get('Location') : null;
    const isRedir = res.status >= 300 && res.status < 400 && loc;
    if (!isRedir || opt.redirect === 'manual' || opt.redirect === 'error') return res;
    cur = new URL(loc, cur).href;
  }
  throw new Error('스텁 리다이렉트 상한 초과');
};

const worker = (await import(pathToFileURL(copy).href)).default;

// ===== 시드 PRNG =====
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ===== 공격 대상 호스트 — 여기로 fetch 가 나가면 SSRF =====
// 각 항목: [호스트, 실제로 가리키는 곳]
const SSRF_HOSTS = [
  ['127.0.0.1', '루프백'],
  ['localhost', '루프백'],
  ['10.0.0.5', '사설망'],
  ['192.168.1.1', '사설망'],
  ['172.16.0.1', '사설망'],
  ['169.254.169.254', '클라우드 메타데이터'],
  ['[::1]', '루프백 IPv6'],
  ['metadata.google.internal', 'GCP 메타데이터'],
  ['0.0.0.0', '전체 인터페이스'],
  // --- 인코딩 우회 시도 ---
  ['2130706433', '127.0.0.1 (10진 정수)'],
  ['0x7f000001', '127.0.0.1 (16진)'],
  ['0177.0.0.1', '127.0.0.1 (8진)'],
  ['127.0.0.1.', '127.0.0.1 (끝점)'],
  ['127.1', '127.0.0.1 (축약)'],
  ['[::ffff:127.0.0.1]', '127.0.0.1 (IPv4 매핑)'],
  ['[::ffff:7f00:1]', '127.0.0.1 (IPv4 매핑·정규형)'],
  ['[64:ff9b::127.0.0.1]', '127.0.0.1 (NAT64)'],
  ['[::127.0.0.1]', '127.0.0.1 (IPv4 호환)'],
  ['[0:0:0:0:0:0:0:1]', '루프백 IPv6 (전체표기)'],
  ['[fd00::1]', '사설 IPv6 (ULA)'],
  ['[fe80::1]', '링크로컬 IPv6'],
  ['127.000.000.001', '127.0.0.1 (0 채움)'],
  ['LOCALHOST', '루프백 (대문자)'],
  ['foo.localhost', '루프백 (서브도메인)'],
  ['127.0.0.1:8080', '루프백 + 포트'],
  ['169.254.169.254.nip.io', '메타데이터 (DNS 와일드카드)'],
  ['127.0.0.1.nip.io', '루프백 (DNS 와일드카드)'],
  // 공인 IP 리터럴 — v0.26 정책은 "IP 리터럴은 형태 불문 거부"이므로 이것도 나가면 안 된다.
  // (상품 URL이 raw IP인 경우는 없다. 여기서 실패하면 정책이 느슨해진 것)
  ['8.8.8.8', '공인 IP 리터럴'],
  ['1.1.1.1', '공인 IP 리터럴'],
];
// 이 호스트로 나가면 안 된다고 판단하는 기준 (스텁이 받은 URL 기준)
function isPrivateTarget(u) {
  let h;
  try { h = new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1' || h.endsWith(':127.0.0.1')) return true;
  if (h === 'metadata.google.internal') return true;
  if (/(^|\.)169\.254\.169\.254(\.|$)/.test(h)) return true;
  // 10진/16진/8진 정수 표기 → 실제 IP로 환산
  if (/^\d+$/.test(h)) { const n = +h; if (n >>> 24 === 127 || n >>> 24 === 10 || n === 0) return true; }
  if (/^0x[0-9a-f]+$/.test(h)) { const n = parseInt(h, 16); if (n >>> 24 === 127) return true; }
  if (/^0\d/.test(h.split('.')[0]) && h.split('.').length === 4) { if (parseInt(h.split('.')[0], 8) === 127) return true; }
  const p = h.replace(/\.$/, '').split('.');
  if (p.length >= 2 && p.every(x => /^\d+$/.test(x))) {
    const a = +p[0], b = +p[1];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  if (p.length === 2 && +p[0] === 127) return true;   // 127.1
  return false;
}

// ===== 적대적 응답들 =====
const BODIES = [
  ['정상 JSON-LD', '<html><script type="application/ld+json">{"@type":"Product","offers":{"price":"49.99"}}</script></html>', 'text/html'],
  ['깨진 JSON-LD', '<html><script type="application/ld+json">{oops,,,</script>$12.34</html>', 'text/html'],
  ['og:price', '<html><meta property="og:price:amount" content="129.00"></html>', 'text/html'],
  ['자리표시자 0 먼저', '<html>$0.00 ... "price":"0" ... $34.99</html>', 'text/html'],
  ['봇차단 200', '<html><h1>Robot or human?</h1></html>', 'text/html'],
  ['CAPTCHA', '<html>Please verify you are a human</html>', 'text/html'],
  ['가격 없음', '<html><title>No price here</title></html>', 'text/html'],
  ['이미지 응답', 'PNG\x00\x01binary', 'image/png'],
  ['JSON 응답', '{"priceAmount":249.00}', 'application/json'],
  ['content-type 없음', '<html>$9.99</html>', ''],
  ['거대 숫자', '<html>"price":"99999999999999"</html>', 'text/html'],
  ['음수 가격', '<html><meta property="og:price:amount" content="-50.00"></html>', 'text/html'],
  ['천단위 콤마', '<html>$1,299.00</html>', 'text/html'],
  ['XSS 시도', '<html><title></title><script>alert(1)</script>$5.00</html>', 'text/html'],
  ['LD 배열 중첩', '<html><script type="application/ld+json">[{"@graph":[{"offers":[{"lowPrice":"77.50"}]}]}]</script></html>', 'text/html'],
  ['빈 응답', '', 'text/html'],
  ['ReDoS 후보(콤마 폭탄)', '<html><meta property="og:price:amount" content="' + '9,'.repeat(4000) + '">' , 'text/html'],
  ['ReDoS 후보($ 반복)', '<html>' + '$'.repeat(20000) + '1.00</html>', 'text/html'],
  ['큰 HTML(5MB)', '<html>' + 'x'.repeat(5_000_000) + '$19.99</html>', 'text/html'],
];

const ORIGINS = [
  'https://altair0622.github.io', 'null', 'http://localhost:8080',
  'https://evil.example.com', 'https://altair0622.github.io.evil.com', '', 'javascript:alert(1)',
];
const METHODS = ['GET', 'GET', 'GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'];

const fails = [];
const stats = { n: 0, blocked: 0, fetched: 0, priceFound: 0, cached: 0, errors: 0, slowest: 0, slowCase: '' };
const rnd = mulberry32(+(process.argv[3] || 1));
const pick = a => a[Math.floor(rnd() * a.length)];

function add(why, detail) { fails.push({ why, ...detail }); }

// ===== 1) SSRF — 차단 대상으로 외부 요청이 한 번이라도 나가면 실패 =====
// 합격선은 "나간 곳이 사설인가"가 아니라 **egress === 0**(아예 안 나감)이다.
// 처음엔 나간 URL을 isPrivateTarget()으로 다시 판정해서 셌는데, 그러면 정규화 뒤
// 판정기가 못 알아보는 형태가 '차단'으로 잘못 집계된다(`[::ffff:127.0.0.1]` →
// `[::ffff:7f00:1]` 이 그렇게 통과했다). SSRF_HOSTS 는 전부 '가면 안 되는 곳'이므로
// 요청이 나갔다는 사실 자체가 실패다. isPrivateTarget 은 보고용 참고값으로만 남긴다.
//
// URL 파서가 호스트를 어떻게 정규화하는지도 같이 기록한다.
// (예: http://2130706433/ 은 WHATWG URL 파서가 127.0.0.1 로 바꿔주므로 점4자리 검사에 걸린다)
const ssrfTable = [];
for (const [host, what] of SSRF_HOSTS) {
  for (const scheme of ['http', 'https']) {
    const target = `${scheme}://${host}/latest/meta-data/`;
    fetchLog = [];
    responder = () => new Response('<html>$1.00</html>', { headers: { 'content-type': 'text/html' } });
    let res;
    try {
      res = await worker.fetch(new Request('https://w.dev/?url=' + encodeURIComponent(target),
        { headers: { Origin: 'https://altair0622.github.io' } }), {}, ctx);
    } catch (e) { add('예외 발생', { host, what, msg: e.message }); continue; }
    stats.n++;
    let norm = '?'; try { norm = new URL(target).hostname; } catch {}
    const wentOut = fetchLog.length > 0;
    if (scheme === 'http') ssrfTable.push({ 입력: host, 정규화: norm, 판정: wentOut ? '유출' : '차단' });
    if (wentOut) {
      add('SSRF — 차단 대상으로 요청이 나갔다',
          { host, 정규화: norm, what, 나간요청: fetchLog[0], 사설로도판정됨: isPrivateTarget(fetchLog[0]) });
    } else stats.blocked++;
  }
}

// ===== 2) 리다이렉트 — 홉마다 호스트가 재검사되는가 =====
// 예전에는 fetch 옵션이 redirect:'follow' 인지만 봤다. 워커가 홉을 직접 추적하는
// 방식(redirect:'manual')으로 바뀐 뒤엔 그 검사가 아무것도 보증하지 않으므로,
// 실제 302 를 먹여서 "가면 안 되는 곳은 안 가고, 가야 하는 곳은 간다"를 본다.
const redirTable = [];
// ⚠️ 케이스마다 최초 URL을 다르게 준다 — 워커는 성공 결과를 30분 캐시하므로,
//    같은 URL로 돌리면 두 번째 케이스부터 캐시 히트로 fetch 가 아예 안 나가고
//    "리다이렉트를 안 따라갔다"는 가짜 실패가 난다.
let rcase = 0;
for (const [label, next, shouldReach] of [
  ['공개 → 메타데이터', 'http://169.254.169.254/meta', false],
  ['공개 → 루프백', 'http://127.0.0.1/x', false],
  ['공개 → 사설망', 'http://10.0.0.5/x', false],
  ['공개 → 공개', 'https://www.pub.example.com/a', true],
  ['http → https', 'https://pub.example.com/a', true],
  ['상대경로 Location', '/b', true],
]) {
  fetchLog = [];
  responder = () => fetchLog.length === 1
    ? new Response('', { status: 302, headers: { Location: next } })
    : new Response('<html>$42.00</html>', { headers: { 'content-type': 'text/html' } });
  const start = 'http://pub.example.com/a?case=' + (++rcase);
  const res = await worker.fetch(
    new Request('https://w.dev/?url=' + encodeURIComponent(start)), {}, ctx);
  const j = await res.json();
  const reached = fetchLog.length >= 2;
  redirTable.push({ 케이스: label, 홉수: fetchLog.length, 가격: j.price ?? null, error: (j.error || '').slice(0, 40) });
  if (reached !== shouldReach) {
    add(shouldReach ? '따라가야 하는 리다이렉트를 안 따라갔다' : '차단해야 하는 리다이렉트를 따라갔다',
        { 케이스: label, 홉: fetchLog.slice(0, 3) });
  }
}
// 무한 루프에서 멈추는가
{
  fetchLog = [];
  responder = () => new Response('', { status: 302, headers: { Location: 'http://loop.example.com/' + fetchLog.length } });
  const t0 = performance.now();
  await worker.fetch(new Request('https://w.dev/?url=' + encodeURIComponent('http://loop.example.com/0')), {}, ctx);
  const dt = performance.now() - t0;
  redirTable.push({ 케이스: '무한 루프', 홉수: fetchLog.length, 가격: null, error: dt.toFixed(0) + 'ms' });
  if (fetchLog.length > 8) add('리다이렉트 홉 상한이 안 걸린다', { 홉수: fetchLog.length });
}

// ===== 3) 이상한 URL·스킴·메서드·오리진 랜덤 조합 =====
const WEIRD_URLS = [
  '', ' ', 'not a url', 'file:///C:/Windows/win.ini', 'ftp://x.com/a', 'gopher://x.com/',
  'data:text/html,<h1>x</h1>', 'javascript:alert(1)', 'http://', 'http://:80',
  'http://user:pw@evil.com@127.0.0.1/', 'https://xn--80ak6aa92e.com/', 'https://example.com/' + 'a'.repeat(5000),
  'https://example.com/?x=' + encodeURIComponent('<script>'), 'HTTP://EXAMPLE.COM/', 'https://example.com:99999/',
  'https://example.com/\u0000', 'https://example.com/#\n\rHost: evil',
];
for (let i = 0; i < 600; i++) {
  const method = pick(METHODS);
  const origin = pick(ORIGINS);
  const useWeird = rnd() < 0.45;
  const target = useWeird ? pick(WEIRD_URLS) : 'https://shop.example.com/p/' + Math.floor(rnd() * 1e6);
  const [label, body, ct] = pick(BODIES);
  fetchLog = [];
  responder = () => new Response(body, { headers: ct ? { 'content-type': ct } : {} });
  const url = 'https://w.dev/' + (rnd() < 0.05 ? '' : '?url=' + encodeURIComponent(target));

  let res, t0 = performance.now(), dt;
  try {
    res = await worker.fetch(new Request(url, { method, headers: origin ? { Origin: origin } : {} }), {}, ctx);
  } catch (e) { add('예외 발생', { method, target: target.slice(0, 80), body: label, msg: e.message }); continue; }
  dt = performance.now() - t0;
  stats.n++;
  if (dt > stats.slowest) { stats.slowest = dt; stats.slowCase = label + ' / ' + target.slice(0, 40); }

  // 불변식 1: Response 여야 한다
  if (!(res instanceof Response)) { add('Response 가 아님', { method, target: target.slice(0, 60) }); continue; }
  // 불변식 6: GET 아니면 405 + fetch 안 나감
  if (method !== 'GET' && method !== 'OPTIONS') {
    if (res.status !== 405) add('GET 아닌 메서드가 405가 아님', { method, status: res.status });
    if (fetchLog.length) add('GET 아닌 메서드인데 외부 요청이 나갔다', { method });
    continue;
  }
  if (method === 'OPTIONS') { if (res.status !== 204) add('OPTIONS 가 204가 아님', { status: res.status }); continue; }

  // 불변식 3: CORS 반사 금지
  const ao = res.headers.get('Access-Control-Allow-Origin');
  if (!ORIGINS.slice(0, 3).includes(ao)) add('CORS Allow-Origin 이 허용 목록 밖', { origin, allowOrigin: ao });

  // 불변식 4: JSON 파싱 가능 + price 형태
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { add('JSON 이 아님', { target: target.slice(0, 60), head: text.slice(0, 80) }); continue; }
  if (!('error' in j)) {
    if (!(j.price === null || (typeof j.price === 'number' && isFinite(j.price) && j.price > 0))) {
      add('price 가 null 도 유한 양수도 아님', { price: j.price, body: label, target: target.slice(0, 60) });
    }
    if (j.price) stats.priceFound++;
  } else stats.errors++;
  if (j.cached) stats.cached++;
  if (fetchLog.length) stats.fetched++;

  // 불변식 5: 원본 HTML 유출 금지
  if (body.length > 20 && text.includes(body.slice(0, 20)) && !label.startsWith('JSON')) {
    add('원본 HTML 이 응답에 그대로 들어갔다 (오픈 프록시)', { body: label });
  }
}

// ===== 4) 파싱 정확도 — 알려진 정답이 있는 케이스 =====
const PARSE_CASES = [
  ['JSON-LD 우선', '<html>$1.00<script type="application/ld+json">{"offers":{"price":"49.99"}}</script></html>', 49.99],
  ['자리표시자 0 건너뛰기', '<html>$0.00 <span>$34.99</span></html>', 34.99],
  ['JSON 키가 본문보다 우선', '<html>$29.00 ... "priceAmount":249.00</html>', 249],
  ['천단위 콤마', '<html>$1,299.00</html>', 1299],
  ['og:price', '<html><meta property="og:price:amount" content="129.00"></html>', 129],
  ['lowPrice 폴백', '<html><script type="application/ld+json">{"offers":[{"lowPrice":"77.50"}]}</script></html>', 77.5],
  ['가격 없음 → null', '<html><title>x</title></html>', null],
  // 음수 가격은 잡지 않는 게 맞다(정규식이 '-' 앞에서 안 붙음) → null 이 정답
  ['음수 가격 → null', '<html><meta property="og:price:amount" content="-50.00"></html>', null],
];
const parseResults = [];
for (const [label, body, expect] of PARSE_CASES) {
  fetchLog = [];
  responder = () => new Response(body, { headers: { 'content-type': 'text/html' } });
  const res = await worker.fetch(new Request('https://w.dev/?url=' + encodeURIComponent('https://shop.example.com/x' + label)), {}, ctx);
  const j = await res.json();
  const ok = (expect === null) ? (j.price === null) : Math.abs((j.price || 0) - expect) < 0.005;
  parseResults.push({ 케이스: label, 기대: expect, 실제: j.price, 신뢰도: j.confidence, ok });
}

// ===== 5) /rate — 온디맨드 요율 조회 =====
//
// `/?url=` 은 "임의의 호스트를 받아서 나쁜 곳을 거른다"지만 `/rate` 는 반대다 —
// 목적지가 두 도메인으로 고정이므로, 합격선은 "사설망을 막았나"가 아니라
// **나간 요청이 전부 못 박힌 두 형태 중 하나인가**이다. 이게 이 절의 1번 불변식이다.
// 1a) 워커가 **처음 만드는 URL**은 이 두 형태여야 한다 (슬러그로 경로를 못 벗어난다)
const PINNED = [
  /^https:\/\/www\.rakuten\.com\/shop\/[a-z0-9-]{1,60}$/,
  /^https:\/\/www\.topcashback\.com\/[a-z0-9-]{1,60}\/$/,
];
// 1b) 리다이렉트를 따라간 뒤에도 **호스트는 이 집합을 벗어나면 안 된다** (경로는 포털이 정한다)
const PINNED_HOSTS = new Set(['www.rakuten.com', 'rakuten.com', 'www.topcashback.com', 'topcashback.com']);
const offPortalHost = u => { try { return !PINNED_HOSTS.has(new URL(u).hostname.toLowerCase()) || new URL(u).protocol !== 'https:'; } catch { return true; } };
const rstats = { n: 0, accepted: 0, rejected: 0, egress: 0 };

// P-1 근거 검사: /rate 처리 중 console.* 이 한 번이라도 불리면 실패.
// (로그를 남기지 않는다는 약속을 문서가 아니라 실행으로 확인한다)
const consoleCalls = [];
function withConsoleSpy(fn) {
  const real = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    real[k] = console[k];
    console[k] = (...a) => consoleCalls.push(k + ': ' + a.map(String).join(' ').slice(0, 120));
  }
  return fn().finally(() => { for (const k of Object.keys(real)) console[k] = real[k]; });
}

// 포털별 응답을 골라주는 responder
function portalResponder(rkBody, tcbBody, opt = {}) {
  return (u) => {
    const isRk = /rakuten\.com/.test(u);
    const body = isRk ? rkBody : tcbBody;
    const st = (isRk ? opt.rkStatus : opt.tcbStatus) || 200;
    const loc = isRk ? opt.rkLocation : opt.tcbLocation;
    if (loc) return new Response('', { status: st === 200 ? 302 : st, headers: { Location: loc } });
    return new Response(body, { status: st, headers: { 'content-type': 'text/html' } });
  };
}
async function callRate(store, opts = {}) {
  fetchLog = [];
  responder = opts.responder || portalResponder('<html><title>x</title></html>', '<html>x</html>');
  const q = store === null ? '' : '?store=' + encodeURIComponent(store);
  const req = new Request('https://w.dev/rate' + q,
    { method: opts.method || 'GET', headers: opts.origin ? { Origin: opts.origin } : {} });
  const res = await withConsoleSpy(() => worker.fetch(req, {}, ctx));
  return { res, sent: fetchLog.slice() };
}

// --- 5a) 적대적 슬러그: 경로를 벗어날 수 있는가 ---
const EVIL_SLUGS = [
  '', ' ', '.', '..', '../..', '../../etc/passwd', 'a/../../b', 'nike/../../admin',
  'shop/nike', 'shop%2fnike', '%2e%2e%2f%2e%2e%2f', '..%2f..%2fadmin',
  'nike?x=1', 'nike#frag', 'nike&y=2', 'nike=1',
  '@evil.com', 'evil.com', 'nike.evil.com', 'x.evil.com', 'nike@evil.com',
  '//evil.com', '\\\\evil.com', '\\evil.com', 'http://evil.com', 'https://evil.com/',
  'https://169.254.169.254/', '169.254.169.254', '127.0.0.1', 'localhost', '[::1]',
  'metadata.google.internal', '2130706433', '0x7f000001',
  'nike:8080', 'nike\n', 'nike\r\nHost: evil', 'nike ', 'nike%00',
  'ni ke', 'nike_us', 'nike.us', 'nike+us', "nike'", 'nike"', 'nike<script>',
  '한글', 'nıke', 'NIKE', ' nike ', '-nike', 'nike-', '-', '--', '_',
  'a'.repeat(61), 'a'.repeat(200), 'a'.repeat(5000),
  // 정상 통과해야 하는 것들
  'nike', 'dsw-us', 'best-buy', 'cb2', 'x', '1800flowers',
];
const rateSlugTable = [];
for (const s of EVIL_SLUGS) {
  let out;
  try { out = await callRate(s); }
  catch (e) { add('/rate 예외 발생', { store: s.slice(0, 40), msg: e.message }); continue; }
  rstats.n++;
  const { res, sent } = out;
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); }
  catch { add('/rate 응답이 JSON 이 아님', { store: s.slice(0, 40), head: text.slice(0, 80) }); continue; }

  // 불변식 1 — 나간 요청은 전부 못 박힌 두 형태 중 하나
  for (const u of sent) {
    if (!PINNED.some(re => re.test(u))) {
      add('/rate 가 못 박힌 포털 URL 밖으로 요청을 보냈다', { store: s.slice(0, 60), 나간요청: u });
    }
    // 불변식 1-b — 경로에 박힌 슬러그는 입력에서 온 것이어야 한다(변환으로 새로 생기면 안 됨)
    const seg = u.replace(/^https:\/\/[^/]+\/(?:shop\/)?/, '').replace(/\/$/, '');
    if (!s.toLowerCase().includes(seg)) {
      add('/rate 가 입력에 없는 슬러그로 요청했다', { store: s.slice(0, 60), 슬러그: seg });
    }
  }
  // 불변식 2 — 거부(400)했으면 외부 요청이 0건이어야 한다
  if (res.status === 400 && sent.length) {
    add('/rate 가 거부하고도 외부 요청을 보냈다', { store: s.slice(0, 60), 나간요청: sent[0] });
  }
  // 불변식 3 — 받아들였으면 정확히 포털 2곳. 단 캐시 히트면 0곳이 맞다
  //   (EVIL_SLUGS 에는 'nike' / 'NIKE' / ' nike ' 처럼 같은 슬러그로 정규화되는 입력이 일부러 들어 있다.
  //    두 번째부터 0곳이 되는 것 자체가 정규화가 일관됐다는 증거이므로 실패로 세지 않는다.)
  if (res.status === 200 && !(sent.length === 2 || (sent.length === 0 && j.cached === true))) {
    add('/rate 가 포털 2곳이 아닌 횟수로 요청했다', { store: s.slice(0, 60), 횟수: sent.length, cached: !!j.cached });
  }
  // 불변식 4 — CORS 반사 금지
  const ao = res.headers.get('Access-Control-Allow-Origin');
  if (!ORIGINS.slice(0, 3).includes(ao)) add('/rate CORS Allow-Origin 이 허용 목록 밖', { allowOrigin: ao });

  if (res.status === 200) rstats.accepted++; else rstats.rejected++;
  rstats.egress += sent.length;
  rateSlugTable.push({ 입력: s.length > 24 ? s.slice(0, 21) + '…' : (s || '(빈값)'), 상태: res.status, 나간요청: sent.length });
}
// 불변식 5 — /rate 처리 중 로그를 남기지 않는다 (프라이버시 조건 1)
if (consoleCalls.length) add('/rate 처리 중 console 로그가 남았다 (프라이버시 조건 1 위반)', { 건수: consoleCalls.length, 예: consoleCalls[0] });

// --- 5b) 리다이렉트: 포털 도메인 밖으로 나가는가 ---
const rateRedirTable = [];
for (const [label, loc, shouldFollow] of [
  ['rakuten → 자기 도메인', 'https://www.rakuten.com/shop/x2', true],
  ['rakuten → www 없는 자기 도메인', 'https://rakuten.com/shop/x2', true],
  ['rakuten → 외부 도메인', 'https://evil.example.com/x', false],
  ['rakuten → 메타데이터', 'http://169.254.169.254/latest/', false],
  ['rakuten → 루프백', 'http://127.0.0.1/x', false],
  ['rakuten → http 강등', 'http://www.rakuten.com/shop/x2', false],
  ['rakuten → 상대경로', '/shop/x3', true],
  ['rakuten → 유사 도메인', 'https://www.rakuten.com.evil.com/x', false],
]) {
  let hops = 0;
  const { res, sent } = await callRate('redir' + (rateRedirTable.length + 1), {
    responder: (u) => {
      if (!/rakuten\.com/.test(u)) return new Response('<html>x</html>', { headers: { 'content-type': 'text/html' } });
      hops++;
      return hops === 1
        ? new Response('', { status: 302, headers: { Location: loc } })
        : new Response('<html><title>Foo & 5% Cash Back | Rakuten</title></html>', { headers: { 'content-type': 'text/html' } });
    },
  });
  const j = await res.json();
  const followed = sent.filter(u => /rakuten/.test(u)).length >= 2;
  // 리다이렉트를 따라간 뒤 경로는 포털이 정하므로 PINNED(형태)가 아니라 호스트 집합으로 본다.
  const off = sent.filter(offPortalHost);
  rateRedirTable.push({ 케이스: label, 홉수: sent.length, rk상태: j.rk && j.rk.status, 밖으로: off.length > 0 });
  if (off.length) add('/rate 리다이렉트가 포털 밖으로 나갔다', { 케이스: label, 나간요청: off[0] });
  // 첫 요청은 언제나 못 박힌 형태여야 한다
  if (sent.length && !PINNED.some(re => re.test(sent[0]))) {
    add('/rate 첫 요청이 못 박힌 형태가 아니다', { 케이스: label, 나간요청: sent[0] });
  }
  if (followed !== shouldFollow) {
    add(shouldFollow ? '/rate 가 따라가야 할 리다이렉트를 안 따라갔다' : '/rate 가 차단해야 할 리다이렉트를 따라갔다',
        { 케이스: label, 홉: sent.slice(0, 3) });
  }
  // 리다이렉트를 막았으면 결과는 '모름'이어야 한다 — 0% 로 뭉개면 안 된다
  if (!shouldFollow && j.rk && j.rk.pct === 0) add('/rate 가 차단된 리다이렉트를 0% 로 뭉갰다', { 케이스: label });
}

// --- 5c) 파싱 골든 — 행 단위로 못 박는다 ---
// 개수만 세는 검사로는 "못 찾음"과 "0%"의 혼동을 못 잡는다. 그게 이 엔드포인트 최악의
// 실패 모드(조용히 0% 를 돌려주면 계산기가 그 판매처를 잘못 깎는다)라서 값을 직접 고정한다.
const RK_TITLE = t => `<html><head><title>${t}</title></head><body></body></html>`;
const RATE_CASES = [
  // [라벨, rk 본문, tcb 본문, 기대 rk, 기대 tcb]
  ['Rakuten 기본 %', RK_TITLE('Nike Coupons, Promo Codes &amp; 8% Cash Back - August 2026 | Rakuten'), '',
    { pct: 8, listed: true, status: 'found' }, null],
  ['Rakuten Up to', RK_TITLE('Best Buy Coupons &amp; Up to 7% Cash Back | Rakuten'), '',
    { pct: 7, listed: true, status: 'found', upTo: true }, null],
  ['Rakuten 소수점', RK_TITLE('Foo &amp; 2.5% Cash Back | Rakuten'), '',
    { pct: 2.5, listed: true, status: 'found' }, null],
  ['Rakuten $ 고정', RK_TITLE('Amazon &amp; $5 Cash Back | Rakuten'), '',
    { pct: null, flat: 5, listed: true, status: 'found' }, null],
  ['Rakuten No Cash Back = 진짜 0%', RK_TITLE('Foo Coupons &amp; No Cash Back | Rakuten'), '',
    { pct: 0, listed: true, status: 'listed-zero' }, null],
  ['Rakuten Coupons Only = 진짜 0%', RK_TITLE('Foo Coupons &amp; Coupons Only | Rakuten'), '',
    { pct: 0, listed: true, status: 'listed-zero' }, null],
  ['Rakuten 홈 리다이렉트 = 페이지 없음', RK_TITLE('Rakuten: Shop. Get Cash Back. Save Money.'), '',
    { pct: null, listed: false, status: 'no-page' }, null],
  ['Rakuten 요율 없는 타이틀 = 모름(0% 아님)', RK_TITLE('Some Store | Rakuten'), '',
    { pct: null, listed: null, status: 'lookup-failed' }, null],
  ['Rakuten 타이틀 없음 = 모름', '<html><body>nothing</body></html>', '',
    { pct: null, listed: null, status: 'lookup-failed' }, null],
  ['TCB 기본 %', '', '<html><span class="merch-offer__rate">10% Cash Back</span></html>',
    null, { pct: 10, listed: true, status: 'found' }],
  ['TCB Up to', '', '<html><div class="merch-offer__rate x">Up to 8% Cash Back</div></html>',
    null, { pct: 8, listed: true, status: 'found', upTo: true }],
  ['TCB 쿠폰만 = 진짜 0%', '', '<html><h1>Nike Cash Back Offers</h1></html>',
    null, { pct: 0, listed: true, status: 'listed-zero' }],
  ['TCB 페이지 없음', '', '<html><h1>Page not found</h1></html>',
    null, { pct: null, listed: false, status: 'no-page' }],
  ['TCB 빈 페이지 = 모름(0% 아님)', '', '<html><body></body></html>',
    null, { pct: null, listed: null, status: 'lookup-failed' }],
  // 봇 차단은 "못 읽음"과 구분해서 말해야 한다 — 상태가 같으므로 사유 문구까지 못 박는다
  ['TCB 봇차단 = 모름 + 차단이라고 말함', '', '<html><h1>Robot or human?</h1></html>',
    null, { pct: null, listed: null, status: 'lookup-failed', errorHas: '봇 차단' }],
  ['Rakuten 봇차단 = 모름 + 차단이라고 말함', '<html>Please verify you are a human</html>', '',
    { pct: null, listed: null, status: 'lookup-failed', errorHas: '봇 차단' }, null],
  ['Rakuten 404 = 페이지 없음', '', '',
    { pct: null, listed: false, status: 'no-page' }, null, { rkStatus: 404 }],
  ['TCB 404 = 페이지 없음', '', '',
    null, { pct: null, listed: false, status: 'no-page' }, { tcbStatus: 404 }],
  ['포털 500 = 모름(0% 아님)', '', '',
    { pct: null, listed: null, status: 'lookup-failed' }, { pct: null, listed: null, status: 'lookup-failed' },
    { rkStatus: 500, tcbStatus: 503 }],
];
const rateParseTable = [];
let gi = 0;
for (const [label, rkBody, tcbBody, wantRk, wantTcb, opt] of RATE_CASES) {
  const { res, sent } = await callRate('golden' + (++gi), {
    responder: portalResponder(rkBody || '<html><title>x</title></html>', tcbBody || '<html>x</html>', opt || {}),
  });
  const j = await res.json();
  const rows = [];
  for (const [key, want] of [['rk', wantRk], ['tcb', wantTcb]]) {
    if (!want) continue;
    const got = j[key] || {};
    for (const f of ['pct', 'listed', 'status', 'upTo', 'flat']) {
      const w = f in want ? want[f] : undefined;
      const g = f in got ? got[f] : undefined;
      if (JSON.stringify(w) !== JSON.stringify(g)) {
        add('/rate 파싱 골든 불일치', { 케이스: label, 포털: key, 필드: f, 기대: w, 실제: g });
        rows.push(`${f}: ${JSON.stringify(g)}≠${JSON.stringify(w)}`);
      }
    }
    if (want.errorHas && !String(got.error || '').includes(want.errorHas)) {
      add('/rate 실패 사유가 틀리다 (차단과 못 읽음을 구분 못 함)', { 케이스: label, 포털: key, 기대포함: want.errorHas, 실제: got.error });
      rows.push(`error: "${got.error}" ⊅ "${want.errorHas}"`);
    }
  }
  // 불변식 6 — 원본 HTML 유출 금지
  const raw = (rkBody || tcbBody);
  const text = JSON.stringify(j);
  if (raw.length > 20 && text.includes(raw.slice(0, 20))) add('/rate 응답에 원본 HTML 이 들어갔다', { 케이스: label });
  rateParseTable.push({ 케이스: label, rk: j.rk && j.rk.status, tcb: j.tcb && j.tcb.status,
                        rk값: j.rk && (j.rk.flat != null ? '$' + j.rk.flat : j.rk.pct), tcb값: j.tcb && j.tcb.pct,
                        ok: rows.length === 0 ? 'ok' : rows.join(' / ') });
  rstats.n++;
}

// --- 5d) 캐시가 사용자 단위가 아니라 매장 단위인가 (프라이버시 조건 3) ---
// 오리진이 달라도 같은 매장이면 같은 캐시 항목을 써야 한다. 오리진·IP가 키에 섞이면
// 그건 사용자 단위 캐시고, 조건 3 위반이다.
const cacheTable = [];
{
  const body = portalResponder(RK_TITLE('Foo &amp; 9% Cash Back | Rakuten'), '<html><span class="merch-offer__rate">3% Cash Back</span></html>');
  const a = await callRate('cachetest', { responder: body, origin: 'https://altair0622.github.io' });
  const ja = await a.res.json();
  const b = await callRate('cachetest', { responder: body, origin: 'http://localhost:8080' });
  const jb = await b.res.json();
  const c = await callRate('cachetest2', { responder: body, origin: 'https://altair0622.github.io' });
  const jc = await c.res.json();
  cacheTable.push({ 케이스: '1차(오리진 A)', cached: !!ja.cached, 외부요청: a.sent.length });
  cacheTable.push({ 케이스: '2차(오리진 B·같은 매장)', cached: !!jb.cached, 외부요청: b.sent.length });
  // 대소문자만 다른 입력이 같은 캐시 항목을 써야 한다. 안 그러면 키가 쪼개져서
  // 매장 단위 공용 캐시라는 전제(조건 3)가 흐려지고, 포털로 나가는 요청도 그만큼 늘어난다.
  const d = await callRate('CACHETEST', { responder: body, origin: 'https://altair0622.github.io' });
  const jd = await d.res.json();
  cacheTable.push({ 케이스: '3차(오리진 A·다른 매장)', cached: !!jc.cached, 외부요청: c.sent.length });
  cacheTable.push({ 케이스: '4차(대문자 같은 매장)', cached: !!jd.cached, 외부요청: d.sent.length, status: d.res.status });
  if (d.res.status !== 200 || !jd.cached || d.sent.length !== 0) {
    add('/rate 가 대소문자만 다른 같은 매장을 다른 항목으로 취급했다', { status: d.res.status, cached: !!jd.cached, 외부요청: d.sent.length });
  }
  if (ja.cached) add('/rate 1차 조회가 캐시 히트로 나왔다 (하니스 상태 오염)', {});
  if (!jb.cached || b.sent.length !== 0) {
    add('/rate 캐시가 매장 단위 공용이 아니다 — 오리진이 다르면 새로 조회한다 (프라이버시 조건 3 위반)',
        { cached: !!jb.cached, 외부요청: b.sent.length });
  }
  if (jc.cached) add('/rate 가 다른 매장인데 캐시를 재사용했다', {});
  if (jb.rk && ja.rk && jb.rk.pct !== ja.rk.pct) add('/rate 캐시가 다른 값을 돌려줬다', { 1: ja.rk.pct, 2: jb.rk.pct });
  rstats.n += 4;
}

// --- 5e) 메서드·경로 ---
{
  const p = await callRate('nike', { method: 'POST' });
  if (p.res.status !== 405) add('/rate 가 POST 를 405 로 막지 않았다', { status: p.res.status });
  if (p.sent.length) add('/rate 가 POST 인데 외부 요청을 보냈다', {});
  const noParam = await callRate(null);
  if (noParam.res.status !== 400) add('/rate 가 store 없이도 400 이 아니다', { status: noParam.res.status });
  if (noParam.sent.length) add('/rate 가 store 없이 외부 요청을 보냈다', {});
  rstats.n += 2;
}

console.log(JSON.stringify({
  검사수: stats.n,
  실패: fails.length,
  SSRF검사: { 시도: SSRF_HOSTS.length * 2, 차단됨: stats.blocked, 표: ssrfTable },
  리다이렉트: redirTable,
  통계: { 외부요청나감: stats.fetched, 가격찾음: stats.priceFound, 에러응답: stats.errors, 캐시히트: stats.cached,
          최장처리ms: +stats.slowest.toFixed(1), 최장케이스: stats.slowCase },
  파싱: parseResults,
  rate검사수: rstats.n,
  rate: {
    슬러그: { 시도: EVIL_SLUGS.length, 수락: rstats.accepted, 거부: rstats.rejected, 나간요청: rstats.egress, 표: rateSlugTable },
    리다이렉트: rateRedirTable,
    파싱골든: rateParseTable,
    캐시: cacheTable,
    로그남김: consoleCalls.length,
  },
  실패목록: fails,
}, null, 1));
