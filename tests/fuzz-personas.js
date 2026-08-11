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
      // 단조성 — 오퍼는 뺀 상태로 본다.
      // 오퍼엔 최소 사용액(=문턱)이 있어서 가격/쿠폰이 문턱을 넘나들면 실부담이 계단처럼 튄다.
      // 그건 의도된 동작이므로, 여기선 연속적인 부분(카드 적립·포털·세금·배송)만 검사한다.
      if (r.price > 0) {
        const flat = Object.assign({}, p.sc, { offers: {} });
        const b0 = scenarioResult(flat, p.cat);
        const up = scenarioResult(Object.assign({}, flat, { portalPct: (+flat.portalPct || 0) + 1 }), p.cat);
        if (up.netCash > b0.netCash + 1e-6) bad.push('포털 % 올렸는데 실부담 증가');
        const cUp = scenarioResult(Object.assign({}, flat, { coupon: (+flat.coupon || 0) + 10 }), p.cat);
        if (cUp.netCash > b0.netCash + 1e-6) bad.push('쿠폰 늘렸는데 실부담 증가');
        const pUp = scenarioResult(Object.assign({}, flat, { price: (+flat.price || 0) + 50 }), p.cat);
        if (pUp.netCash < b0.netCash - 1e-6) bad.push('가격 올렸는데 실부담 감소');
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
  const DIRT = /NaN|undefined|Infinity|\$-0\.00|null|실제 부담[^\n]*-\$|실제 부담-\$/;

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
        const txt = document.getElementById('finalConclusion').innerText + '\n' +
                    document.getElementById('compareBody').innerText + '\n' +
                    document.getElementById('cardbody').innerText;
        if (DIRT.test(txt)) fails.push({ seed, i, mode: 'product', why: '화면에 깨진 값', hit: (txt.match(DIRT) || [])[0], excerpt: txt.slice(0, 400), p });

        // --- 사이트 모드
        document.getElementById('siteStore').value = p.sc.store;
        document.getElementById('siteCat').value = p.cat;
        document.getElementById('siteAmt').value = p.sc.price;
        document.getElementById('rkPct').value = Math.round(G.between(0, 15));
        document.getElementById('tcbPct').value = Math.round(G.between(0, 15));
        document.getElementById('capPct').value = Math.round(G.between(0, 15));
        siteOffers = {};
        p.wallet.forEach(id => { if (G.chance(0.15)) siteOffers[id] = Math.round(G.between(5, 100)); });
        computeSite();
        const st = document.getElementById('siteRec').innerText + '\n' + document.getElementById('portalWinner').innerText;
        if (DIRT.test(st)) fails.push({ seed, i, mode: 'site', why: '화면에 깨진 값', hit: (st.match(DIRT) || [])[0], excerpt: st.slice(0, 400), p });
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
      const tie = res.filter(r => Math.abs(r.net - truth.net) < 0.005).length > 1;
      if (!tie && shown !== (truth.sc.store || '(판매처?)')) {
        fails.push({ seed, i, why: '비교표 1위(' + shown + ') ≠ 실부담 최저(' + truth.sc.store + ')', nets: res.map(r => [r.sc.store, +r.net.toFixed(2)]) });
      }
      if (!tie && badge && truth.sc.store && badge.innerText.indexOf(truth.sc.store) < 0) {
        fails.push({ seed, i, why: '결론 배지가 1위 판매처를 안 가리킴', badge: badge.innerText.slice(0, 120), truth: truth.sc.store });
      }
    }
    myWallet = keep.wallet; cppValues = keep.cpp; scenarios = keep.scen; CARDS = activeCards();
    __fuzz.lastCompare = fails;
    return { mode: 'compare', seed, n, failed: fails.length, sample: fails.slice(0, 8) };
  }

  return { run, runDom, runCompare, last: null, lastDom: null, lastCompare: null };
})();
'fuzz harness loaded';
