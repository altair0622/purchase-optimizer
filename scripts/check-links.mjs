/* 포털 링크 전수 검증 — 계산기가 내보내는 4개 포털 링크가 실제로 열리는지 확인한다.
 *
 * 왜 필요한가 (2026-08-12):
 *   계산기는 포털 링크 슬러그를 판매처 *이름*에서 자동 생성한다(`slug(name)`).
 *   그런데 포털들의 슬러그엔 규칙이 없다 — Rakuten은 west-elm처럼 대시를 쓰기도 하고
 *   potterybarn처럼 붙이기도 한다. 그래서 자동 생성은 구조적으로 틀릴 수밖에 없고,
 *   실제로 12곳이 죽은 링크였다(Old Navy는 홈으로 리다이렉트, Ulta의 TCB는 404).
 *   "어느 링크로 들어가라"가 이 도구의 핵심 산출물이므로, 링크는 추측이 아니라
 *   실측으로 관리한다.
 *
 * 사용법:
 *   node scripts/check-links.mjs              # 전 판매처 × 4포털 검증
 *   node scripts/check-links.mjs --only=rk    # 특정 포털만 (rk|tcb|cap|cbm, 쉼표로 여러 개)
 *   node scripts/check-links.mjs --store=nike # 특정 판매처만 (키 부분일치)
 *   node scripts/check-links.mjs --json=out.json
 *
 * 종료 코드: 실패가 하나라도 있으면 1 (CI에서 그대로 쓰라고).
 *
 * ⚠️ 실패 판정은 "링크가 안 열린다"까지만 한다. **미등재(그 포털에 그 상점이 없음)와
 *    슬러그 오류(있는데 주소가 틀림)는 이 스크립트가 구분하지 못한다** — 구분하려면
 *    대체 슬러그를 찾아봐야 하고, 그건 사람이 판단할 일이다. 실패 목록을 받아서
 *    scripts/probe-slug-variants.mjs 로 후보를 찾은 뒤 STORE_LIST 오버라이드에 박는다.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = new URL('../index.html', import.meta.url);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_BODY = 120_000;   // 제목만 보면 되므로 앞부분만 읽고 끊는다 (CapOne 페이지는 ~1MB)
const GAP_MS = 320;         // 같은 호스트에 몰리지 않게 — 판매처마다 4개 호스트를 번갈아 친다

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const ONLY = argv.only ? String(argv.only).split(',') : ['rk', 'tcb', 'cap', 'cbm'];

// ===== 계산기와 동일한 슬러그 규칙 (index.html 에서 STORE_LIST 를 그대로 읽어온다) =====
const slug = s => (s || '').toLowerCase().replace(/&/g, 'and').replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const normStore = s => (s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

function loadStores() {
  const html = readFileSync(SRC, 'utf8');
  const m = html.match(/const STORE_LIST\s*=\s*(\[[\s\S]*?\n\];)/);
  if (!m) throw new Error('index.html 에서 STORE_LIST 를 못 찾았어 — 상수 이름이 바뀌었나?');
  const list = eval(m[1].replace(/;\s*$/, ''));           // 파일 안의 배열 리터럴 그대로
  const out = {};
  for (const e of list) {
    const [name, cat, o = {}] = e;
    const k = o.key || normStore(name);
    if (out[k]) continue;                                  // 계산기와 동일한 중복 가드
    const s = slug(name);
    // ⚠️ 계산기와 **똑같은 규칙**이어야 한다. 처음엔 `o.rk || s` 로 짰다가 두 군데서 틀렸다:
    //   ① 명시적 null(= 그 포털에 미등재라고 확인해둔 것)을 슬러그로 되살려서, 링크를 만들지도
    //      않는 곳을 계속 '실패'로 셌다.
    //   ② cap 에 `.com` 을 덧붙여 bedbathandbeyond.com.com 을 만들어 8건을 허위 실패로 냈다.
    const pick = (f) => (f in o) ? o[f] : s;
    out[k] = { key: k, name, cat, cbm: pick('cbm'), rk: pick('rk'), tcb: pick('tcb'), cap: o.cap || (k + '.com') };
  }
  return Object.values(out);
}

// ===== 가져오기 (앞부분만) =====
async function head(url) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
      redirect: 'follow', signal: ctrl.signal,
    });
    let body = '';
    if (res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let n = 0;
      while (n < MAX_BODY) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        body += dec.decode(value, { stream: true });
      }
      reader.cancel().catch(() => {});
    }
    return { status: res.status, url: res.url, body };
  } catch (e) {
    return { status: 0, url, body: '', err: String(e && e.message || e) };
  } finally { clearTimeout(tm); }
}
const titleOf = b => { const m = b.match(/<title[^>]*>([^<]*)</i); return m ? m[1].replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").trim() : ''; };

// 착지한 페이지가 정말 그 상점인지 — 이름의 의미 있는 토큰이 제목에 있는지 본다.
// 느슨하게 본다(브랜드 표기가 조금씩 다르므로). 불일치는 실패가 아니라 '확인 필요'.
const STOP = new Set(['the', 'and', 'com', 'inc', 'co', 'shop', 'store', 'us']);
function nameMatches(name, title) {
  const t = title.toLowerCase();
  const toks = name.toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w));
  if (!toks.length) return true;
  if (toks.some(w => t.includes(w))) return true;
  return t.includes(normStore(name));            // "Bath & Body Works" → "bathandbodyworks"
}

// ===== 포털별 판정 =====
// 각 판정기는 {ok, why, title} 을 돌려준다. ok=false 면 그 링크는 클릭했을 때 상점이 안 나온다.
const PORTALS = {
  rk: {
    label: 'Rakuten',
    url: t => `https://www.rakuten.com/shop/${t.rk}`,
    judge: (r, t) => {
      const title = titleOf(r.body);
      if (r.status === 0) return { ok: null, why: '요청 실패: ' + r.err, title };
      if (r.status >= 400) return { ok: false, why: `HTTP ${r.status}`, title };
      // 없는 슬러그는 홈으로 리다이렉트되고 제목이 "Rakuten: ..." 로 시작한다
      if (/^Rakuten:/i.test(title)) return { ok: false, why: '홈으로 리다이렉트(상점 없음)', title };
      if (!title) return { ok: false, why: '제목 없음', title };
      return { ok: true, why: nameMatches(t.name, title) ? '' : '⚠ 제목에 상점명이 없음 — 다른 상점에 착지했을 수 있음', title };
    },
  },
  tcb: {
    label: 'TopCashback',
    url: t => `https://www.topcashback.com/${t.tcb}/`,
    judge: (r, t) => {
      const title = titleOf(r.body);
      if (r.status === 0) return { ok: null, why: '요청 실패: ' + r.err, title };
      if (r.status >= 400) return { ok: false, why: `HTTP ${r.status}`, title };
      if (/Page not found/i.test(r.body)) return { ok: false, why: '페이지 없음', title };
      return { ok: true, why: nameMatches(t.name, title) ? '' : '⚠ 제목에 상점명이 없음', title };
    },
  },
  cap: {
    label: 'CapOne Shopping',
    url: t => `https://capitaloneshopping.com/s/${t.cap}/coupon`,
    judge: (r, t) => {
      const title = titleOf(r.body);
      if (r.status === 0) return { ok: null, why: '요청 실패: ' + r.err, title };
      if (r.status === 404 || /Page Not Found/i.test(title)) return { ok: false, why: '상점 없음(404)', title };
      if (r.status >= 400) return { ok: false, why: `HTTP ${r.status}`, title };
      return { ok: true, why: nameMatches(t.name, title) ? '' : '⚠ 제목에 상점명이 없음', title };
    },
  },
  cbm: {
    label: 'CashbackMonitor',
    url: t => `https://www.cashbackmonitor.com/cashback-store/${t.cbm}/`,
    judge: (r, t) => {
      const title = titleOf(r.body);
      if (r.status === 0) return { ok: null, why: '요청 실패: ' + r.err, title };
      if (r.status >= 400) return { ok: false, why: `HTTP ${r.status}`, title };
      // ⚠️ 없는 슬러그에도 200 + 슬러그를 그대로 박은 제목을 준다.
      //    다만 값이 비어 "X Cashback () Miles/Points Reward ()" 꼴이 되므로 그걸로 가른다.
      const m = title.match(/Cashback\s*\(([^)]*)\)/i);
      if (m && !m[1].trim()) return { ok: false, why: '빈 페이지(상점 없음)', title };
      if (!/Cashback/i.test(title)) return { ok: false, why: '예상과 다른 페이지', title };
      return { ok: true, why: nameMatches(t.name, title) ? '' : '⚠ 제목에 상점명이 없음', title };
    },
  },
};

// ===== 실행 =====
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stores = loadStores().filter(s => !argv.store || s.key.includes(String(argv.store)));
const keys = ONLY.filter(k => PORTALS[k]);
console.log(`판매처 ${stores.length}곳 × 포털 ${keys.length}개 = ${stores.length * keys.length}건 검증\n`);

const results = [];
let done = 0;
for (const t of stores) {
  const row = { key: t.key, name: t.name };
  for (const k of keys) {
    const p = PORTALS[k];
    // 슬러그가 null = "그 포털에 없다"고 이미 확인해 링크를 만들지 않는 곳 → 요청하지 않는다.
    // 이건 실패가 아니라 선언이다. (요청을 보내면 당연히 실패하고, 그걸 세면 영원히 안 줄어든다.)
    if (t[k] == null) { row[k] = { slug: null, url: null, ok: null, declared: true, why: '미등재로 선언됨', title: '' }; continue; }
    const url = p.url(t);
    let v = p.judge(await head(url), t);
    // 한 번 실패했다고 바로 실패로 적지 않는다 — Rakuten 은 정상 상점에도 간헐적으로 홈을 준다
    // (Kohl's 가 3회 중 1회 그랬다). 오탐 하나가 CI 를 빨갛게 만들면 아무도 안 보게 된다.
    if (v.ok === false) { await sleep(1500); v = p.judge(await head(url), t); }
    row[k] = { slug: t[k], url, ...v };
    await sleep(GAP_MS);
  }
  results.push(row);
  done++;
  const bad = keys.filter(k => row[k].ok === false);
  const warn = keys.filter(k => row[k].ok && row[k].why);
  const decl = keys.filter(k => row[k].declared);
  const mark = bad.length ? '❌ ' + bad.map(k => PORTALS[k].label + '(' + row[k].why + ')').join(', ')
            : warn.length ? '⚠️  ' + warn.map(k => PORTALS[k].label).join(', ')
            : decl.length ? '✅ (미등재 선언 ' + decl.length + ')'
            : '✅';
  console.log(`[${String(done).padStart(3)}/${stores.length}] ${t.name.padEnd(24)} ${mark}`);
}

// ===== 요약 =====
console.log('\n===== 포털별 요약 =====');
const summary = {};
for (const k of keys) {
  const ok = results.filter(r => r[k].ok === true).length;
  const bad = results.filter(r => r[k].ok === false);
  const declared = results.filter(r => r[k].declared).length;
  const err = results.filter(r => r[k].ok === null && !r[k].declared).length;
  summary[k] = { ok, fail: bad.length, declared, err };
  console.log(`${PORTALS[k].label.padEnd(16)} 정상 ${String(ok).padStart(3)} · 실패 ${String(bad.length).padStart(3)} · 미등재선언 ${String(declared).padStart(3)} · 요청오류 ${err}`);
}
console.log('\n===== 실패 목록 =====');
let failCount = 0;
for (const k of keys) {
  const bad = results.filter(r => r[k].ok === false);
  if (!bad.length) continue;
  console.log(`\n[${PORTALS[k].label}] ${bad.length}곳`);
  for (const r of bad) { failCount++; console.log(`  ${r.name.padEnd(24)} slug=${String(r[k].slug).padEnd(24)} ${r[k].why}`); }
}
const warns = [];
for (const k of keys) for (const r of results) if (r[k].ok === true && r[k].why) warns.push(`  [${PORTALS[k].label}] ${r.name} — ${r[k].why} (제목: ${r[k].title.slice(0, 70)})`);
if (warns.length) { console.log(`\n===== 확인 필요(열리긴 함) ${warns.length}건 =====`); console.log(warns.join('\n')); }

if (argv.json) { writeFileSync(String(argv.json), JSON.stringify({ checkedAt: new Date().toISOString().slice(0, 10), summary, results }, null, 1)); console.log(`\n→ ${argv.json}`); }
console.log(`\n총 실패 ${failCount}건`);
process.exit(failCount ? 1 : 0);
