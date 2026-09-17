// 포털(Rakuten · TopCashback · BeFrugal) 공개 페이지에서 캐시백 기본율을 읽는 **공용 파서**.
//
// 왜 따로 뺐나: `update-rates.mjs`(매일 rates.json 갱신)와 `probe-rates.mjs`(요율이 언제
// 바뀌는지 재는 측정)가 **같은 파싱 규칙**을 써야 한다. 복사하면 두 벌이 갈라진다 —
// 이 프로젝트는 슬러그를 두 군데 적었다가 이미 한 번 사고를 냈다(dsw·lenovo 를 '미등재'로
// 몇 주 적어뒀는데 실제로는 슬러그가 -us 형태였을 뿐이었다). 같은 사실을 두 군데 적으면
// 반드시 갈라진다.
//
// ⚠️ `update-rates.mjs` 를 그냥 import 할 수는 없다 — 그 파일은 최상위에서 **rates.json 을
//    써버린다.** import 하는 순간 라이브 데이터가 덮인다. 그래서 파서만 여기로 옮기고
//    양쪽이 이걸 가져다 쓴다.
//
// ⚠️ 워커(`worker/index.js`)의 `/rate` 에도 같은 규칙이 있다. 그쪽은 Cloudflare 런타임이라
//    이 파일을 import 할 수 없어서 별도로 존재한다 — **규칙이 바뀌면 세 곳을 같이 고쳐야 한다.**
//    (worker/index.js 의 parseRakuten·parseTopcashback·parseBefrugal 주석에도 같은 경고가 있다.)

import { readFileSync } from 'node:fs';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Rakuten 상점 페이지 <title> 에 요율이 실려 있다.
//   "Nike Coupons, Promo Codes & 8% Cash Back - July 2026 | Rakuten"
//   "Best Buy ... & Up to 7% Cash Back ..."   → upTo
//   "Amazon ... & $5 Cash Back ..."           → flat($ 고정)
//   "... & No Cash Back|Coupons Only ..."     → 0%
// 상점이 없으면 홈으로 리다이렉트되어 타이틀이 "Rakuten:" 으로 시작한다 → null(실패).
export function parseTitle(title) {
  if (!title) return null;
  if (/^Rakuten:/i.test(title)) return null;                       // 상점 없음(홈으로 리다이렉트)
  if (/No Cash Back|Coupons Only/i.test(title)) return { pct: 0, listed: true };
  let m = title.match(/(Up to )?(\d+(?:\.\d+)?)%\s*Cash Back/i);
  if (m) { const r = { pct: +m[2], listed: true }; if (m[1]) r.upTo = true; return r; }
  m = title.match(/\$(\d+(?:\.\d+)?)\s*Cash Back/i);               // Amazon류 $ 고정
  if (m) return { pct: null, flat: +m[1], listed: true };
  return null;
}

// TopCashback 상점 페이지의 merch-offer__rate 요소 → {pct,upTo}.
// 요소가 없는데 상점 h1 이 있으면 쿠폰만 있는 0% 상점, 페이지 자체가 없으면 null(실패).
export function parseTcbHtml(html) {
  if (!html) return null;
  const m = html.match(/merch-offer__rate[^>]*>([^<]+)</i);
  if (m) {
    const r = m[1].match(/(Up to )?(\d+(?:\.\d+)?)%/i);
    if (r) { const o = { pct: +r[2], listed: true }; if (r[1]) o.upTo = true; return o; }
  }
  if (/Page not found/i.test(html)) return null;
  if (/<h1[^>]*>[^<]*Cash Back Offers/i.test(html)) return { pct: 0, listed: true };
  return null;
}

export async function fetchHtml(url, attempt = 1) {
  try {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
      redirect: 'follow', signal: ctrl.signal,
    });
    clearTimeout(tm);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (attempt < 2) { await new Promise(r => setTimeout(r, 3000)); return fetchHtml(url, attempt + 1); }
    return null;
  }
}

export async function fetchTitle(slug) {
  const html = await fetchHtml(`https://www.rakuten.com/shop/${slug}`);
  if (!html) return null;
  const m = html.match(/<title>([^<]+)<\/title>/i);
  return m ? m[1].replace(/&amp;/g, '&').replace(/&#x27;/g, "'") : null;
}

export async function fetchTcb(slug) {
  return parseTcbHtml(await fetchHtml(`https://www.topcashback.com/${slug}/`));
}

// BeFrugal 상점 페이지 → {pct,upTo,min,flat}.
//
// 주소는 **`/store/<slug>/` 다. `/stores/` 가 아니다** — 복수형으로 찌르면 전부 404 가 돌아오고
// 그걸 '차단됐다'로 오독하기 딱 좋다(2026-09-14에 실제로 그럴 뻔했다).
//
// 요율은 Rakuten 과 똑같이 <title> 에 실린다:
//   "Nike 10.0% Cash Back + 25  Coupons, Promo Codes & Deals"      → 10%
//   "Instacart $5.00 Cash Back + 8  Coupons, ..."                   → flat($ 고정)
//   "Crate & Barrel Cash Back + Coupons, ..."  (숫자 없음)          → 0% (등재됐으나 캐시백 없음)
//   "Today's Top Amazon Coupons & Deals"       (Cash Back 자체 없음) → 0%
//
// 🔴 **그런데 제목만 믿으면 17곳에서 틀린다.** Rakuten·TopCashback 은 카테고리별로 요율이
//    갈리면 제목에 "Up to" 를 붙여주는데, **BeFrugal 은 안 붙인다.**
//      제목: "Best Buy 4.0% Cash Back"   실제: 가전 4% · 기타 3% · **노트북 2%**
//    그래서 제목 숫자는 사실상 **천장값**이고, 그걸 확정값처럼 쓰면 결론이 낙관적으로 틀린다
//    (v0.20 "틀린 값은 없는 것보다 나쁘다"). 2026-09-14 실측: 110곳 중 17곳(15%)이 이 경우.
//
//    판정은 본문의 **부서 요율표**(cash-back-department-row)로 한다. 있으면 upTo=true 이고
//    min=부서 최소값을 같이 싣는다 → 화면이 "2%~4%" 까지 말할 수 있다(그냥 "직접 확인"보다 낫다).
//    실측 교차검증: BeFrugal 자신의 A–Z 디렉터리가 "up to 4%" 라고 적는 곳과 부서표가 있는 곳이
//    **110곳 전부 일치**했고, 제목 숫자 = 부서 최대값도 17곳 전부 일치했다.
//
// ⚠️ 본문 전체에서 %를 긁으면 안 된다 — 모든 상점 페이지에 **다른 가게 타일**(인기 상점 캐러셀)이
//    박혀 있어서 Macy's 10% 같은 남의 숫자가 딸려 온다. Amazon 페이지에서 9% 가 잡혔던 게 이것이다.

// 부서별 요율표를 **이름까지** 뽑는다.
//
// 🔴 2026-09-16 까지 우리는 이 표에서 **최소값 하나만** 꺼내 쓰고 이름을 버렸다.
//    그래서 화면이 말할 수 있는 건 "1.26%~10.1%" 뿐이었는데, 실제 표는 이렇게 적혀 있다:
//      Home Depot: Housewares 10.1% ... **Patio & Grills 1.26%**
//    그릴을 사는 사람에게 정답은 "1.26%~10.1%" 가 아니라 **1.26%** 다.
//    (그리고 Lowe's 는 부서 없이 6% 확정이라, 이름을 버리면 **더 싼 곳을 놓친다.**)
//
// ⚠️ 행의 성격이 두 가지다. 섞으면 안 된다:
//    ① 상품 카테고리 — Home Depot·Walmart·Best Buy. 상품으로 맞힐 수 있다
//    ② **사람의 상태** — Shein "신규 고객 20% / 기존 1.33%", Dell·Temu·Sam's Club.
//       이건 상품과 무관하고 우리가 알 수 없다. **추측하지 말고 보여주기만 한다.**
//    파서는 둘을 구분하지 않는다 — 구분은 화면이 한다. 여기서는 **적힌 대로** 옮긴다.
export function parseBfDepts(html) {
  const out = [];
  // 행 안에서 **값 → 이름** 순서로 나온다. 행 밖으로 새지 않도록 창을 좁게 잡는다
  // (본문 전체를 긁으면 인기 상점 캐러셀의 남의 숫자가 딸려 온다 — 아래 경고 참조).
  const re = /cash-back-department-row"[\s\S]{0,400}?cash-back-departments-value[^>]*>\s*([\d.]+)\s*%\s*<\/[^>]*>[\s\S]{0,200}?>\s*([^<>]{1,160}?)\s*</gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const p = +m[1];
    const n = m[2].replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&#x2019;/g, '\u2019')
                  .replace(/&#x2B;/g, '+').replace(/\s+/g, ' ').trim();
    if (!n || !isFinite(p)) continue;
    out.push({ n: n.slice(0, 90), p });
    if (out.length >= 30) break;           // 표가 비정상적으로 길면 거기서 끊는다
  }
  return out;
}

export function parseBfHtml(html) {
  if (!html) return null;
  const t = html.match(/<title>([^<]*)<\/title>/i);
  const title = t ? t[1].replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&#x2B;/g, '+') : '';
  if (!title || /^\s*BeFrugal\s*$/i.test(title)) return null;        // 상점 없음(404 껍데기)
  // 상점 페이지인지 확인 — 이게 없으면 파싱 실패로 보고 이전 값을 유지한다.
  // (마크업이 바뀌었는데 조용히 "0%" 로 떨어지면 '안 준다'는 거짓말이 된다.)
  if (!/<h1[^>]*>[^<]*Coupons[^<]*<\/h1>/i.test(html)) return null;

  // 부서별 요율표가 있으면 = 하나의 숫자가 없는 가게
  const depts = [...html.matchAll(/cash-back-departments-value[^>]*>\s*([\d.]+)\s*%/gi)].map(m => +m[1]);

  let m = title.match(/(\d+(?:\.\d+)?)%\s*Cash Back/i);
  if (m) {
    const r = { pct: +m[1], listed: true };
    if (depts.length) {
      r.upTo = true; r.min = Math.min(...depts);
      // ⭐ 이름까지 싣는다. min 만 남기면 "1.26%~10.1%" 밖에 못 말한다 — 어느 품목이
      //    1.26% 인지가 실제로 답을 바꾼다(Home Depot 의 Patio & Grills 가 그 1.26% 다).
      const named = parseBfDepts(html);
      if (named.length) r.depts = named;
    }
    return r;
  }
  m = title.match(/\$(\d+(?:\.\d+)?)\s*Cash Back/i);                  // Instacart 류 $ 고정
  if (m) return { pct: null, flat: +m[1], listed: true };
  return { pct: 0, listed: true };                                    // 등재됐지만 지금 캐시백 0
}

export async function fetchBf(slug) {
  return parseBfHtml(await fetchHtml(`https://www.befrugal.com/store/${slug}/`));
}

// ---------------------------------------------------------------------------
// 판매처 목록 — update-rates 와 probe-rates 가 **같은 표**를 본다
// ---------------------------------------------------------------------------
// ⚠️ 판매처 목록은 **계산기의 STORE_LIST 하나만** 본다.
// 예전엔 여기에 슬러그 표를 따로 들고 있었는데, 그 이중 관리가 곧바로 사고로 이어졌다:
// dsw·lenovo 를 'TopCashback 미등재'로 적어두고 몇 주를 보냈는데 실제로는 슬러그가
// -us 형태였을 뿐이었다(dsw-us ≤2% · lenovo-us ≤4%). 같은 사실을 두 군데 적으면
// 반드시 갈라진다 → index.html 의 STORE_LIST 를 그대로 파싱해서 쓴다.
// 슬러그는 scripts/check-links.mjs 로 실측 검증된 값이고, 명시적 null = 그 포털 미등재다.
const SRC = new URL('../index.html', import.meta.url);
const slug = s => (s || '').toLowerCase().replace(/&/g, 'and').replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const bfSlug = s => (s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');   // BeFrugal: 대시 없음
const normStore = s => (s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
export function loadStores() {
  const html = readFileSync(SRC, 'utf8');
  const m = html.match(/const STORE_LIST\s*=\s*(\[[\s\S]*?\n\];)/);
  if (!m) throw new Error('index.html 에서 STORE_LIST 를 못 찾았어 — 상수 이름이 바뀌었나?');
  const seen = new Set(), out = [];
  for (const e of eval(m[1].replace(/;\s*$/, ''))) {
    const [name, , o = {}] = e;
    const k = o.key || normStore(name);
    if (seen.has(k)) continue;                       // 계산기와 동일한 중복 가드
    seen.add(k);
    const d = slug(name);
    const pick = f => (f in o) ? o[f] : d;           // null 이면 null 그대로 (미등재)
    // BeFrugal 의 슬러그 규칙은 **대시를 쓰지 않는다**(homedepot · crateandbarrel).
    // rk/tcb 의 기본값(대시 형태)과 달라서 기본 생성기를 따로 둔다.
    const bfPick = ('bf' in o) ? o.bf : bfSlug(name);
    out.push([k, pick('rk'), pick('tcb'), bfPick]);
  }
  return out;
}
