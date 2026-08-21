/* PriceAfter — 랜덤 페르소나 퍼즈 테스트 하니스
 *
 * 목적: "사람들의 구매 선택"을 무작위로 수천 개 만들어, 계산기의 실제 코드
 *       (scenarioResult / rateInfo / recompute / computeSite)를 그대로 태워서
 *       ① 수학이 깨지는 경우 ② 화면이 깨지는 경우 ③ 결론이 이상해지는 경우를 잡는다.
 *
 * 사용법: 계산기 페이지를 http로 열고 콘솔에서
 *   fetch('tests/fuzz-personas.js').then(r=>r.text()).then(eval)
 *   __fuzz.run({n:2000, seed:42})        // 수학 퍼즈
 *   __fuzz.runDom({n:60, seed:7})        // 실제 UI 렌더 퍼즈
 * 실패 케이스 전체는 __fuzz.last 에 남는다(재현용 seed 포함).
 */
window.__fuzz = (function () {
  const EPS = 1e-6;

  // 시드 PRNG — 실패를 그대로 재현할 수 있어야 한다
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const CATS = ['general', 'online', 'dining', 'grocery', 'gas', 'drugstore', 'travel'];
  const CURR = Object.keys(CURRENCIES);

  function mk(rnd) {
    const pick = a => a[Math.floor(rnd() * a.length)];
    const chance = p => rnd() < p;
    const between = (a, b) => a + rnd() * (b - a);

    function typo(s) {
      if (s.length < 6) return s;
      const i = 1 + Math.floor(rnd() * (s.length - 2));
      return chance(0.5)
        ? s.slice(0, i) + s.slice(i + 1)                          // 글자 빠짐
        : s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2);       // 자리 바뀜
    }

    function store() {
      const r = rnd();
      if (r < 0.65) return pick(STORE_LIST)[0];                   // 등록된 판매처
      if (r < 0.80) return typo(pick(STORE_LIST)[0]);             // 오타
      if (r < 0.90) return pick(['Zappos', 'Etsy', '동네 가게', 'Some Random Shop', 'QVC']); // 미등록
      return chance(0.5) ? '' : '   ';                            // 빈칸
    }

    function price() {
      const r = rnd();
      if (r < 0.08) return pick([0, 0.99, 1, 1500, 1500.01, 6000, 6000.01, 25000, 50000, 99999]); // 경계값
      return Math.round(Math.exp(between(Math.log(5), Math.log(4000))) * 100) / 100;              // 로그균등 $5~$4,000
    }

    // 한 사람 = 지갑 + 포인트 가치관 + 이번 구매
    function persona() {
      const nCards = chance(0.06) ? 0 : 1 + Math.floor(rnd() * 6);
      const ids = CARD_CATALOG.map(c => c.id).slice();
      const wallet = [];
      for (let i = 0; i < nCards && ids.length; i++) wallet.push(ids.splice(Math.floor(rnd() * ids.length), 1)[0]);

      const cpp = {};
      CURR.forEach(code => {
        if (chance(0.35)) cpp[code] = Math.round(between(0.3, 2.4) * 100) / 100; // 직접 조정한 사람
      });

      const p = price();
      const sc = {
        store: store(),
        domain: '',
        price: p,
        ship: chance(0.35) ? Math.round(between(0, 60) * 100) / 100 : 0,
        coupon: chance(0.30) ? Math.round(between(0, p * (chance(0.1) ? 1.4 : 0.5)) * 100) / 100 : 0,
        portalPct: chance(0.55) ? Math.round(between(0, 15) * 10) / 10 : 0,
        portalName: 'Rakuten',
        offers: {},
        lastChecked: null
      };
      wallet.forEach(id => { if (chance(0.15)) sc.offers[id] = Math.round(between(5, 120)); });

      return { wallet, cpp, cat: pick(CATS), tax: chance(0.7) ? Math.round(between(0, 10) * 10) / 10 : 0, sc };
    }

    return { persona, pick, chance, between };
  }

  // 페르소나를 앱 전역 상태에 앉힌다
  function apply(p) {
    myWallet = p.wallet.slice();
    cppValues = Object.assign({}, p.cpp);
    CARDS = activeCards();
    taxPct = p.tax;
  }

  const fin = x => typeof x === 'number' && isFinite(x);

  // ===== 정답(ground truth) — 하니스가 '실명'하지 않도록 =====
  // 2026-08-11 자기감사에서 드러난 것: 아래 검사들이 없으면 rateInfo 가 배수를 전부 1로
  // 돌려주거나 cppFor 가 포인트 가치를 5¢로 조작해도 퍼즈가 **0건 실패**로 통과했다.
  // 항등식·정렬만 보면 "내부적으로 일관된 오답"을 잡을 수 없다.
  //
  // ① 손으로 계산한 골든 케이스 — 조건부 규칙(가맹처·한도·분기5%)까지 포함
  // ② 조건 없는 카드는 카탈로그에서 기대값을 독립 계산해 교차검증
  const GOLDEN = [
    { name: '현금 2% + 포털 10%', wallet: ['wfactivecash'], cat: 'online',
      sc: { store: 'Nike', price: 100, portalPct: 10 },
      want: { price: 100, best: 'wfactivecash', mult: 2, cashBack: 12, ptsVal: 0, netCash: 88, net: 88 } },

    { name: '쿠폰·세금·배송 (포털은 소계 기준)', wallet: ['doublecash'], cat: 'general', tax: 10,
      sc: { store: 'Target', price: 200, coupon: 50, ship: 15, portalPct: 5 },
      // 소계 150 → 세금 15 → 청구 180 · 카드 180*2% = 3.60 · 포털 150*5% = 7.50
      want: { price: 180, sub: 150, tax: 15, cashBack: 11.10, netCash: 168.90 } },

    { name: '포인트는 청구액을 안 줄인다', wallet: ['hilton'], cat: 'online',
      sc: { store: 'Nike', price: 500, portalPct: 0 },
      // Hilton online 3배 × 0.6¢ = 1.8% → $9 (포인트)
      want: { best: 'hilton', mult: 3, cashBack: 0, ptsVal: 9, netCash: 500, net: 491 } },

    { name: '가맹처 조건 — Amazon 카드를 Nike 에서', wallet: ['amazonchase'], cat: 'online',
      sc: { store: 'Nike', price: 200, portalPct: 0 },
      want: { mult: 1, netCash: 198, hasNote: true } },        // 5%가 아니라 1%

    { name: '가맹처 조건 — Amazon 카드를 Amazon 에서', wallet: ['amazonchase'], cat: 'online',
      sc: { store: 'Amazon', price: 200, portalPct: 0 },
      want: { mult: 5, netCash: 190 } },

    { name: '일반 한도 blended — Amex Gold 마트 $30,000', wallet: ['amexgold'], cat: 'grocery',
      sc: { store: 'Costco', price: 30000, portalPct: 0 },
      // (25,000×4배 + 5,000×1배)/30,000 = 3.5배 · ×1.1¢ = $1,155
      want: { mult: 3.5, ptsVal: 1155, netCash: 30000 } },

    { name: '오퍼가 결제액보다 크면 제외', wallet: ['wfactivecash'], cat: 'online',
      sc: { store: 'Nike', price: 50, portalPct: 0, offers: { wfactivecash: 80 } },
      want: { offer: 0, netCash: 49, hasNote: true } },

    { name: '오퍼 정상 적용', wallet: ['wfactivecash'], cat: 'online',
      sc: { store: 'Nike', price: 500, portalPct: 0, offers: { wfactivecash: 50 } },
      want: { offer: 50, cashBack: 60, netCash: 440 } },

    { name: '동점이면 확정 현금', wallet: ['freedomu', 'doublecash'], cat: 'general',
      cpp: { UR: 2 / 1.5 },   // freedomu 1.5배 × 1.333¢ = 2.0% → doublecash 2% 현금과 동점
      sc: { store: 'Target', price: 300, portalPct: 0 },
      want: { best: 'doublecash', type: 'cash', netCash: 294 } },
  ];

  // 분기 5%는 이번 분기 세트에 따라 달라지므로, 해당할 때만 검사하고 아니면 '건너뜀'으로 보고한다
  function quarterlyGolden() {
    const q = (typeof QUARTERLY !== 'undefined') && QUARTERLY && QUARTERLY.cards && QUARTERLY.cards.freedom;
    if (!q || q.cats.indexOf('gas') < 0) return null;
    return { name: '분기 5% 한도 blended — Freedom Flex 주유 $3,000', wallet: ['freedom'], cat: 'gas',
      sc: { store: 'Shell', price: 3000, portalPct: 0 },
      // (1,500×5배 + 1,500×1배)/3,000 = 3.0배 · UR 1.0¢ = $90
      want: { mult: 3, ptsVal: 90, netCash: 3000 } };
  }

  function checkGolden() {
    const out = { pass: 0, fail: [], skipped: [] };
    const cases = GOLDEN.slice();
    const qg = quarterlyGolden();
    if (qg) cases.push(qg); else out.skipped.push('분기 5% (이번 분기 세트에 freedom·주유 없음)');

    for (const g of cases) {
      myWallet = g.wallet.slice();
      cppValues = Object.assign({}, g.cpp || {});
      CARDS = activeCards();
      taxPct = g.tax || 0;
      const sc = Object.assign({ store: '', domain: '', price: 0, ship: 0, coupon: 0,
                                 portalPct: 0, portalName: '', offers: {}, lastChecked: null }, g.sc);
      let r;
      try { r = scenarioResult(sc, g.cat); }
      catch (e) { out.fail.push({ 케이스: g.name, why: 'throw: ' + e.message }); continue; }

      const got = { price: r.price, sub: r.sub, tax: r.tax, cashBack: r.cashBack, ptsVal: r.ptsVal,
                    netCash: r.netCash, net: r.net, best: r.best.c.id, mult: r.best.mult,
                    type: r.best.type, offer: r.best.offer, hasNote: !!r.best.note };
      const bad = [];
      for (const k in g.want) {
        const w = g.want[k], v = got[k];
        const same = (typeof w === 'number') ? Math.abs(v - w) < 0.005 : v === w;
        if (!same) bad.push(`${k}: 기대 ${w} / 실제 ${v}`);
      }
      if (bad.length) out.fail.push({ 케이스: g.name, why: bad.join(' · ') });
      else out.pass++;
    }
    return out;
  }

  // ② 조건 없는 카드 = 카탈로그 값이 그대로 나와야 한다 (rateInfo·cppFor 오염 탐지)
  function crossCheckRates(r, cat, bad) {
    r.rows.forEach(row => {
      const c = row.c;
      if (c.cond) return;                                        // 조건부는 골든 케이스가 담당
      const q = (typeof QUARTERLY !== 'undefined') && QUARTERLY && QUARTERLY.cards[c.id];
      if (q && q.cats.indexOf(cat) >= 0) return;                 // 분기 5% 대상도 제외
      const [wantMult, wantType] = c.rates[cat];
      if (Math.abs(row.mult - wantMult) > 1e-9) bad.push(`카탈로그 배수 불일치 ${c.id}: 기대 ${wantMult} / 실제 ${row.mult}`);
      if (row.type !== wantType) bad.push(`적립 종류 불일치 ${c.id}`);
      const wantCpp = (cppValues[wantType] != null && !isNaN(cppValues[wantType]))
        ? +cppValues[wantType] : CURRENCIES[wantType].cpp;
      if (Math.abs(row.cv - wantCpp) > 1e-9) bad.push(`포인트 가치 불일치 ${c.id}: 기대 ${wantCpp} / 실제 ${row.cv}`);
      const wantVal = r.price * wantMult * wantCpp / 100;
      if (Math.abs(row.val - wantVal) > 0.005) bad.push(`적립액 불일치 ${c.id}: 기대 ${wantVal.toFixed(2)} / 실제 ${row.val.toFixed(2)}`);
    });
  }

  // ===== 1) 수학 퍼즈 — scenarioResult 를 직접 태운다 =====
  function run(opt) {
    opt = opt || {};
    const n = opt.n || 1000, seed = opt.seed == null ? 1 : opt.seed;
    const rnd = mulberry32(seed), G = mk(rnd);
    const fails = [], stats = {
      n: 0, noCard: 0, edgeZero: 0, portalWins: 0, flipped: 0, ptsWinner: 0,
      cardWinner: {}, edgeSum: 0, edgeMax: 0, condNoted: 0, unknownStore: 0
    };

    for (let i = 0; i < n; i++) {
      const p = G.persona();
      apply(p);
      let r;
      try { r = scenarioResult(Object.assign({}, p.sc), p.cat); }
      catch (e) { fails.push({ seed, i, why: 'throw: ' + e.message, p }); continue; }

      const bad = [];
      ['price', 'sub', 'tax', 'cashBack', 'ptsVal', 'netCash', 'net', 'baselineNet', 'portalVal'].forEach(k => {
        if (!fin(r[k])) bad.push(k + '=' + r[k]);
      });
      r.rows.forEach(row => {
        if (!fin(row.mult) || !fin(row.val) || !fin(row.tot)) bad.push('row ' + row.c.id + ' mult=' + row.mult + ' val=' + row.val);
        if (row.mult < -EPS || row.mult > 12) bad.push('배수 이상 ' + row.c.id + '=' + row.mult);
        if (row.val < -EPS) bad.push('적립 음수 ' + row.c.id);
      });

      // 돌려받는 돈은 음수일 수 없다
      if (r.cashBack < -EPS) bad.push('cashBack<0');
      if (r.ptsVal < -EPS) bad.push('ptsVal<0');
      // 결제액보다 많이 돌려받을 수는 없다(오퍼는 최소사용액 조건이 붙는다) → 실부담 음수 금지
      if (r.price > 0 && r.netCash < -EPS) bad.push('실부담 음수(' + r.netCash.toFixed(2) + ') — 오퍼/캐시백이 결제액 초과');
      if (r.price > 0 && r.cashBack > r.price + EPS) bad.push('돌려받는 돈 > 결제액');
      // 회계 항등식
      if (Math.abs(r.netCash - (r.price - r.cashBack)) > 1e-6) bad.push('netCash 항등식 깨짐');
      if (Math.abs(r.net - (r.netCash - r.ptsVal)) > 1e-6) bad.push('net 항등식 깨짐');
      if (Math.abs(r.price - (r.sub + r.tax + r.ship)) > 1e-6) bad.push('청구액 항등식 깨짐');
      // 1등은 진짜 1등인가
      if (r.rows.length) {
        const mx = Math.max.apply(null, r.rows.map(x => x.tot));
        if (r.best.tot < mx - 1e-9) bad.push('best가 최댓값이 아님');
        for (let k = 1; k < r.rows.length; k++) if (r.rows[k - 1].tot < r.rows[k].tot - 1e-9) bad.push('카드표 정렬 깨짐');
      }
      // 이 도구를 쓴 결과가 "그냥 산 것"보다 나쁠 수는 없다
      const edge = r.baselineNet - r.net;
      if (edge < -1e-6) bad.push('증분이 음수(' + edge.toFixed(4) + ') — 도구가 손해 추천');
      // 카탈로그 대조 — "내부적으로 일관된 오답"을 잡는다
      crossCheckRates(r, p.cat, bad);

      // 단조성 — 오퍼는 뺀 상태로 본다.
      // 오퍼엔 최소 사용액(=문턱)이 있어서 가격/쿠폰이 문턱을 넘나들면 실부담이 계단처럼 튄다.
      // 그건 의도된 동작이므로, 여기선 연속적인 부분(카드 적립·포털·세금·배송)만 검사한다.
      //
      // ⚠️ 단조성은 '나빠지지 않았다'만 보므로 **기능이 죽어도 통과한다**(포털을 통째로
      // 무시하게 만들어도 0건 실패였다). 그래서 아래는 '정확히 이만큼 변해야 한다'로 검사한다.
      if (r.price > 0) {
        const flat = Object.assign({}, p.sc, { offers: {} });
        const b0 = scenarioResult(flat, p.cat);
        const up = scenarioResult(Object.assign({}, flat, { portalPct: (+flat.portalPct || 0) + 1 }), p.cat);
        if (up.netCash > b0.netCash + 1e-6) bad.push('포털 % 올렸는데 실부담 증가');
        // 포털 1%p = 소계의 1% — 1등 카드가 그대로면 정확히 그만큼 줄어야 한다
        if (up.best.c.id === b0.best.c.id) {
          const wantDrop = b0.sub / 100;
          const gotDrop = b0.netCash - up.netCash;
          if (Math.abs(gotDrop - wantDrop) > 0.005) {
            bad.push(`포털 1%p 반영이 틀림: 기대 -${wantDrop.toFixed(2)} / 실제 -${gotDrop.toFixed(2)}`);
          }
        }
        const cUp = scenarioResult(Object.assign({}, flat, { coupon: (+flat.coupon || 0) + 10 }), p.cat);
        if (cUp.netCash > b0.netCash + 1e-6) bad.push('쿠폰 늘렸는데 실부담 증가');
        const pUp = scenarioResult(Object.assign({}, flat, { price: (+flat.price || 0) + 50 }), p.cat);
        if (pUp.netCash < b0.netCash - 1e-6) bad.push('가격 올렸는데 실부담 감소');
        // 오퍼 $10(결제액 이내)은 현금 환급을 정확히 $10 늘려야 한다
        if (CARDS.length && b0.price > 100) {
          const id = b0.best.c.id;
          const oUp = scenarioResult(Object.assign({}, p.sc, { offers: { [id]: 10 } }), p.cat);
          if (oUp.best.c.id === id) {
            const gotGain = oUp.cashBack - b0.cashBack;
            if (Math.abs(gotGain - 10) > 0.005) bad.push(`오퍼 $10 반영이 틀림: 실제 +${gotGain.toFixed(2)}`);
          }
        }
      }

      if (bad.length) fails.push({ seed, i, why: bad.join(' | '), p, snap: snapshot(r) });

      // 통계 — "무작위 1,000명이 이 도구를 쓰면 실제로 뭘 얻나"
      stats.n++;
      if (r.best.c.id === '__none') stats.noCard++;
      else {
        stats.cardWinner[r.best.c.id] = (stats.cardWinner[r.best.c.id] || 0) + 1;
        if (r.best.type !== 'cash') stats.ptsWinner++;
      }
      if (r.portalVal > 0) stats.portalWins++;
      if (r.flipped) stats.flipped++;
      if (r.best.note) stats.condNoted++;
      if (r.price > 0 && edge < 0.005) stats.edgeZero++;
      stats.edgeSum += Math.max(0, edge);
      stats.edgeMax = Math.max(stats.edgeMax, edge);
      const fz = fuzzyStore(p.sc.store);
      if (!fz || !baselineFor(fz.key)) stats.unknownStore++;
    }
    stats.edgeAvg = stats.n ? stats.edgeSum / stats.n : 0;
    const out = { mode: 'math', seed, n, failed: fails.length, stats, sample: fails.slice(0, 12) };
    __fuzz.last = { fails, stats };
    return out;
  }

  function snapshot(r) {
    return {
      store: r.sc.store, price: r.price, sub: r.sub, cashBack: r.cashBack, pts: r.ptsVal,
      netCash: r.netCash, net: r.net, baselineNet: r.baselineNet,
      best: r.best.c.id, mult: r.best.mult, type: r.best.type
    };
  }

  // ===== 2) UI 퍼즈 — 실제 화면을 그려본다 =====
  // `[object Object]` 와 템플릿 리터럴 누출(`${...}`)이 빠져 있었다 — 둘 다 흔한 렌더 사고인데
  // 자기감사에서 일부러 만들어 넣었을 때 0건 통과했다.
  const DIRT = /NaN|undefined|Infinity|\$-0\.00|null|\[object |\$\{/;

  // ===== 언어 =====
  // v0.30 부터 화면은 한국어와 영어 두 가지로 그려진다. 하니스가 찾는 문구도 그만큼 갈린다.
  // ⚠️ 기대 문구를 앱의 STRINGS 에서 읽어오지 않는다 — 읽어오면 앱이 틀려도 하니스가 같이
  //    틀려서 동어반복이 된다(README 다섯째 사례). 여기 **손으로 적어 둔 값**이 계약이다.
  //    앱에서 이 문구를 바꾸면 이 표도 같이 고쳐야 하고, 안 고치면 시끄럽게 실패한다.
  const LIT = {
    ko: {
      net: '실제 부담', siteAmt: '결제 예상액', noStore: '(판매처?)',
      needCheck: /캐시백 % 확인 필요/, autoBest: /높은 쪽 자동 반영/, unconfirmed: /포털 캐시백 %가 미확정/,
      dirt: /실제 부담[^\n]*-\$|실제 부담-\$/,
    },
    en: {
      net: 'Net cost', siteAmt: 'Estimated charge', noStore: '(which seller?)',
      needCheck: /cashback % needs a check/, autoBest: /higher one applied automatically/,
      unconfirmed: /portal cashback % is unconfirmed/,
      dirt: /Net cost[^\n]*-\$|Net cost-\$/,
    },
  };
  // 언어를 바꾼 뒤 **전 렌더 경로를 다시 부른다.** 이게 없으면 '로드 때 만들어 두고 다시
  // 안 그리는' 자리(i18n 이관에서 실제로 물린 함정 ①)가 검사 사각지대로 남는다 — 실제로
  // 처음엔 renderCcForm() 을 빼먹어서 적립 종류 드롭다운이 '현금 캐시백 (%)' 로 남아 있었다.
  function redrawAll() {
    applyI18n(); applyBrand();
    renderWallet(); renderCcForm(); renderCppInputs(); renderCppSrc();
    renderFoldSummaries(); renderSellerSearch(); renderRefBox(); renderOfferWallet();
    buildSiteOffers(); buildAll(); recompute();
  }
  function setLangForTest(lang) { LANG = lang; redrawAll(); }
  const dirtHit = (txt, L) => (txt.match(DIRT) || txt.match(L.dirt) || [null])[0];

  // 영어 화면에 한국어가 남아 있으면 그건 **미번역 지점**이다 — i18n 이관 때 미이관 4곳을
  // 잡아낸 그 대조군을, 이번엔 하니스 안에 상시로 넣는다.
  // ⚠️ 사용자가 넣은 값은 빼고 본다. 페르소나가 '동네 가게' 같은 판매처명을 쓰는데, 그건
  //    번역 대상이 아니라 사용자 데이터라 영어 화면에도 그대로 나오는 게 맞다.
  function koLeak(txt, userStrings) {
    let t = String(txt == null ? '' : txt);
    (userStrings || []).forEach(u => { if (u && String(u).trim()) t = t.split(u).join(' '); });
    const m = t.match(/[가-힣][가-힣0-9\s·%().,'"—~$]{0,40}/);
    return m ? m[0].trim() : '';
  }
  // textContent 는 input 의 value·placeholder 를 안 본다 — 마크업에 굳어 있는 기본값
  // (예시 상품명이 실제로 그랬다)이 그 사각지대에 숨는다. 따로 훑는다.
  function koLeakFields(scope, userStrings) {
    const out = [];
    scope.querySelectorAll('input,textarea').forEach(el => {
      ['value', 'placeholder'].forEach(k => {
        const leak = koLeak(el[k], userStrings);
        if (leak) out.push(`<${el.tagName.toLowerCase()}#${el.id || '?'}> ${k}: "${leak}"`);
      });
    });
    return out;
  }

  // ⚠️ DIRT 만으로는 "아무것도 안 그려진 경우"를 못 잡는다(빈 문자열엔 오염이 없다).
  //    결론이 통째로 비어도 통과했으므로, 최소한 이만큼은 나와야 한다고 못 박는다.
  function checkRendered(where, txt, must, bad) {
    if (!txt || !txt.trim()) { bad.push(`${where}: 아무것도 렌더되지 않음`); return; }
    must.forEach(m => { if (txt.indexOf(m) < 0) bad.push(`${where}: "${m}" 가 결론에 없음`); });
    if (!/\$[\d,]/.test(txt)) bad.push(`${where}: 금액이 하나도 없음`);
  }

  // opt.lang: 'ko'(기본) | 'en'. 영어일 때는 화면에 한국어가 남는지까지 함께 본다.
  // ⚠️ 한 함수로 두 언어를 돌린다 — 영어용을 따로 복사해 두면 둘이 어긋나는 게 시간문제다
  //    (README 다섯째 사례가 정확히 그 실패다).
  function runDom(opt) {
    opt = opt || {};
    const n = opt.n || 40, seed = opt.seed == null ? 99 : opt.seed;
    const lang = opt.lang || 'ko';
    const rnd = mulberry32(seed), G = mk(rnd);
    const fails = [];
    const keep = { wallet: myWallet.slice(), cpp: Object.assign({}, cppValues), scen: scenarios.slice() };
    const L = LIT[lang];
    if (!L) throw new Error('모르는 언어: ' + lang);
    const langKeep = LANG;
    setLangForTest(lang);

    for (let i = 0; i < n; i++) {
      const p = G.persona();
      try {
        apply(p);
        // 반복 간 오염 제거 — autoApplied·lastSiteKey 가 남으면 '판매처 변경 시 기본율 교체'
        // 경로가 앞 반복 상태에 따라 달라져 재현성이 깨진다
        autoApplied = {}; lastSiteKey = undefined;
        renderCppInputs(); renderWallet(); buildSiteOffers();

        // --- 상품 모드: 판매처 2~3곳 비교
        const m = 2 + Math.floor(rnd() * 2);
        scenarios = [];
        nextId = 1;
        for (let k = 0; k < m; k++) {
          const q = G.persona();
          scenarios.push(blankScenario(q.sc));
        }
        document.getElementById('cat').value = p.cat;
        document.getElementById('taxPct').value = p.tax;
        document.getElementById('pname').value = G.chance(0.5) ? 'Test Item ' + i : '';
        buildAll();
        recompute();
        // ⚠️ 여기만 의도적으로 innerText다(다른 곳은 전부 textContent). 결론은 이 도구의 답이고
        //    **클릭 없이 보여야 한다**는 제품 불변식이라, 누가 접거나 숨기면 곧바로
        //    "아무것도 렌더되지 않음"으로 시끄럽게 실패하는 게 맞다. 접힘 대조군에서 25/25로
        //    확인했다. textContent로 "고치면" 이 감시가 사라지니 바꾸지 말 것.
        const concl = document.getElementById('finalConclusion').innerText;
        // ⚠️ compareBody는 접힌 <details>(#whyPanel) 안에 있다(v0.27 UI). innerText는 접힌 내용에
        //    빈 문자열을 주므로 검사가 통째로 헛돈다 — 접힘 상태와 무관한 textContent로 읽는다.
        const txt = concl + '\n' +
                    document.getElementById('compareBody').textContent + '\n' +
                    document.getElementById('cardbody').textContent;
        const hit = dirtHit(txt, L);
        if (hit) fails.push({ seed, i, mode: 'product', lang, why: '화면에 깨진 값', hit, excerpt: txt.slice(0, 400), p });
        // 실제로 결론이 그려졌는가 + 비교표 행 수가 가격 있는 시나리오 수와 맞는가
        const bad = [];
        // ⚠️ 기준이 두 번 바뀐 자리다. 처음엔 정가로 셌다가 오탐이 났고, 청구액(소계+세금+배송)
        //    으로 고쳤더니 이번엔 **쿠폰 ≥ 정가로 공짜가 된 판매처가 비교에서 빠지는 제품 버그**를
        //    하니스가 정상으로 인정하고 있었다. 그 버그를 고치면서(2026-08-12) recompute() 의
        //    기준이 `hasInput`(정가나 배송비를 입력했는가)이 됐으므로 여기도 같은 기준으로 센다.
        //    ⚠️ 기대값은 앱의 hasInput 을 읽어오지 않고 **여기서 독립적으로 다시 센다**.
        //       앱이 내주는 값을 그대로 쓰면 앱이 틀려도 같이 틀려서 검사가 동어반복이 된다
        //       (실제로 처음엔 그렇게 짰다가, 앱을 망가뜨려도 실패하지 않는 걸 보고 고쳤다).
        const priced = scenarios.filter(s => (+s.price || 0) > 0 || (+s.ship || 0) > 0).length;
        if (priced > 0) {
          checkRendered('상품 결론', concl, [L.net], bad);
          const rowN = document.querySelectorAll('#compareBody tr').length;
          if (rowN !== priced) bad.push(`비교표 행 수 ${rowN} ≠ 가격 있는 판매처 ${priced}`);
          // 카드 상세표(섹션 «다른 카드로 사면?»)도 검사한다. 음성 대조군에서 이 표를 통째로
          // 비우거나 접힌 <details> 안으로 옮겨도 **0건으로 침묵**했다 — DIRT만 걸려 있었고
          // 빈 문자열엔 오염이 없기 때문. 지갑이 비면 recompute가 이 카드를 숨기므로 그때는 건너뛴다.
          // textContent로 읽는 이유는 compareBody와 같다(접히면 innerText가 ''이 된다).
          if (p.wallet.length) {
            const cb = document.getElementById('cardbody');
            checkRendered('카드 상세표', cb.textContent, [], bad);
            const cardN = cb.querySelectorAll('tr').length;
            if (cardN !== p.wallet.length) bad.push(`카드 상세표 행 수 ${cardN} ≠ 지갑 카드 ${p.wallet.length}`);
          }
        }
        if (bad.length) fails.push({ seed, i, mode: 'product', why: bad.join(' | '), excerpt: concl.slice(0, 200), p });

        // --- 사이트 모드
        setMode('site');
        document.getElementById('siteStore').value = p.sc.store;
        document.getElementById('siteCat').value = p.cat;
        document.getElementById('siteAmt').value = p.sc.price;
        document.getElementById('rkPct').value = Math.round(G.between(0, 15));
        document.getElementById('tcbPct').value = Math.round(G.between(0, 15));
        document.getElementById('capPct').value = Math.round(G.between(0, 15));
        siteOffers = {};
        p.wallet.forEach(id => { if (G.chance(0.15)) siteOffers[id] = Math.round(G.between(5, 100)); });
        computeSite();
        const siteTxt = document.getElementById('siteRec').innerText;
        const st = siteTxt + '\n' + document.getElementById('portalWinner').innerText;
        const shit = dirtHit(st, L);
        if (shit) fails.push({ seed, i, mode: 'site', lang, why: '화면에 깨진 값', hit: shit, excerpt: st.slice(0, 400), p });
        const sbad = [];
        if (p.wallet.length && (+p.sc.price || 0) > 0) checkRendered('사이트 결론', siteTxt, [L.siteAmt, L.net], sbad);
        if (sbad.length) fails.push({ seed, i, mode: 'site', lang, why: sbad.join(' | '), excerpt: siteTxt.slice(0, 200), p });

        // --- 영어 렌더: 화면에 한국어가 남아 있으면 미번역이다 ---
        if (lang === 'en') {
          // 사용자가 넣은 값(판매처명·상품명)은 한국어여도 정상이다 — 빼고 본다.
          const mine = scenarios.map(sc2 => sc2.store)
            .concat([p.sc.store, document.getElementById('siteStore').value,
                     document.getElementById('pname').value]);
          const kbad = [];
          [['결론', concl], ['비교표', document.getElementById('compareBody').textContent],
           ['카드 상세표', document.getElementById('cardbody').textContent],
           ['사이트 결론', siteTxt], ['포털 비교', document.getElementById('portalWinner').textContent],
           ['페이지 전체', document.querySelector('.wrap').textContent],
          ].forEach(([where, tx]) => {
            const leak = koLeak(tx, mine);
            if (leak) kbad.push(`${where}에 한국어가 남음: "${leak}"`);
          });
          koLeakFields(document.querySelector('.wrap'), mine)
            .forEach(m => kbad.push('입력칸에 한국어가 남음: ' + m));
          if (kbad.length) fails.push({ seed, i, mode: 'en', lang, why: kbad.join(' | '), p });
        }
        setMode('product');
      } catch (e) {
        fails.push({ seed, i, why: 'throw: ' + e.message, stack: (e.stack || '').split('\n').slice(0, 3).join(' / '), p });
      }
    }

    myWallet = keep.wallet; cppValues = keep.cpp; scenarios = keep.scen;
    CARDS = activeCards();
    setLangForTest(langKeep);
    const out = { mode: 'dom', lang, seed, n, failed: fails.length, sample: fails.slice(0, 10) };
    __fuzz.lastDom = fails;
    return out;
  }
  // 영어 렌더 퍼즈 — runDom 과 같은 코드, 언어만 다르다.
  function runDomEn(opt) { return runDom(Object.assign({}, opt, { lang: 'en' })); }

  // ===== 3) 결론 정합성 — "화면이 말하는 1위"가 정말 실부담 최저인가 =====
  function runCompare(opt) {
    opt = opt || {};
    const n = opt.n || 100, seed = opt.seed == null ? 3 : opt.seed;
    const rnd = mulberry32(seed), G = mk(rnd);
    const fails = [];
    const keep = { wallet: myWallet.slice(), cpp: Object.assign({}, cppValues), scen: scenarios.slice() };
    // 이 검사는 화면 문구를 한국어로 대조한다(LIT.ko) — 언어를 고정해 둔다.
    const langKeep = LANG; setLangForTest('ko');

    for (let i = 0; i < n; i++) {
      const p = G.persona();
      apply(p); renderCppInputs(); renderWallet();
      const m = 2 + Math.floor(rnd() * 3);
      scenarios = []; nextId = 1;
      for (let k = 0; k < m; k++) {
        const q = G.persona();
        // 오퍼가 결제액을 넘는 비현실 케이스는 제외(별건으로 이미 잡음)
        Object.keys(q.sc.offers).forEach(id => { if (q.sc.offers[id] > q.sc.price * 0.5) delete q.sc.offers[id]; });
        q.sc.store = (q.sc.store || '').trim() || ('가게' + k);
        scenarios.push(blankScenario(q.sc));
      }
      document.getElementById('cat').value = p.cat;
      document.getElementById('taxPct').value = p.tax;
      buildAll(); recompute();

      // ⚠️ 이 필터는 recompute() 의 순위 필터와 **글자 그대로 같아야** 한다(현재 `r.hasInput`).
      //    한때 여기만 `r.price > 0` 으로 남아 있었다. 쿠폰 ≥ 정가 버그가 고쳐지면서 제품은
      //    청구액 $0 인 판매처도 정상적으로 1위에 올리게 됐는데, 하니스의 '정답'에서는 그 행이
      //    빠져 있어서 **정상 동작이 6건의 실패로 보고됐다**(seed 2026). 제품 버그가 아니라
      //    낡은 하니스였다. 제품 필터를 바꾸면 이 줄도 반드시 같이 바꿀 것.
      const res = scenarios.map(sc => scenarioResult(sc, p.cat)).filter(r => r.hasInput);
      if (!res.length) continue;
      const truth = res.slice().sort((a, b) => a.net - b.net)[0];
      const firstRow = document.querySelector('#compareBody tr');
      // textContent — 비교표는 접힌 <details> 안이라 innerText면 항상 ''이 된다(위 주석 참조)
      const shown = firstRow ? firstRow.querySelector('td b').textContent.replace(/^\d+\.\s*/, '') : null;
      const badge = document.querySelector('#finalConclusion .savebadge');

      // 동점이면 '검사 생략'이 아니라 **동점 그룹 안에 있는가**로 본다.
      // 예전엔 동점이면 두 검사를 통째로 건너뛰어서, 모든 net 을 같게 만들면
      // 60건이 전부 조용히 통과했다(아무것도 검증하지 않은 채로).
      const tied = res.filter(r => Math.abs(r.net - truth.net) < 0.005);
      const tiedNames = tied.map(r => r.sc.store || LIT.ko.noStore);
      if (shown === null) {
        fails.push({ seed, i, why: '가격 있는 판매처가 있는데 비교표가 비었다', nets: res.map(r => [r.sc.store, +r.net.toFixed(2)]) });
      } else if (tiedNames.indexOf(shown) < 0) {
        fails.push({ seed, i, why: `비교표 1위(${shown}) 가 실부담 최저 그룹(${tiedNames.join('·')}) 밖`,
                     nets: res.map(r => [r.sc.store, +r.net.toFixed(2)]) });
      }
      // 배지 검사 — indexOf 는 부분문자열에 헛통과한다("Nordstrom Rack" 1위인데 배지가
      // "Nordstrom"이면 통과). 등장하는 판매처명 중 **가장 긴 것**을 골라 정확히 대조한다.
      if (badge) {
        const bt = badge.innerText;
        const allNames = res.map(r => r.sc.store || LIT.ko.noStore)
                            .filter(s => bt.indexOf(s) >= 0)
                            .sort((a, b) => b.length - a.length);
        const named = allNames[0] || null;
        if (named === null) {
          fails.push({ seed, i, why: '결론 배지에 판매처명이 없다', badge: bt.slice(0, 120) });
        } else if (tiedNames.indexOf(named) < 0) {
          fails.push({ seed, i, why: `결론 배지가 가리키는 판매처(${named})가 최저 그룹(${tiedNames.join('·')}) 밖`,
                       badge: bt.slice(0, 120) });
        }
      }
    }
    myWallet = keep.wallet; cppValues = keep.cpp; scenarios = keep.scen; CARDS = activeCards();
    setLangForTest(langKeep);
    __fuzz.lastCompare = fails;
    return { mode: 'compare', seed, n, failed: fails.length, sample: fails.slice(0, 8) };
  }

  // ===== 4) 골든 케이스 단독 실행 =====
  function runGolden() {
    const keep = { wallet: myWallet.slice(), cpp: Object.assign({}, cppValues), tax: taxPct };
    const g = checkGolden();
    myWallet = keep.wallet; cppValues = keep.cpp; taxPct = keep.tax; CARDS = activeCards();
    __fuzz.lastGolden = g;
    return { mode: 'golden', 통과: g.pass, 실패: g.fail.length, 건너뜀: g.skipped, 상세: g.fail };
  }

  // ===== 5) '재확인' 상태 기계 — 요율을 지웠으면 0%가 아니라 '모름'이어야 한다 =====
  // 이 검사가 왜 필요한가: 재확인 버튼은 portalPct 만 지우고 portalName 은 남겨서
  // 화면이 자기모순이었다 — 기본율 줄은 "TopCashback 2% 자동 반영", 입력칸은 0,
  // 경유처는 "TopCashback (기본율)", 배지는 "오늘 확인". 사용자가 이 상태를 보고
  // "잘 작동한다"고 판단했다. **틀린 걸 눈치채지 못하는 종류**라 검사로 못박는다.
  // opt.lang: 'ko'(기본) | 'en'. **영어에서도 돌린다** — "0%가 아니라 모름"은 이 도구에서
  // 가장 비싼 보호 문구인데(빈 칸을 0%로 읽으면 계산기가 조용히 틀린 답을 낸다), 영어판에서만
  // 그 문구가 빠져도 한국어 검사는 계속 초록불이다. 그래서 두 언어 모두에 못 박는다.
  function runRecheck(opt) {
    opt = opt || {};
    const lang = opt.lang || 'ko';
    const L = LIT[lang];
    if (!L) throw new Error('모르는 언어: ' + lang);
    const keep = { wallet: myWallet.slice(), cpp: Object.assign({}, cppValues), scen: scenarios.slice(), tax: taxPct, auto: autoApplied };
    const bad = [];
    const seen = (re) => re.test(document.getElementById('plinks-' + sc.id).textContent);
    const concl = () => document.getElementById('finalConclusion').textContent;
    let sc;
    const langKeep = LANG; setLangForTest(lang);
    try {
      myWallet = ['wfactivecash']; CARDS = activeCards(); taxPct = 0; autoApplied = {};
      scenarios = [blankScenario({ store: 'Target', price: 100 })];
      sc = scenarios[0];
      buildAll(); recompute();
      const card = document.getElementById('scard-' + sc.id);

      // ① 기본율이 자동으로 들어온 상태 — 이게 성립해야 아래 검사가 의미를 가진다
      if (!(+sc.portalPct > 0)) { bad.push('사전조건 실패: Target 기본율이 자동 입력되지 않음(요율 스냅샷 문제?)'); throw new Error('skip');
      }
      const basePct = +sc.portalPct;

      // ② 재확인 클릭 (새 탭 열기는 막는다)
      const ow = window.open; window.open = () => null;
      card.querySelector('.recheck').click();
      window.open = ow;

      if (+sc.portalPct !== 0) bad.push('재확인 후 portalPct 가 안 지워짐: ' + sc.portalPct);
      if (sc.portalName) bad.push('재확인 후 portalName 이 남음: "' + sc.portalName + '" — 입력칸은 비었는데 경유처만 남으면 화면이 자기모순');
      if (!sc.portalUnknown) bad.push('재확인 후 portalUnknown 이 안 세워짐 — 0%와 모름이 구분되지 않는다');
      if (!seen(L.needCheck)) bad.push('[' + lang + '] 화면에 "캐시백 % 확인 필요" 표시가 없음 — 빈 칸이 0%로 읽힌다');
      if (seen(L.autoBest)) bad.push('[' + lang + '] "높은 쪽 자동 반영" 문구가 남음 — 실제로는 아무것도 안 반영된 상태');
      if (!L.unconfirmed.test(concl())) bad.push('[' + lang + '] 결론에 미확정 경고가 없음 — 순비용이 실제보다 비싸게 나오는 걸 안 알린다');
      const el = card.querySelector('.s-portal');
      if (el && el.value !== '') bad.push('입력칸이 "' + el.value + '" — 0 이 아니라 빈 칸이어야 "모름"으로 읽힌다');

      // ③ '기본율 넣기' 로 복구되는가
      const btn = document.getElementById('plinks-' + sc.id).querySelector('.usebase');
      if (!btn) bad.push('기본율이 있는 판매처인데 "기본율 넣기" 버튼이 없음 — 되돌릴 방법이 없다');
      else {
        btn.click();
        if (+sc.portalPct !== basePct) bad.push('기본율 넣기 후 요율 미복구: ' + sc.portalPct + ' ≠ ' + basePct);
        if (sc.portalUnknown) bad.push('기본율 넣기 후에도 portalUnknown 이 남음');
        if (!sc.portalName) bad.push('기본율 넣기 후 경유처 라벨이 비어 있음');
        if (L.unconfirmed.test(concl())) bad.push('[' + lang + '] 요율을 넣었는데 결론에 미확정 경고가 그대로 남음');
      }
    } catch (e) {
      if (e.message !== 'skip') bad.push('throw: ' + e.message);
    }
    myWallet = keep.wallet; cppValues = keep.cpp; scenarios = keep.scen; taxPct = keep.tax; autoApplied = keep.auto;
    setLangForTest(langKeep);
    __fuzz.lastRecheck = bad;
    return { mode: 'recheck', lang: lang, 검사: 10, 실패: bad.length, 상세: bad };
  }
  // 한국어·영어 둘 다 — 합쳐서 하나로 보고한다(어느 쪽이 깨졌는지는 상세의 [lang] 꼬리표로).
  function runRecheckBoth() {
    const a = runRecheck({ lang: 'ko' }), b = runRecheck({ lang: 'en' });
    return { mode: 'recheck', 검사: a.검사 + b.검사, 실패: a.실패 + b.실패, 상세: a.상세.concat(b.상세) };
  }

  // ===== 6) 오퍼 붙여넣기 파서 (v0.28) =====
  //
  // 왜 골든(정답 고정) 방식인가: 이 파서는 "몇 개 읽었나"만 보면 **조용히 틀린다**.
  // 가맹점명 한 줄을 잘못 집어도 개수는 그대로고, 그 결과는 "엉뚱한 가게의 오퍼가
  // 이 가게에 붙는 것" — 순위를 조용히 뒤집는, 이 도구에서 제일 나쁜 실패 모드다.
  // 그래서 개수가 아니라 **가맹점명·금액·만료·신뢰도를 하나하나 못 박는다.**
  //
  // ⚠️ 픽스처는 **익명 샘플**이다. 실제 사용자 덤프(evidence/)는 개인 오퍼라
  //    이 repo에 절대 들어오지 않는다. 대신 실제 덤프에서 관찰된 **구조**만 그대로 옮겼다:
  //      · Amex — 가맹점명 2줄 반복 / 광고 블록(Explore Now) / 만료 없는 오퍼 / 마일 오퍼
  //               / 첫 줄에만 공백이 두 칸인 케이스
  //      · Chase — 캐러셀↔목록 중복 / 가맹점명 아래 설명문(YouTube TV) / 브랜드+홍보문구가
  //                한 줄(Google Play·YouTube Premium) / "Up to N%" / "Nd left" / 값 줄만 남은 블록
  const PARSE_FIXTURE_AMEX = [
    'Skip to main', 'Menu', 'American Express', '',
    'Aurora Rewards® Card', '••••44021', 'card_art', 'Added to Card', 'View All', '',
    'Recommended Offers', 'Sort ByRecommended', '', '',
    'Bonus Points Offer',
    'Bonus Points Offer',
    'Spend $1,500 or more, earn 1,500 additional Aurora Points, up to 2 times',
    'Terms apply', 'View Details', '',
    'Loans That Fit Your Lifestyle',
    'Apply for a personal loan and explore repayment options. Terms apply.',
    'Explore Now',
    'Northwind Apparel',
    'Northwind Apparel',
    'Spend $80 or more, earn $16 back',
    'Expires 9/30/26', '', 'Terms apply', 'View Details', '',
    'Fabrikam - Salads, Wraps, and Bowls',
    'Fabrikam - Salads, Wraps, and Bowls',
    'Spend $20 or more, earn $4 back, up to 2 times (total of $8).',
    'Expires 8/31/26', '', 'Terms apply', 'View Details', '',
    'Contoso Cloud',
    'Contoso Cloud',
    'Earn 30% back on purchases, up to a total of $45',
    'Expires 11/25/26', '', 'Terms apply', 'View Details', '',
    'Litware  - Live Event Ticketing Platform',          // 첫 줄만 공백 두 칸 — 정규화 후 같아야 한다
    'Litware - Live Event Ticketing Platform',
    'Spend $250 or more, earn $40 back',
    'Expires 9/28/26', '', 'Terms apply', 'View Details', '',
    'Adventure Works',
    'Adventure Works',
    'Earn +4 miles per eligible dollar spent, up to 4,000 miles',
    'Expires 8/14/26', '', 'Terms apply', 'View Details', '',
    'Proseware',
    'Proseware',
    'Spend $60 or more, earn $12 back',
    'Expires 7/1/26', '', 'Terms apply', 'View Details', '',
    'Last Login: 12 Aug 2026 @ 12:31', '© 2026 American Express. All rights reserved'
  ].join('\n');

  const PARSE_FIXTURE_CHASE = [
    'Skip to main content', '', 'Chase logo', '', 'Sign out', '', 'Accounts', '',
    'Chase Offers', 'Home', 'Offers wallet', 'More', 'Choose account', '',
    'Voyager (...3310)',
    "Add deals to your card, shop and get cash back. It's that easy.", '',
    'Voyager (...3310)', '$12.00', 'Total amount saved', '1', 'Added offers', '0', 'Expiring offers',
    'All offers', 'Shopping', 'Groceries', 'Other', '',
    'New', 'New offers loaded', 'See all offers', '', '',
    'New', '', '',
    'Northwind Apparel', '15% cash back', 'Expiring soon',
    'New', '', '',
    'Fabrikam Bowls', '10% cash back',
    'All offers',
    'Tailspin TV', 'Watch live sports from 80+ networks', '$20 cash back', 'Add offer', '', '', '',
    'Northwind Apparel', '15% cash back', 'Expiring soon',
    'New', '', '',
    'Fabrikam Bowls', '10% cash back', '', '',
    'Contoso Cloud is your workspace unbound.', '10% cash back', '', '',
    'Tailspin Premium: 40% off your first three payments', '40% cash back', '', '',
    'Fourth Coffee', 'Up to 5% back', '', '',
    '[lowercase brand]', '15% cash back', '', '',
    'Wide World Travel', '$100 back', '45d left', '',
    'Back to top', '', '',
    '12% cash back',                 // 가맹점명 줄이 없다 → 조용히 버리지 말고 '못 읽음'으로
    '18% cash back'                  // 앞 줄이 값 줄이다 → 역시 '못 읽음'
  ].join('\n');

  // 정답 — 순서·값 전부 고정. 하나라도 어긋나면 실패.
  const PARSE_GOLDEN = {
    amex: {
      issuer: 'amex', card: { name: 'Aurora Rewards® Card', digits: '44021' },
      stats: { found: 7, duplicates: 0, skipped: 0, withExpiry: 6, miles: 2, lowConf: 0 },
      offers: [
        ['Bonus Points Offer', 'miles', 0, 0, null, 1500, null],
        ['Northwind Apparel', 'fixed', 16, 0, null, 80, '2026-09-30'],
        ['Fabrikam - Salads, Wraps, and Bowls', 'fixed', 4, 0, null, 20, '2026-08-31'],
        ['Contoso Cloud', 'pct', 0, 30, 45, null, '2026-11-25'],
        ['Litware - Live Event Ticketing Platform', 'fixed', 40, 0, null, 250, '2026-09-28'],
        ['Adventure Works', 'miles', 0, 0, null, null, '2026-08-14'],
        ['Proseware', 'fixed', 12, 0, null, 60, '2026-07-01'],
      ],
    },
    chase: {
      issuer: 'chase', card: { name: 'Voyager', digits: '3310' },
      stats: { found: 8, duplicates: 2, skipped: 2, withExpiry: 1, miles: 0, lowConf: 2 },
      offers: [
        ['Northwind Apparel', 'pct', 0, 15, null, null, null],
        ['Fabrikam Bowls', 'pct', 0, 10, null, null, null],
        ['Tailspin TV', 'fixed', 20, 0, null, null, null],       // 설명문을 가맹점명으로 잡으면 안 된다
        ['Contoso Cloud', 'pct', 0, 10, null, null, null],       // "…is your workspace unbound." 에서 앞머리만
        ['Tailspin Premium', 'pct', 0, 40, null, null, null],    // 콜론 앞만
        ['Fourth Coffee', 'pct', 0, 5, null, null, null],        // "Up to" → approx
        ['[lowercase brand]', 'pct', 0, 15, null, null, null],   // 소문자로 시작해도 짧으면 브랜드다
        ['Wide World Travel', 'fixed', 100, 0, null, null, '2026-09-28'],  // 45d left → asOf+45
      ],
    },
  };

  function runParse() {
    const bad = [];
    const ASOF = '2026-08-14';                 // 고정 — "45d left" 가 절대 날짜로 바뀌는 기준
    if (typeof parseOfferDump !== 'function') {
      bad.push('parseOfferDump 가 없다 — 파서가 페이지에서 사라졌거나 이름이 바뀜');
      __fuzz.lastParse = bad;
      return { mode: 'parse', 검사: 0, 실패: bad.length, 상세: bad };
    }
    let checks = 0;
    const eq = (why, got, want) => { checks++; if (got !== want) bad.push(why + ': ' + JSON.stringify(got) + ' ≠ ' + JSON.stringify(want)); };

    [['amex', PARSE_FIXTURE_AMEX], ['chase', PARSE_FIXTURE_CHASE]].forEach(([who, text]) => {
      const g = PARSE_GOLDEN[who];
      let r;
      try { r = parseOfferDump(text, { asOf: ASOF }); }
      catch (e) { bad.push(who + ' throw: ' + e.message); return; }

      eq(who + '.ok', r.ok, true);
      eq(who + '.issuer', r.issuer, g.issuer);
      eq(who + '.card.name', r.card && r.card.name, g.card.name);
      eq(who + '.card.digits', r.card && r.card.digits, g.card.digits);
      Object.keys(g.stats).forEach(k => eq(who + '.stats.' + k, r.stats[k], g.stats[k]));

      // 개수만 맞고 내용이 틀리는 게 이 파서의 실패 방식이다 → 행 단위로 못 박는다
      g.offers.forEach((want, i) => {
        const o = r.offers[i];
        if (!o) { checks++; bad.push(who + '.offers[' + i + '] 없음 (기대: ' + want[0] + ')'); return; }
        eq(who + '.offers[' + i + '].merchant', o.merchant, want[0]);
        eq(who + '.offers[' + i + '].kind', o.kind, want[1]);
        eq(who + '.offers[' + i + '].amount', o.amount, want[2]);
        eq(who + '.offers[' + i + '].pct', o.pct, want[3]);
        eq(who + '.offers[' + i + '].cap', o.cap, want[4]);
        eq(who + '.offers[' + i + '].minSpend', o.minSpend, want[5]);
        eq(who + '.offers[' + i + '].expiry', o.expiry.known ? o.expiry.iso : null, want[6]);
      });
      checks++; if (r.offers.length !== g.offers.length) bad.push(who + ' 오퍼 수 ' + r.offers.length + ' ≠ ' + g.offers.length);
    });

    // 못 읽은 건 조용히 사라지면 안 된다 — 이유와 원문 조각이 같이 남아야 사용자가 손으로 메꾼다
    try {
      const rc = parseOfferDump(PARSE_FIXTURE_CHASE, { asOf: ASOF });
      checks++; if (!rc.skipped.length) bad.push('못 읽은 블록이 skipped 로 안 돌아옴 — 조용한 누락');
      rc.skipped.forEach((s, i) => { checks++; if (!s.why || !s.text) bad.push('skipped[' + i + '] 에 이유나 원문이 비었다'); });
    } catch (e) { bad.push('skipped 검사 throw: ' + e.message); }

    // 개별 규칙 — 하나씩 따로 걸어둬야 어디가 깨졌는지 바로 보인다
    const V = s => { const x = ofpValue(s); return x ? [x.kind, x.amount, x.pct, x.cap, x.minSpend, !!x.approx] : null; };
    [
      ['Spend $75 or more, earn $15 back', ['fixed', 15, 0, null, 75, false]],
      ['Spend $99 or more, earn $25', ['fixed', 25, 0, null, 99, false]],
      ['Earn 10% back on purchases, up to a total of $100', ['pct', 0, 10, 100, null, false]],
      ['Spend $15 or more, earn $3 back, up to 2 times (total of $6).', ['fixed', 3, 0, null, 15, false]],
      ['Earn +5 miles per eligible dollar spent, up to 5,000 miles', ['miles', 0, 0, null, null, false]],
      ['15% cash back', ['pct', 0, 15, null, null, false]],
      ['$30 cash back', ['fixed', 30, 0, null, null, false]],
      ['Up to 5% back', ['pct', 0, 5, null, null, true]],
    ].forEach(([s, want]) => { checks++; const got = V(s);
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push('ofpValue("' + s + '") = ' + JSON.stringify(got) + ' ≠ ' + JSON.stringify(want)); });

    // 설명문 판정 — 이게 뒤집히면 가맹점명 자리에 홍보문구가 저장된다
    [
      ['Watch live sports from 80+ networks', true],
      ['Contoso Cloud is your workspace unbound.', true],
      ['Hydro Flask - Water Bottles & Drinkware', false],
      ['[lowercase brand]', false],
      ["Sam's Club", false],
      ['Avocado Green Mattress - Mattresses, Pillows, and Bedding', false],
    ].forEach(([s, want]) => { checks++; if (ofpIsDescription(s) !== want) bad.push('ofpIsDescription("' + s + '") = ' + !want + ' (기대 ' + want + ')'); });

    // 가맹점 ↔ 판매처 대조는 보수적이어야 한다. 틀린 오퍼는 없는 것보다 나쁘다.
    [
      ['Northwind Apparel', 'Northwind Apparel', true],
      ['Fabrikam - Salads, Wraps, and Bowls', 'Fabrikam', true],
      ['Lids', 'Lids.com', true],
      ['Contoso Cloud', 'Contoso', true],
      ['Dropbox', 'Box', false],
      ['La Colombe', 'La-Z-Boy', false],
      ['Adventure Works', 'Adventure Time Toys', false],
    ].forEach(([m, s, want]) => { checks++; if (ofpStoreHit(m, s, '') !== want) bad.push('ofpStoreHit("' + m + '","' + s + '") = ' + !want + ' (기대 ' + want + ')'); });

    // 금액 환산 — 최소 사용액 미달·상한·마일은 "넣을 수 없음"으로 정직하게 돌아와야 한다
    const A = (o, chg) => { const x = ofpAmountFor(Object.assign({ kind: 'fixed', amount: 0, pct: 0, cap: null, minSpend: null, approx: false }, o), chg); return [x.ok, x.amount]; };
    [
      [{ kind: 'fixed', amount: 15, minSpend: 75 }, 200, [true, 15]],
      [{ kind: 'fixed', amount: 15, minSpend: 500 }, 200, [false, 0]],
      [{ kind: 'pct', pct: 10, cap: 100 }, 200, [true, 20]],
      [{ kind: 'pct', pct: 10, cap: 5 }, 200, [true, 5]],
      [{ kind: 'pct', pct: 10 }, 0, [false, 0]],
      [{ kind: 'miles' }, 200, [false, 0]],
    ].forEach(([o, chg, want]) => { checks++; const got = A(o, chg);
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push('ofpAmountFor(' + JSON.stringify(o) + ',' + chg + ') = ' + JSON.stringify(got) + ' ≠ ' + JSON.stringify(want)); });

    // 이 기능은 옵션이다 — 아무것도 안 붙여넣은 상태에서 계산에 손대면 안 된다(프라이버시 원칙 P1)
    checks++;
    try {
      const keepW = offerWallet; offerWallet = {};
      if (ofpSuggestions('Northwind Apparel', '', 100).length) bad.push('오퍼를 하나도 안 넣었는데 제안이 나온다 — 옵션이 아니게 된다');
      offerWallet = keepW;
    } catch (e) { bad.push('빈 지갑 검사 throw: ' + e.message); }

    // 만료된 오퍼는 제안에서 빠져야 한다
    checks++;
    try {
      const keepW = offerWallet, keepC = CARDS;
      CARDS = [CARD_CATALOG[0]];
      offerWallet = {}; offerWallet[CARDS[0].id] = { issuer: 'amex', asOf: todayStr(), offers: [
        { merchant: 'Proseware', offerText: 'x', kind: 'fixed', amount: 12, pct: 0, cap: null, minSpend: null, approx: false, expiry: { known: true, iso: '2020-01-01' }, badges: [] },
        { merchant: 'Northwind Apparel', offerText: 'y', kind: 'fixed', amount: 16, pct: 0, cap: null, minSpend: null, approx: false, expiry: { known: false, iso: null }, badges: [] } ] };
      if (ofpSuggestions('Proseware', '', 100).length) bad.push('만료된 오퍼가 제안에 남아 있다');
      if (ofpSuggestions('Northwind Apparel', '', 100).length !== 1) bad.push('만료일 모름인 오퍼가 제안에서 빠졌다 — 모름을 만료로 취급하면 안 된다');
      offerWallet = keepW; CARDS = keepC;
    } catch (e) { bad.push('만료 검사 throw: ' + e.message); }

    __fuzz.lastParse = bad;
    return { mode: 'parse', 검사: checks, 실패: bad.length, 상세: bad.slice(0, 20) };
  }

  // ===== v0.29 매장 바코드 스캔 (site/scanner.js) =====
  // 이 파일의 최악 실패 모드는 "못 읽음"이 아니라 **그럴듯한 12자리를 만들어내는 것**이다.
  // 그러면 개수는 똑같이 1이고 형식도 멀쩡한데 사용자는 엉뚱한 상품 페이지를 본다.
  // 개수·형식을 세는 검사로는 안 잡힌다 → 아래는 전부 값을 행 단위로 못 박는다.
  //
  // 골든의 출처: 아래 UPC는 우리가 만든 숫자가 아니라 **조사 문서가 실제로 조회에 쓴 것**이다
  // (리서치/바코드-매장스캔-조사.md 3-B·3-E·9-A·9-B). 체크디지트 구현이 틀리면 여기서 걸린다.
  const SCAN_REAL_UPC = [
    ['194252721247', 'AirPods Pro 1세대 — 조사 3-E'],
    ['041604414855', 'Stanley Quencher 40oz Rose Quartz — 조사 3-E'],
    ['037000509493', 'Tide Pods 14ct — 조사 3-E'],
    ['041604361814', 'Stanley 40oz CREAM — 조사 9-A'],
    ['041604372124', 'Stanley 30oz — 조사 9-A'],
    ['041604372155', 'Stanley 30oz 별개 UPC — 조사 9-A'],
    ['041604394263', 'Stanley 또 다른 변형 — 조사 9-A'],
    ['195174028087', 'LG OLED65C2PUA 본체 — 조사 9-B'],
    ['196641012844', 'LG 번들 — 조사 9-B'],
    ['049000028911', 'Diet Coke — 조사 3-B'],
  ];

  // UPC-E → UPC-A. 압축 분기 4가지를 하나씩 덮는다.
  // ⚠️ 기대값은 expandUpcE 로 만든 것이 아니라 **명세에서 손으로 편 것**이다:
  //    X6∈{0,1,2}: N X1 X2 X6 0000 X3X4X5 / X6=3: N X1X2X3 00000 X4X5
  //    X6=4:       N X1X2X3X4 00000 X5     / X6∈{5..9}: N X1X2X3X4X5 0000 X6
  //    첫 줄은 널리 쓰이는 표준 예시(0 425261 4 ↔ 042100005264)다.
  const SCAN_UPCE = [
    ['04252614', '042100005264', 'X6=1 — 표준 예시'],
    ['01234531', '012300000451', 'X6=3'],
    ['01234543', '012340000053', 'X6=4'],
    ['01234572', '012345000072', 'X6=7'],
  ];

  // ==========================================================================
  // v0.31 📷 사진으로 상품 찾기 (vision.js) — 순수 로직 골든
  // ==========================================================================
  // 이 기능의 최악의 실패 모드는 "못 알아봄"이 아니라 **조용히 그럴듯하게 틀리는 것**이다.
  // 바코드의 "지어낸 12자리"와 같은 급이고, 개수·형식 검사로는 절대 안 잡힌다.
  // 그래서 여기서는 **되묻기 판단·짐작 표시·딥링크·상한**을 값 단위로 못 박는다.
  //
  // ⭐ 가장 중요한 두 줄:
  //   ① needsReask — 모델이 "더 물을 것 없다(ask:null)"고 해도 **read 가 비었으면 되묻는다.**
  //      실측에서 모델은 못 읽었을 때도 12/12 확신했다(workers-ai-비전-실측 4-A).
  //      모델의 자기평가를 게이트로 쓰지 않는다는 설계(조사 6-A)가 여기 한 줄에 걸려 있다.
  //   ② SEARCH_STORES — 조용히 늘어나면 사용자에게 "없는 상품"으로 보인다.
  async function runVision(mod) {
    const bad = []; let checks = 0;
    let V = mod;
    if (!V) {
      try { V = await import(new URL('vision.js', location.href).href); }
      catch (e) { return { mode: 'vision', 검사: 0, 실패: 1, 상세: ['vision.js 를 못 불러왔다: ' + e.message] }; }
    }
    // ⚠️ 술어가 던지면 '통과'가 아니라 '실패'다. 던지게 두면 변형이 하니스를 죽여서
    // 음성 대조군이 'run throw' 로 뭉개지고, 그 검사가 살아있는지 알 수 없게 된다.
    const eq = (fn, want, why) => {
      checks++;
      let got;
      try { got = (typeof fn === 'function') ? fn() : fn; }
      catch (e) { bad.push(why + ' — 검사 중 예외: ' + e.message); return; }
      if (got !== want) bad.push(why + ' — 받은값: ' + JSON.stringify(got) + ' ≠ ' + JSON.stringify(want));
    };

    // --- 1. ⭐ 되묻기 판단 -------------------------------------------------
    const R = (o) => Object.assign({ ok: true, category: '', candidates: [{ query: 'q', why: 'w' }], read: ['Nike'], guessed: [], ask: null }, o);
    eq(V.needsReask(R({})), false, '정상 결과인데 되묻는다');
    eq(V.needsReask(R({ read: [] })), true,
       '★ read 가 비었는데 안 되묻는다 (모델이 ask:null 이라고 해도 되물어야 한다 — 이 기능의 급소)');
    eq(V.needsReask(R({ candidates: [] })), true, '후보가 0개인데 안 되묻는다');
    eq(V.needsReask(R({ ask: { reason: 'no-model' } })), true, '모델이 되물으라는데 안 되묻는다');
    eq(V.needsReask({ ok: false, errorCode: 'network' }), false, '오류를 되묻기로 취급했다 (오류는 오류다)');
    eq(V.needsReask(null), false, '빈 값에서 되묻기가 켜졌다');

    // 되묻기 사유 고르기
    eq(V.reaskReason(R({ ask: { reason: 'packaging' } })), 'packaging', '모델이 준 사유를 안 쓴다');
    eq(V.reaskReason(R({ candidates: [], ask: null })), 'none-recognized', '후보 0개의 기본 사유가 다르다');
    eq(V.reaskReason(R({ read: [], ask: null })), 'no-brand', 'read 가 빈 경우의 기본 사유가 다르다');

    // --- 2. 되묻기 문구 — **방향을 지목해야 한다** -------------------------
    // 조사 9장 #5: "다시 찍어 주세요"로 뭉개지 마라. 뭉뚱그린 피드백은 효과가 없다.
    for (const k of ['no-brand', 'no-model', 'packaging', 'too-far', 'multiple', 'none-recognized']) {
      checks++;
      const s = V.askText(k);
      if (!s || s.length < 8) bad.push('되묻기 문구가 비었거나 너무 짧다: ' + k + ' → ' + s);
      // 방향·대상을 지목하는 단어가 하나도 없으면 뭉뚱그린 문구다
      if (!/상표|로고|모델|스티커|택|박스|포장|가까이|하나|brand|logo|model|sticker|tag|box|packaging|closer|one item/i.test(s)) {
        bad.push('★ 되묻기 문구가 방향을 지목하지 않는다 (조사 9장 #5): ' + k + ' → ' + s);
      }
    }
    checks++;
    if (V.askText('아무거나') === V.askText('no-brand') && false) bad.push('unreachable');

    // --- 3. ⭐ 짐작 표시 — UNVERIFIED 가 사람 문장으로 나오는가 --------------
    checks++;
    {
      const line = V.guessedLine('UNVERIFIED:OLED65C2');
      if (!/OLED65C2/.test(line)) bad.push('UNVERIFIED 문장에 토큰이 안 들어갔다: ' + line);
      if (/UNVERIFIED/.test(line)) bad.push('★ UNVERIFIED 내부 표시가 화면 문구로 그대로 샜다: ' + line);
      if (line.length < 10) bad.push('UNVERIFIED 문장이 너무 짧다: ' + line);
    }
    eq(V.guessedLine('그냥 짐작이에요'), '그냥 짐작이에요', '일반 짐작 문장을 건드렸다');

    // --- 4. ⭐ 딥링크 — 목록이 조용히 늘어나지 않는가 ------------------------
    eq(V.SEARCH_STORES.map(s => s.id).join(','), 'amazon,target,walmart,bestbuy',
       '★ 검색 판매처 목록이 바뀌었다 — 늘리려면 먼저 실측할 것 (조사 8장 2단계)');
    {
      const links = V.buildSearchLinks('nike air max 90 white');
      eq(links.length, 4, '딥링크 개수가 다르다');
      for (const l of links) {
        checks++;
        if (!/^https:\/\//.test(l.url)) bad.push('딥링크가 https 가 아니다: ' + l.url);
        if (!/nike(\+|%20)air(\+|%20)max/i.test(l.url)) bad.push('딥링크에 검색어가 안 실렸다: ' + l.url);
        // H4·H5 — 어필리에이트 태그·추적 파라미터가 붙으면 안 된다
        if (/[?&](tag|aff|affid|irgwc|clickid|utm_|ref_?=)/i.test(l.url)) {
          bad.push('★ 딥링크에 어필리에이트·추적 파라미터가 붙었다 (H4·H5 위반): ' + l.url);
        }
      }
      // ⭐ Walmart 가 살아 있어야 한다 — 바코드(UPC)에선 막혔지만 키워드는 통한다(조사 3-E)
      checks++;
      if (!links.some(l => l.id === 'walmart')) bad.push('★ 사진 경로에서 Walmart 가 빠졌다 (키워드 검색은 UPC와 달리 통한다)');
    }
    eq(V.buildSearchLinks('').length, 0, '빈 검색어로 링크를 만들었다');
    eq(V.buildSearchLinks('   ').length, 0, '공백 검색어로 링크를 만들었다');

    // --- 5. 워커 응답 좁히기 ------------------------------------------------
    {
      const g = V.shapeResult({ ok: true, category: 'TV', candidates: [{ query: ' x ', why: ' y ' }, { query: '  ' }], read: ['A', 3, ''], guessed: null, ask: { reason: 'no-model', detail: 'd' } });
      eq(g.candidates.length, 1, '빈 query 후보를 안 버렸다');
      eq(g.candidates[0].query, 'x', '후보 query 를 안 다듬었다');
      eq(g.read.join('|'), 'A', 'read 에서 문자열 아닌 값을 안 걸렀다');
      eq(Array.isArray(g.guessed), true, 'guessed 가 배열이 아니다');
      eq(() => g.ask.reason, 'no-model', 'ask 사유가 사라졌다');
    }
    eq(() => V.shapeResult(null).ok, false, '빈 응답을 성공으로 봤다');
    eq(() => V.shapeResult({ ok: false, errorCode: 'no-key' }).errorCode, 'no-key', '오류코드가 사라졌다');

    // --- 6. 프리체크 — **막는 것과 경고하는 것을 구분한다** -----------------
    eq(V.precheck(1024, 500), 'ok', '멀쩡한 사진을 막았다');
    eq(V.precheck(200, 500), 'too-small', '너무 작은 사진을 통과시켰다');
    eq(V.precheck(1024, 1), 'blurry', '뭉개진 사진을 못 알아봤다');
    eq(V.precheck(0, null), 'ok', '★ 못 잰 사진을 막았다 (못 재면 통과가 맞다 — 막는 쪽이 더 나쁘다)');
    eq(V.precheck(1024, null), 'ok', '흐림을 못 쟀는데 막았다');
    checks++;
    if (!(V.MIN_LONG_EDGE > 0 && V.MIN_LONG_EDGE < 1024)) bad.push('MIN_LONG_EDGE 가 이상하다: ' + V.MIN_LONG_EDGE);

    // 라플라시안 — 평평한 판은 0, 체크무늬는 커야 한다
    {
      const W = 16, flat = new Float32Array(W * W), edge = new Float32Array(W * W);
      for (let i = 0; i < W * W; i++) { flat[i] = 128; edge[i] = ((i % W) + Math.floor(i / W)) % 2 ? 255 : 0; }
      eq(V.laplacianVar(flat, W, W), 0, '평평한 이미지의 분산이 0이 아니다');
      // ⚠️ 평평한 판만으로는 "분산" 대신 "2차 모멘트"를 돌려주는 실수를 못 잡는다 —
      //    둘 다 0이 나오기 때문이다(음성 대조군에서 실제로 안 잡혔다).
      //    라플라시안이 상수 2인 2차 곡면을 쓰면 분산은 0, 2차 모멘트는 4로 갈린다.
      const quad = new Float32Array(W * W);
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) quad[y * W + x] = x * x + y * y;
      checks++;
      if (Math.abs(V.laplacianVar(quad, W, W)) > 1e-6) {
        bad.push('★ laplacianVar 가 분산이 아니라 2차 모멘트를 돌려준다: ' + V.laplacianVar(quad, W, W));
      }
      checks++;
      if (!(V.laplacianVar(edge, W, W) > 1000)) bad.push('체크무늬의 라플라시안 분산이 너무 작다: ' + V.laplacianVar(edge, W, W));
    }

    // --- 7. 하루 상한 — 날짜가 바뀌면 리셋된다 ------------------------------
    {
      const mem = (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; })();
      eq(V.dayCount(mem, '2026-08-20'), 0, '빈 저장소의 카운트가 0이 아니다');
      V.bumpDay(mem, '2026-08-20'); V.bumpDay(mem, '2026-08-20');
      eq(V.dayCount(mem, '2026-08-20'), 2, '카운트가 안 늘었다');
      eq(V.dayCount(mem, '2026-08-21'), 0, '★ 날짜가 바뀌었는데 카운트가 안 리셋됐다');
      checks++;
      const broken = { getItem: () => '{{{깨진', setItem: () => { throw new Error('quota'); } };
      try { if (V.dayCount(broken, '2026-08-20') !== 0) bad.push('깨진 저장소에서 카운트가 0이 아니다'); }
      catch (e) { bad.push('깨진 저장소에서 예외가 새어나왔다: ' + e.message); }
      checks++;
      try { V.bumpDay(broken, '2026-08-20'); } catch (e) { bad.push('저장 실패가 예외로 새어나왔다 (사파리 프라이빗에서 기능이 죽는다): ' + e.message); }
      checks++;
      if (!(V.DAILY_CAP > 0 && V.DAILY_CAP <= 100)) bad.push('DAILY_CAP 이 이상하다: ' + V.DAILY_CAP);
    }
    eq(V.todayStr(new Date(2026, 7, 5)), '2026-08-05', '날짜 문자열이 0채움이 안 됐다');

    // --- 8. 업로드 규격 — 비용·지연이 여기 달려 있다 ------------------------
    // ⚠️ 이 값은 **실측으로 정해졌다**(부록 C). 1024 로 되돌리면 12px 구간 실패율이
    //    0% → 100% 로 돌아간다. 비용(면적 비례)만 보고 낮추지 마라.
    eq(V.LONG_EDGE, 1568, '업로드 긴 변이 바뀌었다 — 1568 은 실측으로 정한 값이다(부록 C)');
    checks++;
    if (!(V.JPEG_QUALITY > 0.5 && V.JPEG_QUALITY <= 0.9)) bad.push('JPEG 품질이 범위 밖이다: ' + V.JPEG_QUALITY);

    return { mode: 'vision', 검사: checks, 실패: bad.length, 상세: bad.slice(0, 40) };
  }

  async function runScan(mod) {
    const bad = []; let checks = 0;
    let S = mod;
    if (!S) {
      try { S = await import(new URL('scanner.js', location.href).href); }
      catch (e) { return { mode: 'scan', 검사: 0, 실패: 1, 상세: ['scanner.js 를 못 불러왔다: ' + e.message] }; }
    }

    // --- 1. 체크디지트 ---------------------------------------------------
    // 통과해야 할 것: 조사에서 실제로 쓴 UPC 전부
    for (const row of SCAN_REAL_UPC) {
      checks++;
      if (S.hasValidCheckDigit(row[0]) !== true)
        bad.push('실제 UPC가 체크디지트를 통과 못 했다: ' + row[0] + ' (' + row[1] + ')');
    }
    // 막아야 할 것: 한 자리만 틀린 번호. 이게 통과하면 오타를 그대로 검색하게 된다
    for (const row of SCAN_REAL_UPC) {
      checks++;
      const c = row[0], broken = c.slice(0, -1) + String((+c.slice(-1) + 1) % 10);
      if (S.hasValidCheckDigit(broken) !== false)
        bad.push('체크디지트가 틀린 번호를 통과시켰다: ' + broken + ' (원본 ' + c + ')');
    }

    // --- 2. 정규화 -------------------------------------------------------
    const CANON = [
      ['0049000028911', 'ean_13', '049000028911',  '0으로 시작하는 EAN-13은 UPC-A와 같은 번호 → 12자리로'],
      ['4006381333931', 'ean_13', '4006381333931', '진짜 EAN-13은 13자리 그대로 둔다'],
      ['194252721247',  'upc_a',  '194252721247',  'UPC-A는 그대로'],
      ['194252721248',  'upc_a',  null,            '체크디지트가 틀리면 값을 만들지 않는다'],
      ['04252614',      'upc_e',  '042100005264',  'UPC-E는 펴서 돌려준다'],
    ];
    for (const row of CANON) {
      checks++;
      const got = S.toCanonical(row[0], row[1]);
      if (got !== row[2])
        bad.push('정규화가 다르다: ' + row[0] + '(' + row[1] + ') → ' + got + ' ≠ ' + row[2] + ' — ' + row[3]);
    }

    // --- 3. UPC-E 복원 ---------------------------------------------------
    for (const row of SCAN_UPCE) {
      checks++;
      const got = S.expandUpcE(row[0]);
      if (got !== row[1])
        bad.push('UPC-E 복원이 다르다: ' + row[0] + ' → ' + got + ' ≠ ' + row[1] + ' (' + row[2] + ')');
    }
    checks++;
    if (S.expandUpcE('04252615') !== null) bad.push('체크디지트가 틀린 UPC-E인데 값을 만들어냈다');
    checks++;
    if (S.expandUpcE('24252614') !== null) bad.push('UPC-E에 없는 넘버시스템(2)인데 값을 만들어냈다');

    // --- 4. 손입력 폴백 --------------------------------------------------
    // ⚠️ 이건 폴백이지 진입 경로가 아니다. 8자리를 안 받는 것도 검사한다 —
    //    EAN-8과 UPC-E는 길이로 구분이 안 되고, 넘겨짚으면 엉뚱한 상품이 나온다.
    const MANUAL = [
      ['041604414855',      true,  '041604414855', '평범한 12자리'],
      [' 0416-0441-4855 ',  true,  '041604414855', '공백·하이픈은 지운다'],
      ['0049000028911',     true,  '049000028911', '13자리도 받아 12자리로'],
      ['04160441485',       false, 'bad-length',   '11자리'],
      ['04160441485555',    false, 'bad-length',   '14자리'],
      ['04252614',          false, 'bad-length',   '8자리는 안 받는다'],
      ['041604414856',      false, 'bad-check',    '한 자리 틀림'],
      ['04160441485a',      false, 'not-digits',   '글자가 섞임'],
      ['',                  false, 'empty',        '빈 칸'],
    ];
    for (const row of MANUAL) {
      checks++;
      const r = S.normalizeManualEntry(row[0]);
      if (row[1]) {
        if (!(r.ok && r.code === row[2]))
          bad.push('손입력을 받아야 하는데 못 받았다: "' + row[0] + '" → ' + JSON.stringify(r) + ' (' + row[3] + ')');
      } else {
        if (r.ok) bad.push('손입력을 막아야 하는데 통과시켰다: "' + row[0] + '" → ' + JSON.stringify(r) + ' (' + row[3] + ')');
        else if (r.reason !== row[2])
          bad.push('손입력 거절 사유가 다르다: "' + row[0] + '" → ' + r.reason + ' ≠ ' + row[2]);
      }
    }

    // --- 5. 딥링크 -------------------------------------------------------
    // 실측으로 확인된 두 곳만. Walmart 는 UPC 검색을 아예 안 받고(3/3 무결과, 대조군 통과)
    // Target 은 매칭 상품을 안 그린다 — 넣으면 사용자에게 "없는 상품"으로 보인다.
    const links = S.buildDeepLinks('041604414855');
    checks++;
    if (links.length !== 2)
      bad.push('딥링크가 2개가 아니다 (지금 ' + links.length + '개) — 실측 확인된 곳은 Amazon·Best Buy 둘뿐이다');
    checks++;
    const hosts = links.map(l => { try { return new URL(l.url).host; } catch (e) { return '?'; } }).sort().join(',');
    if (hosts !== 'www.amazon.com,www.bestbuy.com')
      bad.push('딥링크 호스트가 다르다: ' + hosts);
    for (const l of links) {
      checks++;
      for (const b of (S.DEEP_LINK_BLOCKED || []))
        if (l.url.toLowerCase().indexOf(b) >= 0)
          bad.push('UPC 검색이 안 되는 판매처가 딥링크에 들어왔다: ' + b + ' → ' + l.url);
      if (l.url.indexOf('041604414855') < 0)
        bad.push('딥링크에 UPC가 안 실렸다: ' + l.url);
      // 어필리에이트·추적 파라미터 금지 (프라이버시 원칙 H4·H5)
      let ks = [];
      try { new URL(l.url).searchParams.forEach((v, k) => ks.push(k)); } catch (e) { ks = ['?']; }
      for (const k of ks)
        if (k !== 'k' && k !== 'st')
          bad.push('딥링크에 모르는 파라미터가 붙었다 — 어필리에이트 태그인가? ' + k + ' → ' + l.url);
    }
    checks++;
    if (S.buildDeepLinks('').length !== 0 || S.buildDeepLinks('12345').length !== 0)
      bad.push('UPC가 아닌 값으로도 딥링크를 만들었다');

    // --- 6. 해독 재시도 — 여기가 "흐릿한 추정 금지"의 핵심 ----------------
    // 해독기를 스텁으로 갈아끼워 카메라 없이 판정 로직만 본다.
    const stub = seq => { let i = 0; return () => Promise.resolve(seq[i++] || null); };
    const G = '041604414855', H = '194252721247';
    let r;

    checks++;
    r = await S.decodeWithRetries('x', stub([null, null, null]));
    if (!(r.ok === false && r.reason === 'no-barcode'))
      bad.push('아무것도 못 읽었는데 값을 만들어냈다: ' + JSON.stringify(r));

    checks++;
    r = await S.decodeWithRetries('x', stub([null, { code: G, format: 'upc_a' }, { code: G, format: 'upc_a' }]));
    if (!(r.ok && r.code === G))
      bad.push('같은 값이 두 번 나왔는데 확정하지 못했다: ' + JSON.stringify(r));

    checks++;
    r = await S.decodeWithRetries('x', stub([{ code: G, format: 'upc_a' }, { code: H, format: 'upc_a' }, null]));
    if (!(r.ok === false && r.reason === 'ambiguous'))
      bad.push('시도마다 다른 값이 나왔는데 하나를 골라버렸다 — 이게 넘겨짚기다: ' + JSON.stringify(r));

    checks++;
    r = await S.decodeWithRetries('x', stub([{ code: '041604414856', format: 'upc_a' },
                                             { code: '041604414856', format: 'upc_a' }, null]));
    if (r.ok !== false)
      bad.push('체크디지트가 틀린 해독 결과를 값으로 받아들였다: ' + JSON.stringify(r));

    checks++;
    r = await S.decodeWithRetries('x', stub([{ code: '04252614', format: 'upc_e' },
                                             { code: '04252614', format: 'upc_e' }]));
    if (!(r.ok && r.code === '042100005264'))
      bad.push('UPC-E 를 UPC-A 로 펴지 못했다: ' + JSON.stringify(r));

    checks++;
    r = await S.decodeWithRetries('x', stub([{ code: '0049000028911', format: 'ean_13' },
                                             { code: '0049000028911', format: 'ean_13' }]));
    if (!(r.ok && r.code === '049000028911'))
      bad.push('0으로 시작하는 EAN-13 을 12자리로 정규화하지 못했다: ' + JSON.stringify(r));

    // --- 7. 한계 표시가 살아 있는가 (조사 9-D · 원칙 C2·C3) ---------------
    // 문구는 카피 세션이 다듬어도 되지만, **판정이 사라지면 안 된다.**
    // "찍으면 최저가를 찾아드립니다"로 조용히 바뀌는 것을 막는 자리다.
    checks++;
    const marks = (S.SCAN_LIMITS || []).map(l => l.mark).join('');
    if (!(marks.indexOf('🟢') >= 0 && marks.indexOf('🟡') >= 0 && marks.indexOf('🔴') >= 0))
      bad.push('실효 범위 표시(🟢🟡🔴)가 빠졌다 — 한계를 먼저 말하기로 한 자리다');
    checks++;
    const red = (S.SCAN_LIMITS || []).filter(l => l.mark === '🔴').map(l => l.ko).join(' ');
    for (const must of ['TV', '코스트코', '자체 브랜드'])
      if (red.indexOf(must) < 0)
        bad.push('안 통하는 것 목록에서 "' + must + '"가 빠졌다 (조사 9-C 실측 판정)');

    __fuzz.lastScan = bad;
    return { mode: 'scan', 검사: checks, 실패: bad.length, 상세: bad.slice(0, 20) };
  }

  // 전부 한 번에
  function all(opt) {
    opt = opt || {};
    const seed = opt.seed == null ? 42 : opt.seed;
    return {
      golden: runGolden(),
      recheck: runRecheckBoth(),
      parse: runParse(),
      math: run({ n: opt.n || 1000, seed }),
      dom: runDom({ n: opt.dom || 40, seed }),
      // 영어 렌더 — 같은 페르소나를 영어로 그려보고 화면에 한국어가 남는지까지 본다.
      domEn: runDomEn({ n: opt.domEn || 25, seed }),
      compare: runCompare({ n: opt.cmp || 150, seed }),
    };
  }

  // koLeak 은 대조군(negcontrol-i18n.js)이 단위로 검사한다 — '사용자 데이터는 미번역이 아니다'가
  // 이 함수 한 곳에 걸려 있어서, 여기가 조용히 느슨해지면 영어 검사 전체가 같이 무의미해진다.
  return { run, runDom, runDomEn, runCompare, runGolden, runRecheck, runRecheckBoth, runParse, runScan, runVision, all, koLeak,
           last: null, lastDom: null, lastCompare: null, lastGolden: null, lastRecheck: null, lastParse: null, lastScan: null };
})();
'fuzz harness loaded';
