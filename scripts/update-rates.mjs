// Rakuten + TopCashback 공개(비로그인) 캐시백 기본율을 긁어 rates.json을 갱신한다.
// 포털 기본율은 로그인 여부와 무관하게 모두에게 동일(타겟 부스트만 예외) → 로그인 불필요.
// 사용: node scripts/update-rates.mjs  (GitHub Actions가 매일 실행)
//
// - Rakuten 상점 페이지 <title>에 요율이 실려 있음:
//     "Nike Coupons, Promo Codes & 8% Cash Back - July 2026 | Rakuten"
//     "Best Buy ... & Up to 7% Cash Back ..."      → upTo
//     "Amazon ... & $5 Cash Back ..."              → flat ($ 고정)
//     "... & No Cash Back ..." / "... & Coupons Only ..." → 0%
//   상점이 없으면 일반 홈 타이틀("Rakuten: Shop. ...")로 리다이렉트 → 실패 처리(이전 값 유지)
// - TopCashback 상점 페이지는 class="merch-offer__rate" 요소에 요율("10% Cash Back"/"Up to 8% ...").
//   요소가 없으면(쿠폰만) 0%, 페이지 자체가 없으면 미등재.
// - Capital One Shopping은 CAPTCHA로 자동 수집을 막고 있어 여기선 갱신하지 않는다(수동/스킬 갱신).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const OUT = new URL('../rates.json', import.meta.url);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ⚠️ 판매처 목록은 **계산기의 STORE_LIST 하나만** 본다.
// 예전엔 여기에 슬러그 표를 따로 들고 있었는데, 그 이중 관리가 곧바로 사고로 이어졌다:
// dsw·lenovo 를 'TopCashback 미등재'로 적어두고 몇 주를 보냈는데 실제로는 슬러그가
// -us 형태였을 뿐이었다(dsw-us ≤2% · lenovo-us ≤4%). 같은 사실을 두 군데 적으면
// 반드시 갈라진다 → index.html 의 STORE_LIST 를 그대로 파싱해서 쓴다.
// 슬러그는 scripts/check-links.mjs 로 실측 검증된 값이고, 명시적 null = 그 포털 미등재다.
const SRC = new URL('../index.html', import.meta.url);
const slug = s => (s || '').toLowerCase().replace(/&/g, 'and').replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const normStore = s => (s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

function loadStores() {
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
const STORES = loadStores();

function parseTitle(title) {
  if (!title) return null;
  if (/^Rakuten:/i.test(title)) return null;                       // 상점 없음(홈으로 리다이렉트)
  if (/No Cash Back|Coupons Only/i.test(title)) return { pct: 0, listed: true };
  let m = title.match(/(Up to )?(\d+(?:\.\d+)?)%\s*Cash Back/i);
  if (m) { const r = { pct: +m[2], listed: true }; if (m[1]) r.upTo = true; return r; }
  m = title.match(/\$(\d+(?:\.\d+)?)\s*Cash Back/i);               // Amazon류 $ 고정
  if (m) return { pct: null, flat: +m[1], listed: true };
  return null;
}

async function fetchHtml(url, attempt = 1) {
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
async function fetchTitle(slug) {
  const html = await fetchHtml(`https://www.rakuten.com/shop/${slug}`);
  if (!html) return null;
  const m = html.match(/<title>([^<]+)<\/title>/i);
  return m ? m[1].replace(/&amp;/g, '&').replace(/&#x27;/g, "'") : null;
}
// TopCashback: merch-offer__rate 요소 텍스트 → {pct,upTo}. 요소 없고 상점 h1 있으면 0%, 페이지 없으면 null(실패).
async function fetchTcb(slug) {
  const html = await fetchHtml(`https://www.topcashback.com/${slug}/`);
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

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { stores: {} };
const out = {
  asOf: new Date().toISOString().slice(0, 10),   // Rakuten·TopCashback 갱신 날짜
  capAsOf: prev.capAsOf || '2026-07-31',          // CapOne Shopping은 수동 갱신 — 그때 이 날짜도 갱신
  source: 'rakuten.com·topcashback.com 공개 페이지(로그인 불필요, 기본율은 전 회원 동일) · CapOne Shopping은 수동(CAPTCHA)',
  stores: {},
};

const fmt = r => r.flat != null ? '$' + r.flat : (r.upTo ? '≤' : '') + r.pct + '%';
let ok = 0, failed = [];
for (const [key, rkSlug, tcbSlug] of STORES) {
  // 슬러그가 null = 그 포털에 없다고 실측한 곳 → 요청하지 않고 '미등재'로 기록한다.
  // (요청해봐야 실패하고, 그걸 '실패'로 세면 영원히 줄지 않는다. shop/null 을 찌르지도 않는다.)
  const rk = rkSlug ? parseTitle(await fetchTitle(rkSlug)) : { pct: null, listed: false };
  const tcb = tcbSlug ? await fetchTcb(tcbSlug) : { pct: null, listed: false };
  const prevStore = (prev.stores && prev.stores[key]) || {};
  out.stores[key] = {
    rk: rk || prevStore.rk || { pct: null, listed: true },          // 실패 시 이전 값 유지
    cap: prevStore.cap || { pct: null, listed: true },              // CapOne Shopping은 이전 값 그대로
    tcb: tcb || prevStore.tcb || { pct: null, listed: true },
  };
  const show = r => !r ? 'FAIL' : (r.listed === false ? '미등재' : fmt(r));
  if (rk || tcb) { ok++; console.log(`  ${key}: RK ${show(rk)} · TCB ${show(tcb)}`); }
  else { failed.push(key); console.log(`  ${key}: 둘 다 FAILED — 이전 값 유지`); }
  await new Promise(r => setTimeout(r, 500));
}

if (ok === 0) { console.error('전부 실패 — rates.json을 건드리지 않고 종료'); process.exit(1); }
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`\nrates.json 갱신: ${ok}/${STORES.length} 성공${failed.length ? ' · 실패(이전값 유지): ' + failed.join(', ') : ''}`);
