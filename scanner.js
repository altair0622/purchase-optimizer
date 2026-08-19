// PriceAfter — 매장 바코드 스캔 (MVP 1단계: 사진 한 장)
// ============================================================================
// 근거 문서: 리서치/바코드-매장스캔-조사.md 5장(MVP) · 8장(iOS) · 9장(UPC 변형)
// 구속 문서: 프라이버시-원칙.md H3·H4·H6·H7 / v0.26 "틀린 값은 없는 것보다 나쁘다"
//
// 흐름:  📷 버튼 → OS 카메라(사진 1장) → 이 파일이 브라우저 안에서 UPC 해독
//        → Amazon·Best Buy 검색 딥링크 → 사용자가 자기 눈으로 가격 확인
//        → 그 URL을 기존 붙여넣기 칸에 넣으면 v0.24 파이프라인이 나머지를 한다
//
// 이 파일이 하지 않는 것 (전부 의도된 것이고, 고치려 들기 전에 위 문서를 읽을 것):
//   · 가격을 만들지 않는다 — 우리가 아는 "지금 가격"은 없다(조사 3-A)
//   · 사진을 밖으로 보내지 않는다 — 해독은 전부 이 브라우저 안에서 끝난다
//   · 실시간 비디오 스캔을 하지 않는다 — 2단계이고, 착지점인 1단계부터 만든다(조사 5장)
//   · 못 읽으면 "못 읽었어요"로 끝낸다 — 흐릿한 추정을 만들지 않는다
// ============================================================================

// 이 파일은 index.html이 로드될 때 받아지지 않는다. 사용자가 📷 버튼을 누른
// 순간에만 같은 출처에서 지연 로딩된다(조사 8-D). 안 누른 사람에게는 0바이트.

const QUAGGA_URL = new URL('./vendor/quagga2.min.js', import.meta.url).href;

// 한국어 원문은 여기 있는 그것이 진실이다. index.html의 t()가 있으면 그걸 태우고
// (영어판 대비), 없으면 한국어를 그대로 쓴다.
const T = (key, ko) => {
  try { return (typeof t === 'function') ? t(key, ko) : ko; } catch (e) { return ko; }
};

// ============================================================================
// 1. 순수 로직 — 카메라도 DOM도 없이 검사할 수 있는 부분
//    (site/tests/fuzz-personas.js 의 __fuzz.runScan() 이 여기를 골든으로 못 박는다)
// ============================================================================

// GS1 mod-10 체크디지트. EAN-8·UPC-A(12)·EAN-13 전부 같은 규칙이다.
// body = 체크디지트를 뺀 앞자리 전부.
export function gs1CheckDigit(body) {
  if (!/^\d+$/.test(body)) return null;
  let sum = 0;
  // 오른쪽부터 3,1,3,1…
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48;
    sum += (i % 2 === 0) ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

export function hasValidCheckDigit(code) {
  if (!/^\d+$/.test(code) || code.length < 2) return false;
  const want = gs1CheckDigit(code.slice(0, -1));
  return want !== null && want === (code.charCodeAt(code.length - 1) - 48);
}

// UPC-E(8자리) → UPC-A(12자리) 복원.
// UPC-E는 UPC-A에서 0을 압축해 없앤 형태라, 마지막 자리가 "어디의 0을 지웠는지"를 말해준다.
// 실패하면 null — 억지로 만들어내지 않는다.
export function expandUpcE(code8) {
  if (!/^\d{8}$/.test(code8)) return null;
  const ns = code8[0];
  if (ns !== '0' && ns !== '1') return null;      // UPC-E는 넘버시스템 0·1만 존재한다
  const d = code8.slice(1, 7);                    // X1..X6
  const last = d[5];
  let body;                                       // 체크디지트를 뺀 11자리
  if (last === '0' || last === '1' || last === '2') {
    body = ns + d[0] + d[1] + last + '0000' + d[2] + d[3] + d[4];
  } else if (last === '3') {
    body = ns + d[0] + d[1] + d[2] + '00000' + d[3] + d[4];
  } else if (last === '4') {
    body = ns + d[0] + d[1] + d[2] + d[3] + '00000' + d[4];
  } else {
    body = ns + d[0] + d[1] + d[2] + d[3] + d[4] + '0000' + last;
  }
  const upcA = body + String(gs1CheckDigit(body));
  // UPC-E의 체크디지트는 정의상 복원한 UPC-A의 체크디지트와 같아야 한다.
  // 다르면 잘못 읽은 것이다 → 고쳐서 내보내지 않고 실패로 끝낸다.
  if (upcA[11] !== code8[7]) return null;
  return upcA;
}

// 해독기가 준 코드를 "검색에 쓸 하나의 형태"로 정리한다.
// EAN-13인데 0으로 시작하면 그건 UPC-A와 같은 번호다 → 미국 소매가 실제로 색인하는 12자리로.
export function toCanonical(code, format) {
  if (!/^\d+$/.test(code)) return null;
  if (format === 'upc_e') return expandUpcE(code);
  if (!hasValidCheckDigit(code)) return null;
  if (code.length === 13 && code[0] === '0') return code.slice(1);
  if (code.length === 12 || code.length === 13 || code.length === 8) return code;
  return null;
}

// 폴백 경로: 바코드 아래 숫자를 사람이 직접 친 것.
// ⚠️ 이건 폴백이지 진입 경로가 아니다 — 매장에서 12자리를 치는 사람은 없다(조사 5장).
// 8자리는 받지 않는다: EAN-8과 UPC-E가 길이로는 구분이 안 되고, 둘을 넘겨짚으면
// 엉뚱한 상품을 찾아주게 된다. 해독기에서 올 때는 어느 쪽인지 알려주므로 문제없다.
export function normalizeManualEntry(raw) {
  const s = String(raw == null ? '' : raw).replace(/[\s\-‐-―]/g, '');
  if (s === '') return { ok: false, reason: 'empty' };
  if (!/^\d+$/.test(s)) return { ok: false, reason: 'not-digits' };
  if (s.length !== 12 && s.length !== 13) return { ok: false, reason: 'bad-length', len: s.length };
  if (!hasValidCheckDigit(s)) return { ok: false, reason: 'bad-check' };
  return { ok: true, code: toCanonical(s, s.length === 13 ? 'ean_13' : 'upc_a') };
}

// ---------------------------------------------------------------------------
// 딥링크 — 실측으로 확인된 두 곳만 (조사 3-E)
// ---------------------------------------------------------------------------
// ⚠️ 여기에 판매처를 추가하지 마라. 조사에서 실제로 요청을 보내 확인한 결과:
//   · Walmart  — UPC 3개 전부 무결과. 대조군(상품명 검색)은 정상 통과했으므로
//                봇 차단이 아니라 "Walmart 검색이 UPC를 인식하지 않는 것"이다
//   · Target   — "1 result"라고 써놓고 매칭 상품을 안 그린다. 신뢰 불가
//   · eBay·Google — 자동화가 403/봇체크로 막혀 "안 된다"가 아니라 "모른다"
// 확인 안 된 곳을 넣으면 사용자에게 "없는 상품"으로 보인다.
// 이 링크에는 어필리에이트 태그가 없다 — H4(남의 추천 링크를 건드리지 않는다)와
// H5(추천 순위에 수익 요소 0%)를 지키는 자리다. 추적 파라미터를 붙이지 마라.
export const DEEP_LINK_STORES = [
  { id: 'amazon',  name: 'Amazon',   build: c => 'https://www.amazon.com/s?k=' + encodeURIComponent(c) },
  { id: 'bestbuy', name: 'Best Buy', build: c => 'https://www.bestbuy.com/site/searchpage.jsp?st=' + encodeURIComponent(c) },
];

// 하니스가 "이 목록이 조용히 늘어나지 않았는지"를 검사한다.
export const DEEP_LINK_BLOCKED = ['walmart', 'target', 'ebay', 'google'];

export function buildDeepLinks(code) {
  if (!/^\d{8}$|^\d{12}$|^\d{13}$/.test(String(code || ''))) return [];
  return DEEP_LINK_STORES.map(s => ({ id: s.id, name: s.name, url: s.build(code) }));
}

// ---------------------------------------------------------------------------
// 해독 재시도 — "여러 번 시도"와 "넘겨짚기"는 다르다
// ---------------------------------------------------------------------------
// 같은 사진을 해상도·패치 크기를 바꿔가며 다시 해독하는 것은 추정이 아니다.
// 어느 시도든 체크디지트를 통과해야 값으로 인정된다.
// 다만 시도마다 **다른 값**이 나오면 그건 확신할 수 없는 것이다 → 실패로 끝낸다.
// 아래 3단은 합성 바코드 6장면(정면 / 7° / 20° 기울임 / 작게 / 초점흐림 / 저조도노이즈)에
// × 12설정(size 800·1280·1600 × patch small·medium·large·x-large)을 전수로 돌려 고른 것이다.
// 관찰: 1280은 네 patch 모두 6/6 성공 · 1600은 20° 기울임에서 전멸 ·
//       바코드가 화면을 거의 채운 작은 이미지에서는 large 계열만 통했다.
// → 사진 기하(1280)를 앞에 두고, 그와 성질이 다른 800/large를 뒤에 둔다.
// ⚠️ 이건 합성 이미지 기준이다. 곡면 포장·비닐 반사·실제 센서 노이즈는 재지 못했다 —
//    진짜 판정은 tests/scan-field-test.html 의 실기 측정이다.
export const DECODE_ATTEMPTS = [
  { size: 1280, patchSize: 'medium', halfSample: false },
  { size: 1280, patchSize: 'small',  halfSample: false },
  { size: 800,  patchSize: 'large',  halfSample: false },
];

export async function decodeWithRetries(src, decodeOnce, attempts) {
  const list = attempts || DECODE_ATTEMPTS;
  const got = [];
  for (const opt of list) {
    let r = null;
    try { r = await decodeOnce(src, opt); } catch (e) { r = null; }
    if (r && r.code) {
      const canon = toCanonical(String(r.code), r.format);
      if (canon) got.push(canon);           // 체크디지트를 통과한 것만 센다
    }
    // 같은 값이 두 번 나왔으면 더 볼 것 없다
    if (got.length >= 2 && new Set(got).size === 1) break;
  }
  const distinct = Array.from(new Set(got));
  if (distinct.length === 0) return { ok: false, reason: 'no-barcode', tried: list.length };
  if (distinct.length > 1)   return { ok: false, reason: 'ambiguous', codes: distinct };
  return { ok: true, code: distinct[0], agreed: got.length };
}

// ---------------------------------------------------------------------------
// 실효 범위 — 한계를 먼저 말한다 (조사 9-C·9-D, 원칙 C2·C3)
// ---------------------------------------------------------------------------
// ⚠️ 문구는 초안이다. 카피 세션이 다듬는다. 다만 **판정(🟢🟡🔴)은 실측 근거가 있으므로
//    문구를 다듬을 때도 카테고리를 옮기지 마라.**
export const SCAN_LIMITS = [
  { mark: '🟢', key: 'scan.lim.green',  ko: '주방용품 · 소형가전 · 완구 · 화장품 · 책',
    whyKey: 'scan.lim.green.why',  why: '제조사 바코드가 그대로 유통돼' },
  { mark: '🟡', key: 'scan.lim.yellow', ko: '식료품 · 의류',
    whyKey: 'scan.lim.yellow.why', why: '바코드는 맞는데 온라인에 같은 걸 잘 안 팔아' },
  { mark: '🔴', key: 'scan.lim.red',    ko: 'TV · 대형가전 · 코스트코/샘스클럽 · 매장 자체 브랜드',
    whyKey: 'scan.lim.red.why',    why: '매장마다 모델번호를 일부러 다르게 붙여' },
];

// ============================================================================
// 2. quagga2 로딩 — 같은 출처에서, 한 번만
// ============================================================================

let quaggaPromise = null;

export function loadQuagga() {
  if (quaggaPromise) return quaggaPromise;
  quaggaPromise = new Promise((resolve, reject) => {
    if (window.Quagga) return resolve(window.Quagga);
    const s = document.createElement('script');
    s.src = QUAGGA_URL;
    s.async = true;
    s.onload = () => window.Quagga ? resolve(window.Quagga)
                                   : reject(new Error('quagga2를 받았는데 초기화되지 않았다'));
    s.onerror = () => { quaggaPromise = null; reject(new Error('quagga2를 받지 못했다')); };
    document.head.appendChild(s);
  });
  return quaggaPromise;
}

// 한 장의 이미지를 한 가지 설정으로 한 번 해독한다.
// numOfWorkers: 0  — 워커를 만들지 않는다(라이브러리의 Blob 워커 경로에 진입하지 않음)
// src가 blob: URL이면 quagga2가 EXIF orientation을 직접 읽어 보정한다(아이폰 사진 회전).
function quaggaDecodeOnce(Quagga, src, opt) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(null), 15000);   // 멈춰 있는 것도 실패다
    try {
      Quagga.decodeSingle({
        src,
        numOfWorkers: 0,
        locate: true,
        inputStream: { size: opt.size, singleChannel: false },
        locator: { patchSize: opt.patchSize, halfSample: opt.halfSample },
        decoder: { readers: ['upc_reader', 'upc_e_reader', 'ean_reader', 'ean_8_reader'] },
      }, result => {
        clearTimeout(timer);
        const cr = result && result.codeResult;
        finish(cr && cr.code ? { code: String(cr.code), format: cr.format } : null);
      });
    } catch (e) { clearTimeout(timer); finish(null); }
  });
}

// 파일 하나를 받아 UPC까지. 실패는 실패로 돌려준다.
export async function decodeFile(file) {
  const Quagga = await loadQuagga();
  const url = URL.createObjectURL(file);
  try {
    return await decodeWithRetries(url, (src, opt) => quaggaDecodeOnce(Quagga, src, opt));
  } finally {
    URL.revokeObjectURL(url);      // 사진을 붙들고 있지 않는다
  }
}

// ============================================================================
// 3. 화면
// ============================================================================

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const st = document.createElement('style');
  st.textContent = [
    '#scanPanel{margin-top:12px}',
    '#scanPanel .scanbox{border:1px solid var(--line);border-radius:12px;padding:14px;background:var(--bg)}',
    '#scanPanel .scanhead{font-weight:800;margin-bottom:8px}',
    '#scanPanel .scancode{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:18px;font-weight:800;letter-spacing:.06em;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 10px;display:inline-block}',
    '#scanPanel .scanlinks{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 4px}',
    '#scanPanel .scanlinks a{display:inline-block;padding:10px 14px;border-radius:10px;background:var(--accent);color:#fff;font-weight:800;text-decoration:none}',
    '#scanPanel .scanfail{border-left:3px solid var(--warn)}',
    '#scanPanel .scanlim{margin-top:12px;font-size:var(--t-small);line-height:1.65}',
    '#scanPanel .scanlim div{margin:3px 0}',
    '#scanPanel .scanmanual{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}',
    '#scanPanel .scanmanual input{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;max-width:190px}',
  ].join('\n');
  document.head.appendChild(st);
}

function panel() {
  let el = document.getElementById('scanPanel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'scanPanel';
    const row = document.getElementById('scanRow');
    if (row && row.parentNode) row.parentNode.insertBefore(el, row.nextSibling);
    else document.body.appendChild(el);
  }
  injectStyle();
  return el;
}

function limitsHtml() {
  const rows = SCAN_LIMITS.map(l =>
    '<div>' + l.mark + ' <b>' + esc(T(l.key, l.ko)) + '</b> <span class="muted">— ' + esc(T(l.whyKey, l.why)) + '</span></div>'
  ).join('');
  return '<div class="scanlim">' + rows +
    '<div class="muted" style="margin-top:6px">' + T('scan.lim.variant',
      '<b>색·용량이 다르면 바코드도 달라.</b> 찍은 그 색·그 용량만 찾아줘.') + '</div></div>';
}

// 폴백 — 12자리 직접 입력. 눌러야 나온다(기본 경로가 아니다).
function manualHtml() {
  return '<details style="margin-top:10px"><summary class="muted">' +
    T('scan.manual.open', '바코드 아래 숫자를 직접 넣기') + '</summary>' +
    '<div class="scanmanual">' +
    '<input id="scanManualIn" inputmode="numeric" maxlength="17" placeholder="' +
      T('scan.manual.ph', '예: 041604414855') + '">' +
    '<button class="mini" id="scanManualGo" type="button">' + T('scan.manual.go', '찾아보기') + '</button>' +
    '<span class="muted" id="scanManualMsg"></span></div></details>';
}

// 사유 키(empty/not-digits/…)는 normalizeManualEntry 의 반환값이라 그대로 둔다 —
// 하니스가 그 값을 리터럴로 검사한다. 번역되는 건 문구뿐이다.
const MANUAL_REASON = {
  'empty':      ['scan.manual.err.empty',      '숫자를 넣어줘.'],
  'not-digits': ['scan.manual.err.notDigits',  '숫자만 넣어줘 (바코드 아래 인쇄된 그 숫자).'],
  'bad-length': ['scan.manual.err.badLength',  '바코드 아래 숫자는 보통 12자리야. 지금은 {len}자리.'],
  'bad-check':  ['scan.manual.err.badCheck',   '이 번호는 바코드 번호가 아닌 것 같아 — 한 자리 잘못 본 게 아닐까?'],
};
const manualReason = r => { const e = MANUAL_REASON[r]; return e ? T(e[0], e[1]) : ''; };

function renderBusy() {
  panel().innerHTML = '<div class="scanbox"><div class="scanhead">⏳ ' +
    T('scan.busy', '사진에서 바코드를 찾는 중…') + '</div>' +
    '<p class="muted" style="margin:0">' + T('scan.busy.note',
      '사진은 이 기기 밖으로 나가지 않아. 해독은 이 브라우저 안에서 끝나.') + '</p></div>';
}

function renderFound(code) {
  const links = buildDeepLinks(code).map(l =>
    '<a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' +
    esc(l.name) + T('scan.link.suffix', '에서 찾기') + '</a>').join('');
  panel().innerHTML = '<div class="scanbox">' +
    '<div class="scanhead">✅ ' + T('scan.ok', '바코드를 읽었어') + '</div>' +
    '<div class="scancode">' + esc(code) + '</div>' +
    '<div class="scanlinks">' + links + '</div>' +
    '<p class="cpp-note" style="margin:6px 0 0">' + T('scan.ok.note',
      '<b>가격은 우리가 모른다.</b> 위 링크를 열어 <b>네 눈으로 가격을 확인</b>하고, 그 상품 페이지 URL을 위 붙여넣기 칸에 넣으면 순비용 비교가 시작돼. 🔒 이 버튼은 아무것도 우리 서버로 보내지 않아 — 검색은 아마존·베스트바이에서 바로 열려.') + '</p>' +
    limitsHtml() + manualHtml() +
    '<div style="margin-top:10px"><button class="mini" id="scanAgain" type="button">' +
    T('scan.again', '📷 다시 찍기') + '</button></div></div>';
  wire();
}

function renderFail(reason, detail) {
  const head = reason === 'ambiguous'
    ? T('scan.fail.amb', '바코드가 여러 가지로 읽혀서 확신할 수 없어')
    : T('scan.fail.none', '바코드를 못 읽었어요');
  const body = reason === 'ambiguous'
    ? T('scan.fail.amb.note', '읽을 때마다 다른 숫자가 나왔어. <b>어느 쪽인지 모르니 넘겨짚지 않을게.</b> 바코드가 화면에 크고 반듯하게 들어오도록 다시 찍어줘.')
    : reason === 'load-failed'
      ? T('scan.fail.load', '스캐너 코드를 받지 못했어. 인터넷 연결을 확인하고 다시 눌러줘.')
      : T('scan.fail.none.note', '바코드가 <b>화면에 크게 · 반듯하게 · 초점이 맞게</b> 들어오도록 다시 찍어줘. 포장이 휘었거나 비닐이 반사되면 잘 안 읽혀.');
  panel().innerHTML = '<div class="scanbox scanfail">' +
    '<div class="scanhead">😕 ' + head + '</div>' +
    '<p class="muted" style="margin:0">' + body + '</p>' +
    (detail ? '<p class="muted" style="margin:6px 0 0">' + esc(detail) + '</p>' : '') +
    '<div style="margin-top:10px"><button class="mini" id="scanAgain" type="button">' +
    T('scan.again', '📷 다시 찍기') + '</button></div>' + manualHtml() + '</div>';
  wire();
}

function wire() {
  const again = document.getElementById('scanAgain');
  if (again) again.addEventListener('click', () => {
    const inp = document.getElementById('scanFile');
    if (inp) inp.click();
  });
  const go = document.getElementById('scanManualGo');
  const inEl = document.getElementById('scanManualIn');
  const run = () => {
    const msg = document.getElementById('scanManualMsg');
    const r = normalizeManualEntry(inEl ? inEl.value : '');
    if (r.ok) { renderFound(r.code); return; }
    if (msg) msg.textContent = (manualReason(r.reason) || manualReason('bad-check'))
      .replace('{len}', String(r.len == null ? '' : r.len));
  };
  if (go) go.addEventListener('click', run);
  if (inEl) inEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
}

// ============================================================================
// 4. 진입점 — index.html의 글루가 부르는 것
// ============================================================================

export async function handleFile(file) {
  if (!file) return;
  renderBusy();
  let r;
  try {
    r = await decodeFile(file);
  } catch (e) {
    renderFail('load-failed');
    return;
  }
  if (r.ok) renderFound(r.code);
  else renderFail(r.reason, r.reason === 'ambiguous' ? '읽힌 값: ' + r.codes.join(' / ') : '');
}

// 하니스(브라우저 콘솔)가 순수 로직을 집어갈 수 있게 열어둔다.
// ⚠️ 이름을 바꾸면 site/tests/negcontrol-scan.js 의 변형 문자열도 같이 고칠 것.
if (typeof window !== 'undefined') window.__scanner = {
  gs1CheckDigit, hasValidCheckDigit, expandUpcE, toCanonical,
  normalizeManualEntry, buildDeepLinks, decodeWithRetries,
  DEEP_LINK_STORES, DEEP_LINK_BLOCKED, DECODE_ATTEMPTS, SCAN_LIMITS,
};
