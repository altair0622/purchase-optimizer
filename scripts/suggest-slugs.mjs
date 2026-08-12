/* 죽은 포털 링크의 '정답 슬러그'를 찾는다 — 추측이 아니라 포털이 직접 공개한 목록에서.
 *
 * 배경: check-links.mjs 는 "이 링크가 열리나"까지만 판정한다. 실패했을 때
 *   ① 그 포털에 상점이 아예 없다(미등재 → 오버라이드 없이 null 이 정답)
 *   ② 상점은 있는데 주소가 틀렸다(슬러그 오류 → 오버라이드로 고쳐야 함)
 * 를 구분하려면 그 포털의 전체 상점 목록이 필요하다. 둘 다 사이트맵으로 공개하고 있다.
 *   Rakuten     robots.txt → sitemap-index.xml → merchant_sitemap.xml  (약 4,700개)
 *   TopCashback robots.txt → sitemap.xml                                (약 9,800개)
 * CapOne Shopping·CashbackMonitor 는 상점 사이트맵을 안 열어서 여기선 못 다룬다.
 *
 * 사용법:
 *   node scripts/suggest-slugs.mjs                  # 전 판매처에 대해 사이트맵 대조
 *   node scripts/suggest-slugs.mjs --fails=link-check.json   # 실패한 것만
 *
 * 출력: 판매처마다 [상태, 현재 슬러그, 추천 슬러그, 후보들].
 *   MATCH   = 지금 슬러그가 목록에 있음 (정상)
 *   FIX     = 지금 건 없고 다른 슬러그가 그 브랜드로 보임 → 오버라이드 권장
 *   ABSENT  = 목록 어디에도 없음 → 그 포털엔 미등재. 링크를 만들지 말 것
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SRC = new URL('../index.html', import.meta.url);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const argv = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));

const slug = s => (s || '').toLowerCase().replace(/&/g, 'and').replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const normStore = s => (s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const bare = s => (s || '').replace(/[^a-z0-9]/g, '');   // 슬러그에서 대시 제거 → 비교용

function loadStores() {
  const html = readFileSync(SRC, 'utf8');
  const m = html.match(/const STORE_LIST\s*=\s*(\[[\s\S]*?\n\];)/);
  if (!m) throw new Error('STORE_LIST 를 못 찾았어');
  const out = {};
  for (const e of eval(m[1].replace(/;\s*$/, ''))) {
    const [name, cat, o = {}] = e;
    const k = o.key || normStore(name);
    if (out[k]) continue;
    const s = slug(name);
    out[k] = { key: k, name, rk: o.rk || s, tcb: o.tcb || s };
  }
  return Object.values(out);
}

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

// ===== 포털 상점 목록 =====
async function rakutenSlugs() {
  const xml = await get('https://www.rakuten.com/merchant_sitemap.xml');
  return new Set([...xml.matchAll(/rakuten\.com\/shop\/([a-z0-9._-]+)/gi)].map(m => m[1].toLowerCase()));
}
async function tcbSlugs() {
  const xml = await get('https://www.topcashback.com/sitemap.xml');
  // 상점 페이지는 최상위 한 칸(/nike/). 회사 페이지도 같은 모양이라 몇 개 섞이지만
  // 대조용이라 무해하다(후보로만 쓰고 최종 확인은 check-links.mjs 가 한다).
  return new Set([...xml.matchAll(/topcashback\.com\/([a-z0-9-]+)\/<\/loc>/gi)].map(m => m[1].toLowerCase()));
}

// ⚠️ 여기가 이 스크립트에서 제일 위험한 부분이다. 처음엔 "부분 일치 + 열리면 정답"으로
//    짰다가 West Elm → west-paw(반려견 용품), Michaels → michaelstars(다른 브랜드),
//    Dell → brondell(비데), B&H Photo → photobucket 을 '정답'이라고 내놨다.
//    **열리는 링크가 맞는 링크는 아니다** — 엉뚱한 상점으로 보내는 건 404보다 나쁘다.
//    그래서 자동 채택은 아래 두 가지로만 제한하고, 나머지는 전부 사람이 본다.
//      ① 이름을 정규화한 것과 슬러그가 정확히 같다 (Banana Republic → bananarepublic)
//      ② 거기에 미국/스토어를 뜻하는 접미사만 붙었다 (ASOS → asos-us)
//    -canada / -ca / -uk 같은 다른 나라판은 자동 채택하지 않는다. 요율도 대상도 다르다.
const SUFFIX_OK = ['us', 'usa', 'store', 'stores', 'shop', 'com'];
const REGION_BAD = /-(canada|ca|uk|au|de|fr|jp|eu|ie|nz|mx|in)$/;

function classify(name, s) {
  const n = normStore(name);
  const b = bare(s);
  if (b === n) return 'exact';
  if (REGION_BAD.test(s)) return 'region';
  for (const suf of SUFFIX_OK) if (b === n + suf) return 'suffix';
  return 'loose';
}
function candidates(name, set) {
  const n = normStore(name);
  const arr = [...set];
  const exact = arr.filter(s => classify(name, s) === 'exact');
  if (exact.length) return { hit: exact[0], all: exact, kind: 'exact' };
  const suffix = arr.filter(s => classify(name, s) === 'suffix');
  if (suffix.length) return { hit: suffix[0], all: suffix, kind: 'suffix' };
  // 여기서부터는 후보일 뿐 정답이 아니다 — 제목을 보고 사람이 고른다
  const toks = name.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4);
  const loose = arr.filter(s => {
    const b = bare(s);
    return b.startsWith(n) || n.startsWith(b) || (toks.length && toks.every(w => b.includes(w)));
  }).sort((a, b) => Math.abs(bare(a).length - n.length) - Math.abs(bare(b).length - n.length)).slice(0, 6);
  return { hit: null, all: loose, kind: 'loose' };
}

// 착지한 페이지가 그 브랜드가 맞는지 — 이름의 모든 의미 토큰이 **단어 경계로** 제목에 있어야 한다.
// (부분 문자열로 보면 "Brondell" 이 "Dell" 을 통과시킨다.)
function titleIsBrand(name, title) {
  if (!title) return false;
  const t = ' ' + title.toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  if (t.replace(/ /g, '').includes(normStore(name))) return true;
  const toks = name.toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !['the', 'and', 'com'].includes(w));
  return toks.length > 0 && toks.every(w => t.includes(' ' + w + ' '));
}

const stores = loadStores();
console.log('사이트맵 받는 중…');
const [RK, TCB] = await Promise.all([rakutenSlugs(), tcbSlugs()]);
console.log(`Rakuten ${RK.size}개 · TopCashback ${TCB.size}개 슬러그 확보\n`);

let onlyFails = null;
if (argv.fails && existsSync(String(argv.fails))) {
  const j = JSON.parse(readFileSync(String(argv.fails), 'utf8'));
  onlyFails = new Set(j.results.filter(r => (r.rk && r.rk.ok === false) || (r.tcb && r.tcb.ok === false)).map(r => r.key));
  console.log(`실패 목록 ${onlyFails.size}곳만 본다\n`);
}

// ===== 라이브 확인 =====
// ⚠️ 사이트맵에 있다고 링크가 열리는 건 아니고, 반대로 사이트맵에 없어도 열리는 게 있다
//    (Rakuten 의 amazon.com 이 그렇다). 그래서 --verify 를 붙이면 후보를 실제로 열어본다.
//    최종 판단 근거는 항상 라이브 응답이고, 사이트맵은 후보를 좁히는 용도다.
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function liveOk(portal, s) {
  const url = portal === 'rk' ? `https://www.rakuten.com/shop/${s}` : `https://www.topcashback.com/${s}/`;
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
    if (!res.ok) return { ok: false, title: '' };
    const body = (await res.text()).slice(0, 120_000);
    const title = (body.match(/<title[^>]*>([^<]*)</i) || [, ''])[1].replace(/&amp;/g, '&').trim();
    if (portal === 'rk') return { ok: !!title && !/^Rakuten:/i.test(title), title };
    return { ok: !/Page not found/i.test(body), title };
  } catch { return { ok: false, title: '' }; }
}

const report = { fix: [], absent: [], match: 0, confirmed: [] };
for (const t of stores) {
  if (onlyFails && !onlyFails.has(t.key)) continue;
  for (const [portal, set, cur] of [['rk', RK, t.rk], ['tcb', TCB, t.tcb]]) {
    if (set.has(cur)) { report.match++; continue; }
    const c = candidates(t.name, set);
    const rec = { key: t.key, name: t.name, portal, current: cur, suggest: c.hit, candidates: c.all };
    if (c.hit) { report.fix.push(rec); console.log(`FIX    ${portal.toUpperCase().padEnd(4)} ${t.name.padEnd(24)} ${cur}  →  ${c.hit}`); }
    else if (c.all.length) { report.fix.push(rec); console.log(`FIX?   ${portal.toUpperCase().padEnd(4)} ${t.name.padEnd(24)} ${cur}  →  후보: ${c.all.join(', ')}`); }
    else { report.absent.push(rec); console.log(`ABSENT ${portal.toUpperCase().padEnd(4)} ${t.name.padEnd(24)} ${cur}  (그 포털에 없음 — 링크 만들지 말 것)`); }
  }
}
console.log(`\n일치 ${report.match} · 수정 대상 ${report.fix.length} · 미등재 ${report.absent.length}`);

if (argv.verify) {
  console.log('\n===== 라이브 확인 =====');
  console.log('자동 채택 조건 = (이름 정확 일치 or 미국/스토어 접미사) **그리고** 착지 제목이 그 브랜드일 것. 둘 중 하나라도 아니면 사람이 본다.\n');
  const manual = [];
  for (const rec of report.fix) {
    const tries = [...new Set([rec.suggest, ...rec.candidates].filter(Boolean))].slice(0, 4);
    let won = null, wonTitle = '';
    for (const s of tries) {
      const kind = classify(rec.name, s);
      if (kind !== 'exact' && kind !== 'suffix') continue;      // 느슨한 후보는 자동 채택 금지
      const r = await liveOk(rec.portal, s);
      await sleep(300);
      if (!r.ok) continue;
      if (!titleIsBrand(rec.name, r.title)) {                    // 열려도 다른 브랜드면 버린다
        manual.push({ ...rec, tried: s, title: r.title, why: '제목이 다른 브랜드' });
        continue;
      }
      won = s; wonTitle = r.title; break;
    }
    if (won) {
      console.log(`✅ FIX  ${rec.portal.toUpperCase().padEnd(4)} ${rec.name.padEnd(24)} ${rec.current}  →  ${won}   [${wonTitle.slice(0, 45)}]`);
      rec.verdict = 'fix'; rec.verified = won; rec.title = wonTitle; report.confirmed.push(rec);
      continue;
    }
    // 지금 슬러그가 사이트맵엔 없어도 실제로 열릴 수 있다 — 그러면 고칠 게 없다
    const cur = await liveOk(rec.portal, rec.current);
    await sleep(300);
    if (cur.ok && titleIsBrand(rec.name, cur.title)) {
      console.log(`OK     ${rec.portal.toUpperCase().padEnd(4)} ${rec.name.padEnd(24)} ${rec.current} (사이트맵엔 없지만 정상 — 그대로 둘 것)`);
      rec.verdict = 'already-works';
    } else {
      const cands = rec.candidates.filter(s => !['exact', 'suffix'].includes(classify(rec.name, s)));
      console.log(`❓ 사람  ${rec.portal.toUpperCase().padEnd(4)} ${rec.name.padEnd(24)} 자동 채택 불가 — 후보: ${cands.join(', ') || '없음'}`);
      rec.verdict = 'manual'; manual.push({ ...rec, why: '자동 채택 조건 불충족' });
    }
  }
  report.manual = manual;
  console.log(`\n자동 확정 ${report.confirmed.length}건 · 사람이 봐야 할 것 ${manual.length}건`);
  console.log('\n===== STORE_LIST 오버라이드(자동 확정분만, 복사용) =====');
  const byStore = {};
  for (const r of report.confirmed) (byStore[r.name] ||= {})[r.portal] = r.verified;
  for (const [name, o] of Object.entries(byStore)) {
    console.log(`  ${name}: ${Object.entries(o).map(([k, v]) => `${k}:"${v}"`).join(',')}`);
  }
}
if (argv.json) { writeFileSync(String(argv.json), JSON.stringify(report, null, 1)); console.log(`→ ${argv.json}`); }
