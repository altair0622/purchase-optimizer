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
// ⚠️ 파싱 규칙은 **scripts/portal-parse.mjs 한 곳**에만 둔다.
//    probe-rates.mjs 도 같은 걸 쓴다 — 복사하면 두 벌이 갈라진다.
import { parseTitle, fetchTitle, fetchTcb } from './portal-parse.mjs';

const OUT = new URL('../rates.json', import.meta.url);

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
