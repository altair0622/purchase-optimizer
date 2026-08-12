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
  const DIRT = /NaN|undefined|Infinity|\$-0\.00|null|\[object |\$\{|실제 부담[^\n]*-\$|실제 부담-\$/;

  // ⚠️ DIRT 만으로는 "아무것도 안 그려진 경우"를 못 잡는다(빈 문자열엔 오염이 없다).
  //    결론이 통째로 비어도 통과했으므로, 최소한 이만큼은 나와야 한다고 못 박는다.
  function checkRendered(where, txt, must, bad) {
    if (!txt || !txt.trim()) { bad.push(`${where}: 아무것도 렌더되지 않음`); return; }
    must.forEach(m => { if (txt.indexOf(m) < 0) bad.push(`${where}: "${m}" 가 결론에 없음`); });
    if (!/\$[\d,]/.test(txt)) bad.push(`${where}: 금액이 하나도 없음`);
  }

  function runDom(opt) {
    opt = opt || {};
    const n = opt.n || 40, seed = opt.seed == null ? 99 : opt.seed;
    const rnd = mulberry32(seed), G = mk(rnd);
    const fails = [];
    const keep = { wallet: myWallet.slice(), cpp: Object.assign({}, cppValues), scen: scenarios.slice() };

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
        const concl = document.getElementById('finalConclusion').innerText;
        const txt = concl + '\n' +
                    document.getElementById('compareBody').innerText + '\n' +
                    document.getElementById('cardbody').innerText;
        if (DIRT.test(txt)) fails.push({ seed, i, mode: 'product', why: '화면에 깨진 값', hit: (txt.match(DIRT) || [])[0], excerpt: txt.slice(0, 400), p });
        // 실제로 결론이 그려졌는가 + 비교표 행 수가 가격 있는 시나리오 수와 맞는가
        const bad = [];
        // ⚠️ 기준은 정가가 아니라 **청구액**이다. recompute() 는 `price>0`(=소계+세금+배송)로
        //    필터하므로, 쿠폰이 정가보다 크면 청구액 0 → 그 판매처는 비교표에서 빠진다.
        //    (정가로 셌다가 오탐 1건이 났다. 참고로 "쿠폰 ≥ 정가라 공짜인 판매처가 비교표에서
        //     조용히 사라지는 것" 자체는 제품 쪽 판단 거리로 사용자에게 보고했다.)
        const priced = scenarios.filter(s => scenarioResult(s, p.cat).price > 0).length;
        if (priced > 0) {
          checkRendered('상품 결론', concl, ['실제 부담'], bad);
          const rowN = document.querySelectorAll('#compareBody tr').length;
          if (rowN !== priced) bad.push(`비교표 행 수 ${rowN} ≠ 가격 있는 판매처 ${priced}`);
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
        if (DIRT.test(st)) fails.push({ seed, i, mode: 'site', why: '화면에 깨진 값', hit: (st.match(DIRT) || [])[0], excerpt: st.slice(0, 400), p });
        const sbad = [];
        if (p.wallet.length && (+p.sc.price || 0) > 0) checkRendered('사이트 결론', siteTxt, ['결제 예상액', '실제 부담'], sbad);
        if (sbad.length) fails.push({ seed, i, mode: 'site', why: sbad.join(' | '), excerpt: siteTxt.slice(0, 200), p });
        setMode('product');
      } catch (e) {
        fails.push({ seed, i, why: 'throw: ' + e.message, stack: (e.stack || '').split('\n').slice(0, 3).join(' / '), p });
      }
    }

    myWallet = keep.wallet; cppValues = keep.cpp; scenarios = keep.scen;
    CARDS = activeCards();
    const out = { mode: 'dom', seed, n, failed: fails.length, sample: fails.slice(0, 10) };
    __fuzz.lastDom = fails;
    return out;
  }

  // ===== 3) 결론 정합성 — "화면이 말하는 1위"가 정말 실부담 최저인가 =====
  function runCompare(opt) {
    opt = opt || {};
    const n = opt.n || 100, seed = opt.seed == null ? 3 : opt.seed;
    const rnd = mulberry32(seed), G = mk(rnd);
    const fails = [];
    const keep = { wallet: myWallet.slice(), cpp: Object.assign({}, cppValues), scen: scenarios.slice() };

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

      const res = scenarios.map(sc => scenarioResult(sc, p.cat)).filter(r => r.price > 0);
      if (!res.length) continue;
      const truth = res.slice().sort((a, b) => a.net - b.net)[0];
      const firstRow = document.querySelector('#compareBody tr');
      const shown = firstRow ? firstRow.querySelector('td b').innerText.replace(/^\d+\.\s*/, '') : null;
      const badge = document.querySelector('#finalConclusion .savebadge');

      // 동점이면 '검사 생략'이 아니라 **동점 그룹 안에 있는가**로 본다.
      // 예전엔 동점이면 두 검사를 통째로 건너뛰어서, 모든 net 을 같게 만들면
      // 60건이 전부 조용히 통과했다(아무것도 검증하지 않은 채로).
      const tied = res.filter(r => Math.abs(r.net - truth.net) < 0.005);
      const tiedNames = tied.map(r => r.sc.store || '(판매처?)');
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
        const allNames = res.map(r => r.sc.store || '(판매처?)')
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

  // 전부 한 번에
  function all(opt) {
    opt = opt || {};
    const seed = opt.seed == null ? 42 : opt.seed;
    return {
      golden: runGolden(),
      math: run({ n: opt.n || 1000, seed }),
      dom: runDom({ n: opt.dom || 40, seed }),
      compare: runCompare({ n: opt.cmp || 150, seed }),
    };
  }

  return { run, runDom, runCompare, runGolden, all,
           last: null, lastDom: null, lastCompare: null, lastGolden: null };
})();
'fuzz harness loaded';
