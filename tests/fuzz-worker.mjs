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

console.log(JSON.stringify({
  검사수: stats.n,
  실패: fails.length,
  SSRF검사: { 시도: SSRF_HOSTS.length * 2, 차단됨: stats.blocked, 표: ssrfTable },
  리다이렉트: redirTable,
  통계: { 외부요청나감: stats.fetched, 가격찾음: stats.priceFound, 에러응답: stats.errors, 캐시히트: stats.cached,
          최장처리ms: +stats.slowest.toFixed(1), 최장케이스: stats.slowCase },
  파싱: parseResults,
  실패목록: fails,
}, null, 1));
