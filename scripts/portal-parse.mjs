// 포털(Rakuten · TopCashback) 공개 페이지에서 캐시백 기본율을 읽는 **공용 파서**.
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
//    (worker/index.js 의 parseRakuten·parseTopcashback 주석에도 같은 경고가 있다.)

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
    out.push([k, pick('rk'), pick('tcb')]);
  }
  return out;
}
