/* 음성 대조군 — 영어 렌더 검사(__fuzz.runDomEn)와 한국어 고정(__fuzz.runDom)이
 * 실제로 실패하는지 확인한다. "확인 없는 0건 실패는 아무 의미가 없다" (tests/README.md)
 *
 * 배포 대상 아님. 개발 중에만 콘솔에서 돌린다(fuzz-personas.js 를 먼저 로드할 것):
 *   fetch('tests/fuzz-personas.js?cb='+Date.now()).then(r=>r.text()).then(eval)
 *   fetch('tests/negcontrol-i18n.js?cb='+Date.now()).then(r=>r.text()).then(eval)
 *   console.table(__negI18n())
 *
 * 이 대조군이 지키는 것은 두 가지다.
 *  ① **번역이 빠지면 시끄럽게 실패하는가** — 영어 화면에 한국어가 남는 걸 조용히 넘기면
 *     "STRINGS.en 키 개수 452" 같은 숫자는 아무것도 증명하지 않는다.
 *  ② **사용자 데이터를 미번역으로 오인하지 않는가** — 판매처명이 한국어인 건 정상이다.
 *     여기서 오탐이 나면 검사가 시끄러워져 결국 꺼지게 되고, 그러면 ①도 같이 죽는다.
 *     그래서 마지막 두 줄(대조군·한국어 판매처명)이 **0이어야 통과**다.
 */
window.__negI18n = function () {
  if (!window.__fuzz || !__fuzz.runDomEn) throw new Error('fuzz-personas.js 를 먼저 로드할 것');

  const snapEn = Object.assign({}, STRINGS.en);
  const snapKo = Object.assign({}, STRINGS.ko);
  const wipe = o => Object.keys(o).forEach(k => delete o[k]);
  const restore = () => {
    wipe(STRINGS.en); Object.assign(STRINGS.en, snapEn);
    wipe(STRINGS.ko); Object.assign(STRINGS.ko, snapKo);
  };
  const drop = (...ks) => ks.forEach(k => { delete STRINGS.en[k]; });
  const dropPrefix = p => Object.keys(STRINGS.en).forEach(k => { if (k.indexOf(p) === 0) delete STRINGS.en[k]; });

  const EN = o => __fuzz.runDomEn(Object.assign({ n: 6, seed: 5 }, o));
  const KO = o => __fuzz.runDom(Object.assign({ n: 6, seed: 5 }, o));

  // [이름, 망가뜨리기, 돌릴 것, 기대]
  // 기대 '실패' = 이 변형은 반드시 걸려야 한다 / '0' = 이건 걸리면 오탐이다
  const MUT = [
    ['영어 사전을 통째로 비움 — 화면 전체가 한국어로 돌아간다',
      () => wipe(STRINGS.en), EN, '실패'],
    ['rcpt.net 번역 삭제 — 결론의 "Net cost" 가 사라진다(하니스가 리터럴로 찾는 자리)',
      () => drop('rcpt.net'), EN, '실패'],
    ['site.rcpt.amt 번역 삭제 — 사이트 결론의 "Estimated charge" 가 사라진다',
      () => drop('site.rcpt.amt'), EN, '실패'],
    ['concl.* 전부 삭제 — 결론 문단이 한국어로 남는다',
      () => dropPrefix('concl.'), EN, '실패'],
    ['보호 문구 삭제(rcpt.pendingNote · concl.base.sub) — 예정(펜딩)·절약 아님이 한국어로 남는다',
      () => drop('rcpt.pendingNote', 'concl.base.sub'), EN, '실패'],
    ['"0%가 아니라 모름" 3종 삭제(portal.noData · portal.needCheck · site.noData)',
      () => drop('portal.noData', 'portal.noData.sub', 'portal.needCheck', 'site.noData'), EN, '실패'],
    ['cur.cash.label 삭제 — 카드 배지에 "현금" 이 남는다(TYPE[].label 직접 읽기 회귀 감시)',
      () => drop('cur.cash.label'), EN, '실패'],
    ['정적 마크업 키 삭제(th.* · sellers.*) — 표 헤더와 카드 제목이 한국어로 남는다',
      () => { dropPrefix('th.'); dropPrefix('sellers.'); }, EN, '실패'],
    ['입력칸 placeholder 번역 삭제(start.paste.ph · sc.portalName.ph) — textContent 사각지대',
      () => drop('start.paste.ph', 'sc.portalName.ph'), EN, '실패'],
    ['카드 힌트·조건 삭제(card.* · cond.*) — 카드표 꼬리표가 한국어로 남는다',
      () => { dropPrefix('card.'); dropPrefix('cond.'); }, EN, '실패'],
    ['한국어 원문을 바꿔치기(STRINGS.ko["rcpt.net"]) — 한국어 검사가 아직 살아 있는가',
      () => { STRINGS.ko['rcpt.net'] = '순비용'; }, KO, '실패'],
    ['영어 "0%가 아니라 모름"을 지움 — 영어 재확인 검사가 실제로 도는가',
      () => drop('portal.needCheck', 'concl.portalUnknown'),
      () => { const r = __fuzz.runRecheck({ lang: 'en' }); return { failed: r.실패, sample: r.상세.map(w => ({ why: w })) }; }, '실패'],
    ['영어만 지웠을 때 한국어 재확인은 멀쩡한가 — 두 언어가 서로 독립인지',
      () => drop('portal.needCheck', 'concl.portalUnknown'),
      () => { const r = __fuzz.runRecheck({ lang: 'ko' }); return { failed: r.실패, sample: r.상세.map(w => ({ why: w })) }; }, '0'],

    // ↓ 여기부터는 **0이어야** 통과다
    ['koLeak 단위 — 사용자가 넣은 한국어 판매처명은 미번역이 아니다(오탐 감시)',
      () => {}, () => {
        // 오탐이 나면 검사가 시끄러워져 결국 꺼지고, 그러면 위 11줄이 통째로 죽는다.
        const bad = [];
        if (__fuzz.koLeak('Net cost at 동네 가게 — $12.00', ['동네 가게']))
          bad.push({ why: '사용자가 넣은 판매처명을 미번역으로 오인했다' });
        if (__fuzz.koLeak('Buy at 가게3', ['가게3', 'Nike']))
          bad.push({ why: '여러 사용자 값 중 하나만 제외했다' });
        // 반대 방향 — 진짜 미번역은 반드시 잡아야 한다
        if (!__fuzz.koLeak('실제 부담 $12.00 at Nike', ['Nike']))
          bad.push({ why: '진짜 한국어 누출을 못 잡았다 — 제외 로직이 너무 넓다' });
        return { failed: bad.length, sample: bad };
      }, '0'],
    ['대조군 — 아무것도 안 망가뜨림 (영어)', () => {}, EN, '0'],
    ['대조군 — 아무것도 안 망가뜨림 (한국어)', () => {}, KO, '0'],
  ];

  const out = [];
  for (const [name, mutate, run, expect] of MUT) {
    restore();
    const before = JSON.stringify(Object.keys(STRINGS.en).length) + '/' + JSON.stringify(STRINGS.ko['rcpt.net']);
    mutate();
    const 소스변경 = (JSON.stringify(Object.keys(STRINGS.en).length) + '/' + JSON.stringify(STRINGS.ko['rcpt.net'])) !== before;
    let r;
    try { r = run(); } catch (e) { r = { failed: 'throw: ' + e.message, sample: [] }; }
    const ok = (expect === '실패') ? (r.failed > 0) : (r.failed === 0);
    out.push({
      변형: name, 소스변경: 소스변경, 기대: expect, 실패: r.failed, 판정: ok ? '✅' : '❌ 이 검사는 헛돈다',
      예시: (r.sample || []).slice(0, 1).map(x => String(x.why).slice(0, 110)),
    });
  }
  restore();
  // 대조군이 끝나면 화면을 정상 상태로 되돌려 둔다
  applyI18n(); applyBrand(); buildAll(); recompute();
  return out;
};
'negcontrol-i18n loaded';
