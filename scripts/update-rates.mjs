// Rakuten 공개(비로그인) 캐시백 기본율을 긁어 rates.json을 갱신한다.
// 사용: node scripts/update-rates.mjs  (GitHub Actions가 매일 실행)
//
// - Rakuten 상점 페이지 <title>에 요율이 실려 있음:
//     "Nike Coupons, Promo Codes & 8% Cash Back - July 2026 | Rakuten"
//     "Best Buy ... & Up to 7% Cash Back ..."      → upTo
//     "Amazon ... & $5 Cash Back ..."              → flat ($ 고정)
//     "... & No Cash Back ..." / "... & Coupons Only ..." → 0%
//   상점이 없으면 일반 홈 타이틀("Rakuten: Shop. ...")로 리다이렉트 → 실패 처리(이전 값 유지)
// - Capital One Shopping은 CAPTCHA로 자동 수집을 막고 있어 여기선 갱신하지 않는다(수동/스킬 갱신).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const OUT = new URL('../rates.json', import.meta.url);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// key = 계산기(purchase-optimizer)의 판매처 키, slug = rakuten.com/shop/<slug>
const STORES = [
  ['crateandbarrel', 'crateandbarrel'],
  ['cb2',            'cb2'],
  ['westelm',        'west-elm'],
  ['potterybarn',    'potterybarn'],
  ['wayfair',        'wayfair'],
  ['ikea',           'ikea'],
  ['homedepot',      'homedepot'],
  ['lowes',          'lowes'],
  ['target',         'target'],
  ['walmart',        'walmart'],
  ['macys',          'macys'],
  ['amazon',         'amazon.com'],
  ['bestbuy',        'bestbuy'],
  ['apple',          'apple'],
  ['nike',           'nike'],
  ['costco',         'costco'],
  ['lululemon',      'lululemon'],
  ['sephora',        'sephora'],
  ['nordstrom',      'nordstrom'],
  ['ulta',           'ultabeauty'],
];

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

async function fetchTitle(slug, attempt = 1) {
  try {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(`https://www.rakuten.com/shop/${slug}`, {
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
      redirect: 'follow', signal: ctrl.signal,
    });
    clearTimeout(tm);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const m = html.match(/<title>([^<]+)<\/title>/i);
    return m ? m[1].replace(/&amp;/g, '&').replace(/&#x27;/g, "'") : null;
  } catch (e) {
    if (attempt < 2) { await new Promise(r => setTimeout(r, 3000)); return fetchTitle(slug, attempt + 1); }
    return null;
  }
}

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { stores: {} };
const out = {
  asOf: new Date().toISOString().slice(0, 10),   // Rakuten 갱신 날짜
  capAsOf: prev.capAsOf || '2026-07-28',          // CapOne은 수동 갱신 — 그때 이 날짜도 갱신
  source: 'rakuten.com 공개 페이지(비로그인 기본율) · CapOne Shopping은 수동',
  stores: {},
};

let ok = 0, failed = [];
for (const [key, slug] of STORES) {
  const title = await fetchTitle(slug);
  const rk = parseTitle(title);
  const prevStore = (prev.stores && prev.stores[key]) || {};
  out.stores[key] = {
    rk: rk || prevStore.rk || { pct: null, listed: true },          // 실패 시 이전 값 유지
    cap: prevStore.cap || { pct: null, listed: true },              // CapOne은 이전 값 그대로
  };
  if (rk) { ok++; console.log(`  ${key}: ${rk.flat != null ? '$' + rk.flat : rk.pct + '%'}${rk.upTo ? ' (up to)' : ''}`); }
  else { failed.push(key); console.log(`  ${key}: FAILED (${title || 'no title'}) — 이전 값 유지`); }
  await new Promise(r => setTimeout(r, 500));
}

if (ok === 0) { console.error('전부 실패 — rates.json을 건드리지 않고 종료'); process.exit(1); }
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`\nrates.json 갱신: ${ok}/${STORES.length} 성공${failed.length ? ' · 실패(이전값 유지): ' + failed.join(', ') : ''}`);
