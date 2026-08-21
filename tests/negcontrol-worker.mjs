/* 워커 하니스 음성 대조군 (v0.29)
 *
 * 규칙: **검사를 추가하면 대상 코드를 일부러 망가뜨려 그 검사가 실제로 실패하는지 확인한다.**
 * 확인 없는 "0건 실패"는 아무 의미가 없다 (tests/README.md).
 *
 * 하는 일: worker/index.js 에 변형을 하나씩 먹인 사본을 만들어 fuzz-worker.mjs 를 돌리고,
 * 그때 실패가 몇 건 나는지 센다. 0 이면 그 검사는 헛돌고 있는 것이다.
 *
 *   node site/tests/negcontrol-worker.mjs site/worker/index.js 42
 *
 * ⚠️ `소스변경` 이 false 인데 실패가 0 이면 그건 통과가 아니라 **변형이 안 먹은 것**이다
 *    (워커 코드의 문자열이 바뀌면 아래 `from` 도 같이 고쳐야 한다).
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SRC = process.argv[2] || 'site/worker/index.js';
const SEED = process.argv[3] || '42';
const HARNESS = join(dirname(fileURLToPath(import.meta.url)), 'fuzz-worker.mjs');
const original = readFileSync(SRC, 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'wneg-'));

const MUTANTS = [
  ['대조군(정상)', null, null],

  ['슬러그 검증을 통째로 끔 (경로 탈출 가능)',
    'const RATE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;',
    'const RATE_SLUG = /^[\\s\\S]+$/;'],

  ['슬러그에 점·슬래시 허용 (다른 호스트·경로로 셀 수 있음)',
    'const RATE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;',
    'const RATE_SLUG = /^[a-z0-9][a-z0-9./:@-]*$/;'],

  ['리다이렉트 호스트 고정 제거 (포털이 아무 데나 보내도 따라감)',
    'return p.protocol === \'https:\' && portal.hosts.includes(p.hostname.toLowerCase());',
    'return true;'],

  ['조회 실패를 0% 로 뭉갬 ("못 찾음"과 "0%"를 같게 만듦)',
    "const rateFailed = why => ({ pct: null, listed: null, status: 'lookup-failed', error: why });",
    "const rateFailed = why => ({ pct: 0, listed: true, status: 'listed-zero', error: why });"],

  ['Rakuten 홈 리다이렉트를 상점으로 착각 (없는 상점을 있다고 함)',
    "if (/^Rakuten\\s*:/i.test(title)) return { pct: null, listed: false, status: 'no-page' };",
    ''],

  // ⚠️ `from` 은 **한 줄**로 쓸 것. worker/index.js 는 CRLF 라 '\n' 을 넣은 여러 줄 문자열은
  //    매치되지 않는다(그러면 소스변경=false 로 잡힌다 — 조용히 통과하지는 않는다).
  //    이 문자열은 파일에 두 번 나오고 String.replace 는 **첫 번째**만 바꾼다 = Rakuten 쪽.
  ['Up to 표시를 버림 (Rakuten ≤7% 를 확정 7% 로 보고)',
    'if (r[1]) o.upTo = true;',
    ''],

  ['봇 차단 페이지를 그냥 파싱 (차단을 조회 실패와 구분 못 함)',
    "if (isChallengePage(html)) return rateFailed('봇 차단 페이지를 받았어');",
    ''],

  ['404 를 페이지 없음으로 안 봄',
    "if (res.status === 404) return { pct: null, listed: false, status: 'no-page' };",
    ''],

  ['캐시 키를 매장 단위가 아니게 만듦 (사용자마다 다른 키 = 조건 3 위반)',
    "const cacheKey = new Request('https://rate-proxy.internal/rate/' + store);",
    "const cacheKey = new Request('https://rate-proxy.internal/rate/' + store + '/' + Math.random());"],

  ['조회한 매장 이름을 로그로 남김 (프라이버시 조건 1 위반)',
    'const results = await Promise.all(RATE_PORTALS.map(p => lookupRate(p, store)));',
    "console.log('rate lookup', store);\n  const results = await Promise.all(RATE_PORTALS.map(p => lookupRate(p, store)));"],

  ['store 를 안 다듬고 그대로 씀 (공백·대문자가 그대로 URL 로)',
    "const store = String(rawStore == null ? '' : rawStore).trim().toLowerCase();",
    "const store = String(rawStore == null ? '' : rawStore);"],

  ['/rate 라우팅을 지움 (엔드포인트가 사라짐)',
    "if (path === '/rate') {",
    'if (false) {'],

  // ===== /vision (v0.31) =====
  // ★ 표시된 것들이 이 엔드포인트의 존재 이유다 — "지어낸 모델번호가 read 로 인쇄되는 것"을 막는 자리.
  ['★ auditGuessed 를 꺼버림 (검색어의 모델번호가 짐작인지 안 밝힘)',
    'guessed: auditGuessed(candidates, read, guessed),',
    'guessed,'],

  ['★ 후보 중복 제거를 끔 (같은 검색어를 3개인 척 보여줌)',
    'if (!k || seen.has(k)) continue;',
    'if (!k) continue;'],

  ['★ 후보 0개인데 되묻기를 안 함 (갈 곳 없는 화면)',
    "if (!candidates.length && reason === 'none') reason = 'none-recognized';",
    ''],

  ['★ 제공자가 죽었는데 검색어를 지어냄',
    "    return visionErr('provider-error', (e && e.message) || String(e), cors, 200);",
    "    return json({ ok: true, category: '', candidates: [{ query: 'nike air max 90', why: 'x' }], read: [], guessed: [], ask: null }, 200, cors);"],

  // ★ 2026-08-14~20 실제로 6일간 조용히 깨져 있던 자리. 커스텀 도메인을 붙였는데
  //   ALLOW_ORIGINS 가 안 따라와서 브라우저가 워커 응답을 통째로 버렸다.
  ['★ 운영 도메인(priceafter.com)을 CORS 허용목록에서 뺌 — 라이브가 조용히 죽는다',
    "  'https://priceafter.com',",
    ''],
  ['★ 운영 도메인 www 를 뺌',
    "  'https://www.priceafter.com',",
    ''],

  ['★ 망가진 키 가드를 끔 (Ctrl+V 로 들어간 제어문자가 그대로 제공자에 나감)',
    "  if (key.length < 20 || /[^\x21-\x7e]/.test(key)) {",
    '  if (false) {'],

  ['키가 없어도 제공자를 부름 (키 없이 과금 경로로 들어감)',
    '  if (!key) {',
    '  if (false) {'],

  ['Gemini 유료티어 확인을 건너뜀 (무료티어 = 사람이 사진을 읽음)',
    "  if (provider === 'gemini' && String(env.VISION_GEMINI_PAID_TIER || '') !== 'confirmed') {",
    '  if (false) {'],

  ['AI Gateway 로그 끄기 헤더를 뺌 (사진·인식결과가 게이트웨이 로그에 쌓임)',
    "const AI_GATEWAY_NO_LOG = { 'cf-aig-collect-log': 'false' };",
    'const AI_GATEWAY_NO_LOG = {};'],

  ['사진 장수 상한을 끔',
    '  if (images.length > VISION_MAX_IMAGES) {',
    '  if (false) {'],

  ['사진 크기 상한을 끔',
    "  if (total > VISION_MAX_B64) return visionErr('too-large', '사진이 너무 커 — 더 작게 줄여서 보내줘', cors, 413);",
    ''],

  ['base64 검증을 끔 (우리 클라이언트가 안 만든 것도 통과)',
    "    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(im)) return visionErr('bad-request', '사진이 base64 가 아니야', cors, 400);",
    ''],

  ['images:[] 를 통과시킴 (능력확인 계약이 깨짐 → 버튼이 잘못 켜진다)',
    "  if (!images.length) return visionErr('bad-request', 'images 가 비어 있어', cors, 400);",
    ''],

  ['보낸 사진을 로그로 남김 (프라이버시 조건 1 위반)',
    '  const lang = body && body.lang === \'en\' ? \'en\' : \'ko\';',
    '  console.log(\'vision\', images.length, images[0].slice(0, 20));\r\n  const lang = body && body.lang === \'en\' ? \'en\' : \'ko\';'],
];

const rows = [];
for (const [label, from, to] of MUTANTS) {
  let src = original, changed = false;
  if (from != null) {
    if (!original.includes(from)) {
      rows.push({ 망가뜨린것: label, 소스변경: false, 실패: 'N/A', 비고: '변형 문자열을 못 찾음 — 워커 코드가 바뀌었나?' });
      continue;
    }
    src = original.replace(from, to);
    changed = src !== original;
  }
  const f = join(dir, 'w' + rows.length + '.js');
  writeFileSync(f, src);
  let out;
  try {
    out = JSON.parse(execFileSync(process.execPath, [HARNESS, f, SEED], { encoding: 'utf8', maxBuffer: 64 << 20 }));
  } catch (e) {
    rows.push({ 망가뜨린것: label, 소스변경: changed, 실패: '실행오류', 비고: String(e.message).slice(0, 100) });
    continue;
  }
  const why = {};
  for (const x of out.실패목록) why[x.why] = (why[x.why] || 0) + 1;
  rows.push({
    망가뜨린것: label,
    소스변경: from == null ? '—' : changed,
    실패: out.실패,
    기존658유지: out.검사수 === 658,
    잡힌검사: Object.keys(why).map(k => `${k}×${why[k]}`).join(' | ').slice(0, 160) || '—',
  });
}
console.table(rows);
const control = rows[0];
const live = rows.slice(1).filter(r => typeof r.실패 === 'number' && r.실패 > 0).length;
console.log(`\n대조군 실패 ${control.실패} (0이어야 함) · 변형 ${rows.length - 1}개 중 ${live}개가 검사에 걸림`);
if (control.실패 !== 0 || live !== rows.length - 1) {
  console.log('⚠️ 걸리지 않은 변형이 있으면 그 검사는 헛돌고 있는 것이다.');
  process.exitCode = 1;
}
