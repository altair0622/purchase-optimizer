// PriceAfter — 📷 사진으로 상품 찾기 (v0.31)
// ============================================================================
// 근거 문서: 리서치/사진-상품인식-조사.md — 6장(설계의 급소) · 8장(MVP) · 9장(하지 말 것)
//            리서치/workers-ai-비전-실측-2026-08-20.md — 왜 유료 API 로 갔나
// 구속 문서: 프라이버시-원칙.md H3·H4·H5·H7 / v0.26 "틀린 값은 없는 것보다 나쁘다"
//
// 흐름:  📷 버튼 → OS 카메라(사진 1장) → 이 파일이 축소·프리체크
//        → 워커 POST /vision → 비전 API → 후보 검색어 + read/guessed
//        → 사용자가 고르고 **고쳐서** 누름 → 판매처 키워드 검색
//        → 그 URL 을 기존 붙여넣기 칸에 넣으면 v0.24 파이프라인이 나머지를 한다
//
// 이 파일이 하지 않는 것 (전부 의도된 것이다. 고치려 들기 전에 위 문서를 읽을 것):
//   · **검색을 자동 실행하지 않는다** — 조사 9장 #2. 이게 "조용히 틀리지 않음"의 유일한 구조적 보장이다
//   · **모델의 신뢰도 숫자를 안 쓴다** — 조사 9장 #3. 80~100%에 5의 배수로 몰려서 게이트가 안 열린다
//   · **가격을 만들지 않는다** — 우리가 아는 "지금 가격"은 없다
//   · **못 알아보면 비슷한 걸 대신 보여주지 않는다** — 조사 9장 #5·8장
//   · **세 번 되묻지 않는다** — 조사 9장 #14. 두 번에서 끊고 직접 입력으로 넘긴다
//
// ⚠️ 바코드(scanner.js)와 이 파일은 **프라이버시 성질이 정반대다.**
//    바코드: 사진이 기기 밖으로 안 나간다 (해독이 브라우저 안에서 끝난다)
//    사진:   사진이 기기 밖으로 나간다 (비전 API 로)
//    **버튼별로 다른 문장을 쓴다. 하나로 뭉개면 둘 중 하나가 거짓이 된다** (조사 4-C·9장 #10).
// ============================================================================

// index.html 의 t() 가 있으면 태우고(영어판 대비), 없으면 한국어 원문을 쓴다.
// 한국어 원문은 여기 있는 그것이 진실이다 — scanner.js 와 같은 규칙.
const T = (key, ko) => {
  try { return (typeof t === 'function') ? t(key, ko) : ko; } catch (e) { return ko; }
};
// ⚠️ index.html 의 표시 언어 변수는 `LANG` 이다(`let LANG = 'ko'`). 최상위 let/const 는
//    전역 렉시컬 환경에 들어가므로 ES 모듈인 이 파일에서도 보인다 — window.LANG 은 없다.
const curLang = () => {
  try { return (typeof LANG === 'string' && LANG === 'en') ? 'en' : 'ko'; } catch (e) { return 'ko'; }
};

// ============================================================================
// 1. 순수 로직 — 카메라도 DOM 도 네트워크도 없이 검사할 수 있는 부분
//    (site/tests/fuzz-personas.js 의 __fuzz.runVision() 이 여기를 골든으로 못 박는다)
// ============================================================================

// ---------------------------------------------------------------------------
// 판매처 키워드 검색 딥링크
// ---------------------------------------------------------------------------
// ⭐ **바코드(scanner.js)와 목록이 다르다. 의도된 것이다.**
// 조사 3-E 실측: Walmart 는 **UPC 검색을 3/3 거부했지만 키워드 대조군은 정상 통과**했다.
// 즉 "Walmart 가 막힌 것"이 아니라 "Walmart 검색이 UPC 를 인식하지 않는 것"이었다.
// → 사진 경로는 키워드를 만들므로 **Walmart 가 살아난다.** 이게 사진 경로가 바코드보다
//   나은 두 번째 구조적 이득이다(조사 8장 2단계).
//
// 근거 등급을 줄마다 적어 둔다. **✅ 가 아닌 곳을 늘리려면 먼저 재라.**
//   amazon  ✅ 조사 8장 2단계에서 키워드 딥링크 직접 확인 (nike air max 90 white)
//   target  ✅ 같은 자리에서 직접 확인
//   walmart 🟡 우리 자동화는 307 을 받았다(봇 체크로 보인다). **"안 된다"가 아니라 "모른다"**.
//             딥링크는 사용자 자기 브라우저에서 열리므로 우리 자동화가 막힌 것이
//             사용자가 막힌다는 뜻이 아니다(조사 8장 2단계 ⚠️ 주석).
//   bestbuy 🟡 40초 타임아웃. 역시 "모른다". 바코드 경로에서 이미 쓰고 있던 곳이다.
//
// 이 링크에는 **어필리에이트 태그가 없다** — H4(남의 추천 링크를 안 건드린다)·
// H5(추천 순위에 수익 0%). 추적 파라미터를 붙이지 마라.
export const SEARCH_STORES = [
  { id: 'amazon',  name: 'Amazon',   ev: 'verified', build: q => 'https://www.amazon.com/s?k=' + encodeURIComponent(q) },
  { id: 'target',  name: 'Target',   ev: 'verified', build: q => 'https://www.target.com/s?searchTerm=' + encodeURIComponent(q) },
  { id: 'walmart', name: 'Walmart',  ev: 'unknown',  build: q => 'https://www.walmart.com/search?q=' + encodeURIComponent(q) },
  { id: 'bestbuy', name: 'Best Buy', ev: 'unknown',  build: q => 'https://www.bestbuy.com/site/searchpage.jsp?st=' + encodeURIComponent(q) },
];

export function buildSearchLinks(query) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return [];                       // 빈 검색어로 링크를 만들지 않는다
  return SEARCH_STORES.map(s => ({ id: s.id, name: s.name, url: s.build(q) }));
}

// ---------------------------------------------------------------------------
// 되묻기 — **방향을 지목한다**
// ---------------------------------------------------------------------------
// 조사 6-C: *"'다시 찍어 주세요'는 최악의 문구다."* 뭉뚱그린 피드백은 효과가 없고
// "move up / move left" 처럼 구체적인 지시가 필요하다는 정성적 보고가 있다(🔶).
// 그래서 워커는 **사유(열거값)만** 돌려주고 문구는 여기서 만든다 — 언어별로 달라야 하므로.
//
// ⚠️ 순서에 근거가 있다(조사 6-C 표): 브랜드가 검색어의 절반이라 그게 없으면 나머지가 무의미하다.
// ⚠️ 이 표의 우선순위는 **연역이고 측정이 아니다**(조사 10장 미확인 #8 — 공개 근거가 없다).
//    A/B 로 재기 전까지 "근거 있는 값"처럼 취급하지 마라.
export const ASK_COPY = {
  'no-brand':        ['vision.ask.brand',   '상표나 로고가 보이게 한 장 더 찍어 주세요'],
  'no-model':        ['vision.ask.model',   '모델명이 적힌 스티커나 택이 있으면 그걸 찍어 주세요 — TV·가전이면 화면 아래 띠나 뒷면이에요'],
  'packaging':       ['vision.ask.pkg',     '박스나 포장에 인쇄된 글씨가 보이게 찍어 주세요'],
  'too-far':         ['vision.ask.close',   '조금 더 가까이서, 글씨가 읽히게 찍어 주세요'],
  'multiple':        ['vision.ask.one',     '찾으려는 물건 하나만 나오게 찍어 주세요'],
  'none-recognized': ['vision.ask.none',    '무엇인지 못 알아봤어요. 상표나 모델명이 보이게 한 장 더 찍어 주세요'],
};
export function askText(reason) {
  const e = ASK_COPY[reason];
  return e ? T(e[0], e[1]) : T('vision.ask.fallback', '상표나 모델명이 보이게 한 장 더 찍어 주세요');
}

// ---------------------------------------------------------------------------
// ⭐ 되묻기 판단 — **모델의 자기평가가 아니라 `read` 가 비었는지로 한다**
// ---------------------------------------------------------------------------
// 조사 6-A 가 이 설계의 급소를 지목한다: 모델은 모를 때 모른다고 말하지 않는다.
// 실측에서도 "못 읽으면 UNKNOWN 이라고 하라"를 12/12 무시했다.
// → 모델이 `ask: null` 을 줘도, **읽은 글자가 하나도 없으면 그건 짐작뿐이라는 뜻**이므로
//   우리가 되묻는다. 이 한 줄이 모델의 과신을 우회하는 자리다.
export function needsReask(result) {
  if (!result || !result.ok) return false;                 // 오류는 되묻기가 아니라 오류다
  if (!result.candidates || !result.candidates.length) return true;
  if (!result.read || !result.read.length) return true;    // ← 급소
  return !!(result.ask && result.ask.reason);
}

// 되묻기 사유 고르기 — 모델이 준 사유를 쓰되, 없으면 read 가 빈 상황에 맞는 기본값.
export function reaskReason(result) {
  if (result && result.ask && result.ask.reason) return result.ask.reason;
  if (!result || !result.candidates || !result.candidates.length) return 'none-recognized';
  return 'no-brand';
}

// ---------------------------------------------------------------------------
// `guessed` 중 워커가 붙인 UNVERIFIED: 표시를 사람 문장으로
// ---------------------------------------------------------------------------
// 워커의 auditGuessed() 가 "검색어에는 있는데 read 가 뒷받침하지 않는 모델번호"를
// `UNVERIFIED:<토큰>` 으로 표시해 보낸다. 문구는 언어별이라 여기서 붙인다.
export function guessedLine(s) {
  const m = /^UNVERIFIED:(.+)$/.exec(String(s || ''));
  if (!m) return String(s || '');
  // ⚠️ 예전 문구는 "…는 사진에서 **확인하지 못했어요**" 였다. 이건 **반대를 함의한다** —
  //    표시가 안 된 값은 우리가 확인했다는 뜻이 되는데, **우리는 read 를 대조하지 않는다.**
  //    (실측: 모델이 작은 글자를 1~3글자 틀리게 읽어도 검색어와 값이 같아 감사에 안 걸린다.)
  //    그래서 "우리가 확인했다/못했다"가 아니라 **관찰된 사실만** 말한다.
  return T('vision.unverified', '"{x}"는 사진에서 읽은 글자에 없어요 — 짐작이에요')
    .replace('{x}', m[1]);
}

// ---------------------------------------------------------------------------
// 하루 사용 상한 — **방어가 아니다**
// ---------------------------------------------------------------------------
// 조사 5-C: 진짜 방어선은 ① Cloudflare 엣지 레이트리밋 ② 제공자 콘솔의 월 예산 상한이다.
// 이건 localStorage 라 지우면 그만이므로 **우회 가능하고, 그래서 방어가 아니다.**
// 정직한 사용자가 실수로 폭주하는 걸 막고 "오늘은 여기까지예요"를 띄우는 자리일 뿐이다.
// ⚠️ 이걸 방어선으로 착각해서 엣지 레이트리밋을 생략하면 안 된다.
export const DAILY_CAP = 20;
const DAY_KEY = 'pa_vision_day';

export function dayCount(store, today) {
  try {
    const raw = store.getItem(DAY_KEY);
    if (!raw) return 0;
    const j = JSON.parse(raw);
    return (j && j.d === today) ? (+j.n || 0) : 0;
  } catch (e) { return 0; }
}
export function bumpDay(store, today) {
  const n = dayCount(store, today) + 1;
  try { store.setItem(DAY_KEY, JSON.stringify({ d: today, n })); } catch (e) { /* 사파리 프라이빗 등 */ }
  return n;
}
export const todayStr = d => {
  const x = d || new Date();
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
};

// ---------------------------------------------------------------------------
// 사진 프리체크 — **API 를 부르기 전에** 되돌린다
// ---------------------------------------------------------------------------
// 조사 6-B-2: 고품질 사진 98.5% vs 복합 품질 문제 69.4% (🔶). 30%p 격차는 프롬프트로 못 메운다.
// 그리고 **안 보내면 돈이 안 든다** — 비용 0·지연 0의 개선이라 순서상 가장 먼저다.
//
// ⚠️ **임계값은 측정된 값이 아니다.** 아래 MIN_LAPLACIAN_VAR 는 "명백히 뭉개진 사진만
//    걸리게" 낮게 잡은 보수적인 바닥값이고, 근거는 "감"이다. 실제 매장 사진으로 재기 전까지
//    근거 있는 값처럼 취급하지 마라(조사 10장 미확인 #9 와 같은 성격).
//    그래서 흐림은 **막지 않고 경고만 한다** — 사용자가 "그냥 보내기"로 넘어갈 수 있다.
//    잘못 잡힌 임계값이 멀쩡한 사진을 막으면 기능 자체가 안 쓰이게 된다.
// 반면 **해상도 미달은 막는다** — 긴 변이 이만큼도 안 되면 인쇄 글자가 물리적으로 안 담긴다.
export const MIN_LONG_EDGE = 480;
export const MIN_LAPLACIAN_VAR = 8;

// 라플라시안 분산 — 초점이 맞으면 이웃 화소 차이가 크고, 뭉개지면 작아진다.
// 회색조 정수 배열(width×height)을 받는다. DOM 없이 검사할 수 있게 분리해 뒀다.
export function laplacianVar(gray, w, h) {
  if (!gray || w < 3 || h < 3) return 0;
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w];
      sum += v; sum2 += v * v; n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

// 프리체크 판정. 'ok' | 'too-small' | 'blurry'
export function precheck(longEdge, lapVar) {
  if (!(longEdge > 0)) return 'ok';                          // 못 재면 통과시킨다 — 막는 쪽이 더 나쁘다
  if (longEdge < MIN_LONG_EDGE) return 'too-small';
  if (lapVar != null && lapVar < MIN_LAPLACIAN_VAR) return 'blurry';
  return 'ok';
}

// ---------------------------------------------------------------------------
// 워커 응답 → 화면에 그릴 형태
// ---------------------------------------------------------------------------
// 워커가 이미 정규화하지만, **워커를 못 믿어서가 아니라 클라이언트가 단독으로도
// 안전해야 하기 때문에** 한 번 더 좁힌다(빈 배열·형 오류 등).
export function shapeResult(j) {
  if (!j || j.ok !== true) {
    return { ok: false, errorCode: (j && j.errorCode) || 'provider-error', error: (j && j.error) || '' };
  }
  const arr = v => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : [];
  const candidates = (Array.isArray(j.candidates) ? j.candidates : [])
    .filter(c => c && typeof c.query === 'string' && c.query.trim())
    .map(c => ({ query: c.query.trim(), why: typeof c.why === 'string' ? c.why.trim() : '' }))
    .slice(0, 3);
  return {
    ok: true,
    category: typeof j.category === 'string' ? j.category.trim() : '',
    candidates,
    read: arr(j.read),
    guessed: arr(j.guessed),
    ask: (j.ask && typeof j.ask.reason === 'string') ? { reason: j.ask.reason, detail: String(j.ask.detail || '') } : null,
  };
}

// ============================================================================
// 2. 이미지 준비 — 축소·회전보정·JPEG
// ============================================================================
// 클라이언트에서 축소하는 이유가 셋이고 전부 같은 방향이다(조사 8장 1단계):
//   비용(토큰이 면적에 비례) · 지연(업로드가 지연의 큰 몫) · 워커 CPU(무료 플랜 10ms).
// **base64 도 여기서 만든다** — 워커에서 만들면 CPU 를 먹는다(조사 2-B).
// ⭐ 1568 인 이유는 측정이다 (리서치/workers-ai-비전-실측-2026-08-20.md 부록 C).
// 처음엔 1024 였는데, **그 축소가 오독의 원인이었다.** 아이폰 원본은 4032px 라
// 1024 로 줄이면 선형 1/4 — 원본 48px 글자가 12px 이 된다. 그 구간의 실측 실패율이
// **5/5(100%)** 였다. 즉 우리가 실패 구간으로 직접 밀어 넣고 있었다.
// 1568 로 올려 같은 장면을 다시 재니 **65콜 전부 지어냄 0건**, 실패하던 세 케이스가 전부 살아났다.
//
// 왜 하필 1568: Claude 비전은 **긴 변 1568px 를 넘으면 내부적으로 다시 줄인다.**
// 그 이상은 토큰만 쓰고 얻는 게 없다 — 상한이자 최적점이다.
// 대가: 이미지 토큰 1,036 → 2,352 (2.27배). 지연은 **측정 가능한 차이가 없었다**
// (평균 +68ms, 케이스별 편차 ±1,500ms 안).
//
// ⚠️ **"글자 높이 N px 이상이면 안전"으로 요약하지 마라.** 데이터가 그렇게 안 나온다 —
//    1024에서 16px 는 20% 실패인데 1568에서 18px 는 0% 였다. 절대 글자 높이만이 변수가
//    아니라 이미지 전체 해상도·JPEG 손실·모델 내부 타일링이 함께 작용한다.
export const LONG_EDGE = 1568;
export const JPEG_QUALITY = 0.75;

async function toBitmap(file) {
  // imageOrientation:'from-image' — 아이폰 사진의 EXIF 회전을 브라우저가 처리한다.
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { /* 구형 사파리는 옵션을 모른다 → 아래로 */ }
    try { return await createImageBitmap(file); } catch (e) { /* 아래로 */ }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('사진을 읽지 못했어')); };
    img.src = url;
  });
}

// 파일 하나 → { b64, longEdge, lapVar }. 실패하면 예외.
export async function prepareImage(file) {
  const bmp = await toBitmap(file);
  const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
  if (!w0 || !h0) throw new Error('사진 크기를 읽지 못했어');

  const scale = Math.min(1, LONG_EDGE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));

  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d');
  cx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();               // 사진을 붙들고 있지 않는다

  // 흐림 측정 — 긴 변 256 으로 한 번 더 줄여서 잰다(빠르고, 센서 노이즈에 덜 흔들린다)
  let lapVar = null;
  try {
    const s2 = Math.min(1, 256 / Math.max(w, h));
    const sw = Math.max(3, Math.round(w * s2)), sh = Math.max(3, Math.round(h * s2));
    const c2 = document.createElement('canvas');
    c2.width = sw; c2.height = sh;
    c2.getContext('2d').drawImage(cv, 0, 0, sw, sh);
    const d = c2.getContext('2d').getImageData(0, 0, sw, sh).data;
    const gray = new Float32Array(sw * sh);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    lapVar = laplacianVar(gray, sw, sh);
  } catch (e) { lapVar = null; }            // 못 재면 통과시킨다

  const dataUrl = cv.toDataURL('image/jpeg', JPEG_QUALITY);
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  cv.width = cv.height = 0;                 // 캔버스 픽셀을 붙들고 있지 않는다
  return { b64, longEdge: Math.max(w, h), lapVar };
}

// ============================================================================
// 3. 워커 호출
// ============================================================================
// PRICE_API 는 index.html 이 이미 갖고 있는 워커 주소다. 새 주소를 만들지 않는다.
function workerBase() {
  try { if (typeof PRICE_API === 'string' && PRICE_API) return PRICE_API.replace(/\/+$/, ''); }
  catch (e) { /* 정의 전이면 아래로 */ }
  return '';
}

export async function askVision(b64list) {
  const base = workerBase();
  if (!base) return { ok: false, errorCode: 'no-worker', error: '조회 서버 주소가 없어' };
  let res;
  try {
    res = await fetch(base + '/vision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ images: b64list, lang: curLang() }),
    });
  } catch (e) {
    return { ok: false, errorCode: 'network', error: (e && e.message) || String(e) };
  }
  let j = null;
  try { j = await res.json(); } catch (e) { j = null; }
  return shapeResult(j);
}

// ============================================================================
// 4. 화면
// ============================================================================

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const st = document.createElement('style');
  st.textContent = [
    '#visionPanel{margin-top:12px}',
    '#visionPanel .vbox{border:1px solid var(--line);border-radius:12px;padding:14px;background:var(--bg)}',
    '#visionPanel .vhead{font-weight:800;margin-bottom:8px}',
    '#visionPanel .vfail{border-left:3px solid var(--warn)}',
    '#visionPanel .vread{font-size:var(--t-small);line-height:1.7;margin:2px 0 10px}',
    '#visionPanel .vread b{font-weight:800}',
    '#visionPanel .vguess{color:var(--warn);font-weight:700}',
    '#visionPanel .vq{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0 4px}',
    '#visionPanel .vq input{flex:1 1 260px;font-weight:700}',
    '#visionPanel .valt{margin:8px 0 0;font-size:var(--t-small)}',
    '#visionPanel .valt label{display:block;margin:5px 0;cursor:pointer}',
    '#visionPanel .vlinks{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 4px}',
    '#visionPanel .vlinks a{display:inline-block;padding:10px 14px;border-radius:10px;background:var(--accent);color:#fff;font-weight:800;text-decoration:none}',
    '#visionPanel .vlinks a.unk{background:var(--card);color:var(--fg);border:1px solid var(--line)}',
    '#visionPanel .vbtns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}',
    '#visionPanel .vfold{margin-top:8px}',
    '#visionPanel .vfold>summary{cursor:pointer;font-size:var(--t-small);color:var(--muted);font-weight:700}',
    '#visionPanel .vfold[open]>summary{margin-bottom:6px}',
  ].join('\n');
  document.head.appendChild(st);
}

function panel() {
  let el = document.getElementById('visionPanel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'visionPanel';
    const row = document.getElementById('pickRow');
    if (row && row.parentNode) row.parentNode.insertBefore(el, row.nextSibling);
    else document.body.appendChild(el);
  }
  injectStyle();
  return el;
}

const againBtn = () => '<button class="mini" id="visionAgain" type="button">' +
  T('vision.again', '📷 다시 찍기') + '</button>';

// 실패·오류 화면 공통 꼬리 — **탈출구를 항상 같이 둔다**(원칙 C3).
// 바코드를 여기에 두는 것이 조사 7장의 "격하하되 남긴다"의 구체적 형태다:
// 사진이 두 번 실패한 자리가 바코드가 가장 값어치 있는 자리다.
function escapeHatches() {
  const hasScan = !!document.getElementById('scanBtn');
  return '<div class="valt" style="margin-top:12px">' +
    '<div>· ' + T('vision.esc.type', '<b>상품명을 직접 입력</b>해도 똑같이 동작해요 — 그러면 사진은 아무 데도 안 가요.') + '</div>' +
    (hasScan ? '<div>· ' + T('vision.esc.scan',
      '포장에 바코드가 있으면 <b>바코드 찍기</b>를 쓰세요 — <b>그쪽은 사진이 기기 밖으로 안 나가요</b>.') + '</div>' : '') +
    '</div>';
}

function renderBusy(n) {
  panel().innerHTML = '<div class="vbox"><div class="vhead">⏳ ' +
    T('vision.busy', '사진에서 상품을 찾는 중…') + '</div>' +
    '<p class="muted" style="margin:0">' + T('vision.busy.note',
      '찍은 사진이 지금 <b>기기 밖으로 나가고 있어요</b>. 저장하지 않고 통과만 시켜요.') +
    (n > 1 ? ' ' + T('vision.busy.two', '두 장을 같이 보고 있어요.') : '') + '</p></div>';
}

// ⭐ 결과 화면 — 이 함수가 조사 6-B 의 "겹 2·겹 3"을 그린다.
//    겹 2 = 무엇을 읽었고 무엇을 짐작했는지 노출
//    겹 3 = 검색어를 **편집 가능한 칸**으로 두고 **자동 실행하지 않는다**
// ⭐ 결과 화면 — v0.33 에서 크게 덜어냈다.
//
// 사용자 피드백 두 개가 같은 곳을 가리켰다:
//   "읽은 것 짐작한 것들은 개발 측면에서 보이면 좋지 소비자에게는 투머치인 것 같아."
//   "'이 검색어로 찾기' 부분은 다른 후보들이랑 어떻게 선택해야 하는지 모르겠어. 직관적이지 않아."
//
// 진단: **개발자용 구조를 그대로 소비자 화면에 올려놨다.** read/guessed 는 우리가 설계를
// 검증하려고 만든 필드이고, 후보 3개는 우리가 확신을 못 해서 떠넘긴 것이다.
// → 화면에 남기는 건 **행동을 바꾸는 것**뿐: 편집 가능한 검색어 한 줄 + 누를 버튼.
//   나머지는 **접는다. 지우지는 않는다** — 모델이 1~3글자 틀리게 읽어도 우리가 못 잡으므로
//   "왜 이렇게 나왔지?"를 확인할 경로는 남아야 한다(실측 부록 C-1).
function renderResult(r) {
  const first = r.candidates[0];
  const alts = r.candidates.slice(1);

  // ⑤ 다른 후보 — 접는다. 펼치면 누르는 즉시 위 칸에 들어간다.
  const altHtml = alts.length
    ? '<details class="vfold"><summary>' +
        T('vision.alts.fold', '다르게 찾기') + ' <span class="tag">' + alts.length + '</span></summary>' +
        '<div class="valt">' + alts.map(c =>
          '<label><input type="radio" name="vAlt" data-q="' + esc(c.query) + '"> <code>' + esc(c.query) + '</code>' +
          (c.why ? ' <span class="muted">— ' + esc(c.why) + '</span>' : '') + '</label>').join('') +
        '</div></details>'
    : '';

  // ③ 읽은 것 / 짐작한 것 — 접는다. 결과가 이상할 때 여는 자리다.
  const readRow = r.read.length
    ? '<div>👀 ' + T('vision.read', '읽은 것') + ': <b>' + r.read.map(esc).join('</b> · <b>') + '</b></div>'
    : '<div>👀 ' + T('vision.read.none', '<b>사진에서 읽어낸 글자가 없어요</b> — 아래는 전부 짐작이에요.') + '</div>';
  const guessRow = r.guessed.length
    ? '<div class="vguess">⚠️ ' + T('vision.guessed', '짐작한 것') + ': ' +
      r.guessed.map(g => esc(guessedLine(g))).join(' · ') + '</div>'
    : '';
  const whyRow = first.why ? '<div class="muted">— ' + esc(first.why) + '</div>' : '';
  const readHtml = '<details class="vfold"><summary>' +
    T('vision.read.fold', '사진에서 무엇을 읽었나요?') + '</summary>' +
    '<div class="vread">' + readRow + guessRow + whyRow + '</div></details>';

  panel().innerHTML = '<div class="vbox">' +
    '<div class="vhead">' + (r.category ? '🔍 ' + esc(r.category) : '🔍 ' + T('vision.found', '이렇게 보여요')) + '</div>' +
    '<div class="vq"><input id="visionQ" type="text" value="' + esc(first.query) + '" ' +
      'aria-label="' + T('vision.q.aria', '검색어') + '">' +
      '<button id="visionGo" type="button">' + T('vision.go', '이 검색어로 찾기') + '</button></div>' +
    // ④ 남기는 건 **행동을 바꾸는 문장**뿐이다.
    //    "읽었다는 글자도 저희가 대조해 본 건 아니에요" 는 지웠다 — 우리 사정을 설명할 뿐
    //    사용자가 할 일을 바꾸지 않는다. 정직성은 문장을 늘려서가 아니라
    //    **편집 가능한 검색창 + 아래 한 줄**로 지켜진다.
    '<p class="cpp-note" style="margin:8px 0 0">' + T('vision.note',
      '<b>맞는지 확인하고 고쳐서 누르세요.</b> 모델번호는 <b>손에 든 물건과 맞춰 보세요</b>.') + '</p>' +
    altHtml + readHtml +
    '<div id="visionLinks"></div>' +
    '<div class="vbtns">' + againBtn() + '</div>' +
    '</div>';
  wire();
}

// 되묻기 화면 — **방향을 지목한 문장 하나 + 카메라 버튼.**
// 첫 사진에서 뭔가 읽었으면 그것도 같이 보여준다(사용자가 진행 상황을 안다).
function renderAsk(r, reason) {
  const detail = r && r.ask && r.ask.detail ? '<p class="muted" style="margin:6px 0 0">' + esc(r.ask.detail) + '</p>' : '';
  const got = r && r.read && r.read.length
    ? '<p class="muted" style="margin:6px 0 0">' + T('vision.ask.got', '지금까지 읽은 것') + ': <b>' +
      r.read.map(esc).join('</b> · <b>') + '</b></p>'
    : '';
  panel().innerHTML = '<div class="vbox vfail">' +
    '<div class="vhead">📷 ' + esc(askText(reason)) + '</div>' +
    '<p class="muted" style="margin:0">' + T('vision.ask.note',
      '<b>두 장을 같이 보고 판단해요</b> — 방금 찍은 사진은 그대로 두고 한 장만 더 찍으면 돼요.') + '</p>' +
    got + detail +
    '<div class="vbtns">' + againBtn() + '</div>' +
    escapeHatches() + '</div>';
  wire();
}

// 두 번째도 실패 — **"못 알아봤어요"로 끝낸다. 비슷한 걸 대신 보여주지 않는다.**
function renderGiveUp() {
  panel().innerHTML = '<div class="vbox vfail">' +
    '<div class="vhead">😕 ' + T('vision.giveup', '못 알아봤어요') + '</div>' +
    '<p class="muted" style="margin:0">' + T('vision.giveup.note',
      '사진 두 장으로도 무엇인지 확실하지 않아요. <b>확실하지 않은 검색어를 대신 내놓지 않을게요</b> — 엉뚱한 상품으로 데려갈 수 있어서요.') + '</p>' +
    '<div class="vbtns">' + againBtn() + '</div>' +
    escapeHatches() + '</div>';
  wire();
}

// 오류 — **추측한 검색어를 대신 내놓지 않는다**(조사 8장 마지막 줄).
const ERR_COPY = {
  'no-key':                 ['vision.err.nokey',  '사진으로 찾기가 아직 켜져 있지 않아요.'],
  // 키가 망가져 있는 경우. 워커의 상세 문구는 운영자용이라 사용자에겐 안 보여준다.
  'bad-key':                ['vision.err.nokey',  '사진으로 찾기가 아직 켜져 있지 않아요.'],
  'gemini-tier-unconfirmed':['vision.err.nokey',  '사진으로 찾기가 아직 켜져 있지 않아요.'],
  'no-worker':              ['vision.err.nokey',  '사진으로 찾기가 아직 켜져 있지 않아요.'],
  'network':                ['vision.err.net',    '연결이 안 돼요. 잠시 뒤 다시 눌러 주세요.'],
  'too-large':              ['vision.err.big',    '사진이 너무 커요. 다시 찍어 주세요.'],
  'daily-cap':              ['vision.err.cap',    '오늘은 여기까지예요 — 하루 {n}장까지만 쓸 수 있어요. 상품명을 직접 입력하면 계속 쓸 수 있어요.'],
  'too-small':              ['vision.err.small',  '사진이 너무 작아서 글씨를 읽을 수 없어요. 다시 찍어 주세요.'],
  'read-failed':            ['vision.err.read',   '사진을 읽지 못했어요. 다시 찍어 주세요.'],
};
function renderError(code, extra) {
  const e = ERR_COPY[code];
  const msg = e ? T(e[0], e[1]) : T('vision.err.generic', '지금은 안 돼요. 잠시 뒤 다시 눌러 주세요.');
  panel().innerHTML = '<div class="vbox vfail">' +
    '<div class="vhead">😕 ' + esc(msg.replace('{n}', String(DAILY_CAP))) + '</div>' +
    (extra ? '<p class="muted" style="margin:0">' + esc(extra) + '</p>' : '') +
    '<div class="vbtns">' + againBtn() + '</div>' +
    escapeHatches() + '</div>';
  wire();
}

// 흐림 경고 — **막지 않는다.** 임계값이 측정된 값이 아니라서(위 MIN_LAPLACIAN_VAR 주석).
function renderBlurry(onSend) {
  panel().innerHTML = '<div class="vbox vfail">' +
    '<div class="vhead">📷 ' + T('vision.blur', '조금 흔들린 것 같아요') + '</div>' +
    '<p class="muted" style="margin:0">' + T('vision.blur.note',
      '글씨가 읽히게 <b>조금 더 가까이서</b> 한 장 더 찍으면 훨씬 잘 찾아요. 그래도 이대로 보낼 수 있어요.') + '</p>' +
    '<div class="vbtns">' + againBtn() +
    '<button class="mini" id="visionSendAnyway" type="button">' + T('vision.blur.send', '그래도 보내기') + '</button></div></div>';
  wire();
  const b = document.getElementById('visionSendAnyway');
  if (b) b.addEventListener('click', onSend);
}

function renderLinks(query) {
  const box = document.getElementById('visionLinks');
  if (!box) return;
  const links = buildSearchLinks(query);
  if (!links.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="vlinks">' + links.map(l =>
    '<a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' +
    esc(l.name) + T('vision.link.suffix', '에서 찾기') + '</a>').join('') + '</div>';
}

// ⭐ v0.32 — 검색어가 정해지면 **판매처 비교로 바로 넘긴다.**
// 예전엔 여기서 검색 링크 4개를 그리고 끝냈는데, 그러면 사용자가 판매처를 열고 URL 을 복사해
// 붙여넣어야 결론이 나온다 — **매장에 서서 그걸 할 사람은 없다.**
// 계산기(index.html)가 있으면 그쪽 applyRecognizedProduct() 가 판매처 칸을 만들고 캐시백 %까지
// 채운다. 계산기가 없으면(단독 테스트·하니스) 예전처럼 링크만 그린다 — 이 파일은 혼자서도 돌아야 한다.
function runSearch(query) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return;
  try {
    if (typeof applyRecognizedProduct === 'function') {
      const r = applyRecognizedProduct(q, {});
      if (r && r.ok) { renderHandoff(q, r); return; }
    }
  } catch (e) { /* 계산기 쪽이 실패하면 아래 링크 경로로 물러난다 */ }
  renderLinks(q);
}

// 넘긴 뒤의 화면 — 판매처 칸에 링크가 이미 들어가 있으므로 여기서 또 링크를 나열하지 않는다.
function renderHandoff(q, r) {
  panel().innerHTML = '<div class="vbox">' +
    '<div class="vhead">✅ ' + T('vision.handoff', '아래에 판매처 {n}곳을 만들었어요').replace('{n}', String(r.n)) + '</div>' +
    '<p class="muted" style="margin:0"><code>' + esc(q) + '</code></p>' +
    '<p class="cpp-note" style="margin:8px 0 0">' + T('vision.handoff.note',
      '판매처마다 <b>가격 보기</b>로 확인하고 가격만 넣으면 순위가 나와요. 검색어가 틀렸으면 다시 찍어 주세요.') + '</p>' +
    '<div class="vbtns">' + againBtn() + '</div></div>';
  wire();
}

function wire() {
  const again = document.getElementById('visionAgain');
  if (again) again.addEventListener('click', () => {
    const inp = document.getElementById('visionFile');
    if (inp) inp.click();
  });
  const q = document.getElementById('visionQ');
  const go = document.getElementById('visionGo');
  // ⭐ 검색을 자동 실행하지 않는다 — 누를 때만 링크가 생긴다(조사 9장 #2).
  // ⭐ 검색을 자동 실행하지 않는다 — 누를 때만 넘어간다(조사 9장 #2). 그건 그대로다.
  if (go && q) go.addEventListener('click', () => runSearch(q.value));
  if (q) q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runSearch(q.value); } });
  panel().querySelectorAll('input[name="vAlt"]').forEach(el => {
    el.addEventListener('change', () => {
      const box = document.getElementById('visionQ');
      if (box) { box.value = el.getAttribute('data-q') || ''; box.focus(); }
      const links = document.getElementById('visionLinks');
      if (links) links.innerHTML = '';       // 후보를 바꾸면 이전 링크를 지운다
    });
  });
}

// ============================================================================
// 5. 진입점 — index.html 의 글루가 부르는 것
// ============================================================================

// 첫 사진을 들고 있다가 두 번째와 함께 보낸다(조사 6-C: "두 번째 사진은 첫 번째와
// 함께 한 요청으로 보낸다" — 첫 장에 전체 모양이, 둘째 장에 글자가 있으므로).
let held = [];        // base64 목록
let attempts = 0;     // 0 → 첫 장, 1 → 되묻기 후 둘째 장. 2 에서 끝낸다.

export function resetVision() { held = []; attempts = 0; }

async function send(list) {
  renderBusy(list.length);
  const r = await askVision(list);
  if (!r.ok) { renderError(r.errorCode, r.error); return; }
  attempts++;
  if (needsReask(r)) {
    if (attempts >= 2) { renderGiveUp(); resetVision(); return; }   // 세 번은 없다
    renderAsk(r, reaskReason(r));
    return;
  }
  renderResult(r);
  resetVision();
}

export async function handleFile(file) {
  if (!file) return;

  const store = (() => { try { return window.localStorage; } catch (e) { return null; } })();
  if (store && dayCount(store, todayStr()) >= DAILY_CAP) { renderError('daily-cap'); return; }

  let prep;
  try { prep = await prepareImage(file); }
  catch (e) { renderError('read-failed', (e && e.message) || ''); return; }

  const verdict = precheck(prep.longEdge, prep.lapVar);
  if (verdict === 'too-small') { renderError('too-small'); return; }

  const list = held.concat([prep.b64]);
  const go = () => {
    if (store) bumpDay(store, todayStr());
    held = list;
    send(list);
  };
  // 흐림은 막지 않고 되돌린다 — **안 보내면 돈이 안 든다**(조사 6-B-2). 그래도 보낼 수 있다.
  if (verdict === 'blurry' && attempts === 0) { renderBlurry(go); return; }
  go();
}

// 하니스(브라우저 콘솔)가 순수 로직을 집어갈 수 있게 열어둔다.
// ⚠️ 이름을 바꾸면 site/tests/negcontrol-vision.js 의 변형 문자열도 같이 고칠 것.
if (typeof window !== 'undefined') window.__vision = {
  buildSearchLinks, askText, needsReask, reaskReason, guessedLine, shapeResult,
  precheck, laplacianVar, dayCount, bumpDay, todayStr,
  SEARCH_STORES, ASK_COPY, DAILY_CAP, MIN_LONG_EDGE, MIN_LAPLACIAN_VAR, LONG_EDGE, JPEG_QUALITY,
};
