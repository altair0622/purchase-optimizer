/* 음성 대조군 — 파서를 일부러 망가뜨려 runParse 가 실제로 실패하는지 확인한다.
 * "확인 없는 0건 실패는 아무 의미가 없다" (tests/README.md)
 * 배포 대상 아님. 개발 중에만 콘솔에서 돌린다(fuzz-personas.js 를 먼저 로드할 것):
 *   fetch('tests/negcontrol-parse.js?cb='+Date.now()).then(r=>r.text()).then(eval)
 *   __negParse().then(o=>console.table(o))
 */
window.__negParse = function () {
  // 페이지 자신의 소스를 읽는다 — 어디에 배치돼도 경로가 어긋나지 않게
  return fetch(location.pathname + '?cb=' + Date.now()).then(r => r.text()).then(html => {
    const a = html.indexOf('function escHtml('), b = html.indexOf('// ---- 붙여넣기 UI ----');
    if (a < 0 || b < 0) throw new Error('파서 구간 마커를 못 찾음');
    // 페이지 전역에 const 로 선언된 이름들이 있어 재선언이 안 된다 →
    // 파서 구간을 new Function 안에서 다시 만들고, 결과 함수만 window 에 갈아끼운다.
    // offerWallet 선언은 지운다: 지우지 않으면 함수 안 사본을 보게 되어
    // runParse 가 채워 넣은 지갑을 못 읽는다(= 검사가 헛돌게 된다).
    const PRISTINE = html.slice(a, b).replace(/\r\n?/g, '\n')
      .replace(/\nlet offerWallet\s*=\s*\{\};/, '\n')
      .replace(/\nlet ofpPending\s*=\s*null;/, '\n');
    const EXPORTS = ['parseOfferDump','ofpValue','ofpIsDescription','ofpStoreHit','ofpAmountFor','ofpSuggestions','ofpExpired','ofpKey'];
    function install(src) {
      const made = new Function(src + '\nreturn {' + EXPORTS.join(',') + '};')();
      EXPORTS.forEach(k => { window[k] = made[k]; });
    }

    const MUT = [
      ['설명문 판정을 꺼버림 — 가맹점명 자리에 홍보문구가 들어간다',
        s => s.replace('function ofpIsDescription(line){', 'function ofpIsDescription(line){ return false;')],
      ['값 줄 하드스톱 제거 — 앞 오퍼의 "15% cash back" 이 가맹점명이 된다',
        s => s.replace('if(j>=0 && OFP_CHASE_VALUE.test(L[j])){', 'if(false){')],
      ['"Nd left" 건너뛰기 제거 — 만료 잔여물이 가맹점명이 된다',
        s => s.replace('|| /^\\d{1,3}d left$/.test(s);', ';')],
      ['중복 제거를 끔 — 캐러셀 오퍼를 두 번 센다',
        s => s.replace('if(seen[key]){', 'if(false){')],
      ['Chase 만료일을 지어냄 — 소스에 없는 값을 만들어낸다',
        s => s.replace('expiry: expiry || OFFER_EXPIRY_UNKNOWN, badges, descSkipped',
                       'expiry: expiry || {known:true,iso:asOf,source:"absolute"}, badges, descSkipped')],
      ['못 읽은 블록을 조용히 버림',
        s => s.split('skipped.push(').join('[].push(')],
      ['가맹점 대조를 부분일치로 완화 — 엉뚱한 가게 오퍼가 붙는다',
        s => s.replace('return (m.length>=4 && s.length>=4) && (s.indexOf(m)===0 || m.indexOf(s)===0);',
                       'return s.indexOf(m)>=0 || m.indexOf(s)>=0;')],
      ['마일 오퍼를 현금으로 취급',
        s => s.replace("return { kind:'miles', amount:0", "return { kind:'fixed', amount:0")],
      ['만료된 오퍼를 계속 제안',
        s => s.replace('function ofpExpired(o, today){', 'function ofpExpired(o, today){ return false;')],
      ['최소 사용액 미달을 무시',
        s => s.replace('if(o.minSpend!=null && charge>0 && charge < o.minSpend)', 'if(false)')],
      ['퍼센트 오퍼 상한을 무시',
        s => s.replace('if(o.cap!=null && v>o.cap){', 'if(false){')],
      ['가맹점명 대신 혜택 문구를 저장 — 개수는 그대로라 개수만 세면 못 잡는다',
        s => s.replace('offers.push({ merchant, offerText, nameConf, kind:val.kind',
                       'offers.push({ merchant:offerText, offerText, nameConf, kind:val.kind')],
      ['대조군 — 아무것도 안 망가뜨림', s => s],
    ];

    const out = [];
    for (const pair of MUT) {
      const name = pair[0], mutated = pair[1](PRISTINE);
      const 소스변경 = (mutated !== PRISTINE);
      let r;
      try { install(mutated); r = __fuzz.runParse(); }
      catch (e) { r = { 실패: 'throw: ' + e.message, 상세: [] }; }
      out.push({ 변형: name, 소스변경: 소스변경, 실패: r.실패, 예시: (r.상세 || []).slice(0, 2) });
      install(PRISTINE);
    }
    return out;
  });
};
'negcontrol loaded';
