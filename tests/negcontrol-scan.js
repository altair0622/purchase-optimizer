/* 음성 대조군 — 스캐너를 일부러 망가뜨려 runScan 이 실제로 실패하는지 확인한다.
 * "확인 없는 0건 실패는 아무 의미가 없다" (tests/README.md)
 * 배포 대상 아님. 개발 중에만 콘솔에서 돌린다(fuzz-personas.js 를 먼저 로드할 것):
 *   fetch('tests/fuzz-personas.js?cb='+Date.now()).then(r=>r.text()).then(eval)
 *   fetch('tests/negcontrol-scan.js?cb='+Date.now()).then(r=>r.text()).then(eval)
 *   __negScan().then(o=>console.table(o))
 *
 * scanner.js 는 ES 모듈이라 negcontrol-parse.js 와 방식이 조금 다르다:
 * import.meta 와 export 를 걷어내고 new Function 안에서 다시 만든 뒤,
 * 그 객체를 runScan(mod) 에 **인자로 넘긴다**(전역 window.__scanner 는 건드리지 않는다).
 */
window.__negScan = function () {
  const SRC = new URL('scanner.js', location.href).href;
  return fetch(SRC + '?cb=' + Date.now()).then(r => r.text()).then(raw => {

    // new Function 안에서 돌 수 있게 모듈 문법을 걷어낸다.
    // import.meta 는 함수 본문에서 문법 오류라 그 줄을 통째로 없앤다(테스트에 안 쓰인다).
    const PRISTINE = raw.replace(/\r\n?/g, '\n')
      .replace(/^const QUAGGA_URL = .*$/m, "const QUAGGA_URL = '';")
      .replace(/^export (async function|function|const)/gm, '$1')
      .replace(/\nif \(typeof window !== 'undefined'\) window\.__scanner = \{[\s\S]*?\n\};\s*$/, '\n');

    const EXPORTS = ['gs1CheckDigit', 'hasValidCheckDigit', 'expandUpcE', 'toCanonical',
                     'normalizeManualEntry', 'buildDeepLinks', 'decodeWithRetries',
                     'DEEP_LINK_STORES', 'DEEP_LINK_BLOCKED', 'DECODE_ATTEMPTS', 'SCAN_LIMITS'];

    function build(src) {
      return new Function(src + '\nreturn {' + EXPORTS.join(',') + '};')();
    }

    // 먼저 확인: 걷어낸 소스가 애초에 만들어지기는 하는가.
    // (여기서 터지면 아래 "변형이 안 먹었다"와 구분이 안 되므로 먼저 본다)
    try { build(PRISTINE); }
    catch (e) { return [{ 변형: '⚠️ PRISTINE 자체가 안 만들어짐 — 아래 결과 전부 무의미', 소스변경: false, 실패: 'throw: ' + e.message, 예시: [] }]; }

    const BB = "  { id: 'bestbuy', name: 'Best Buy', build: c => 'https://www.bestbuy.com/site/searchpage.jsp?st=' + encodeURIComponent(c) },";

    const MUT = [
      ['체크디지트 검사를 꺼버림 — 오타 난 번호를 그대로 검색한다',
        s => s.replace('function hasValidCheckDigit(code) {', 'function hasValidCheckDigit(code) { return true;')],

      ['체크디지트 가중치를 뒤집음 (3,1 → 1,3) — 진짜 UPC가 거부된다',
        s => s.replace('sum += (i % 2 === 0) ? d * 3 : d;', 'sum += (i % 2 === 0) ? d : d * 3;')],

      ['0으로 시작하는 EAN-13에서 앞의 0을 안 뗌 — 미국 소매가 못 찾는 13자리로 검색한다',
        s => s.replace("if (code.length === 13 && code[0] === '0') return code.slice(1);",
                       "if (false) return code.slice(1);")],

      ['UPC-E 체크디지트 대조를 제거 — 잘못 읽은 UPC-E를 펴서 내보낸다',
        s => s.replace('if (upcA[11] !== code8[7]) return null;', 'if (false) return null;')],

      ['UPC-E 압축 분기 하나(X6=3)를 죽임 — 그 계열이 엉뚱한 UPC-A가 된다',
        s => s.replace("} else if (last === '3') {", '} else if (false) {')],

      ['손입력이 8자리를 받아들임 — EAN-8과 UPC-E를 구분 못 하는데 넘겨짚는다',
        s => s.replace('if (s.length !== 12 && s.length !== 13)',
                       'if (s.length !== 12 && s.length !== 13 && s.length !== 8)')],

      ['딥링크에 Walmart 추가 — UPC 검색을 아예 안 받는 곳이다(3/3 무결과, 대조군 통과)',
        s => s.replace(BB, BB + "\n  { id: 'walmart', name: 'Walmart', build: c => 'https://www.walmart.com/search?q=' + encodeURIComponent(c) },")],

      ['딥링크에 어필리에이트 태그를 붙임 — H4·H5 위반',
        s => s.replace("'https://www.amazon.com/s?k=' + encodeURIComponent(c)",
                       "'https://www.amazon.com/s?k=' + encodeURIComponent(c) + '&tag=priceafter-20'")],

      ['★ 시도마다 다른 값이 나와도 첫 값을 골라버림 — 이게 "흐릿한 추정"이다',
        s => s.replace("if (distinct.length > 1)   return { ok: false, reason: 'ambiguous', codes: distinct };",
                       'if (false) return null;')],

      ['★ 아무것도 못 읽었는데 값을 만들어냄',
        s => s.replace("if (distinct.length === 0) return { ok: false, reason: 'no-barcode', tried: list.length };",
                       "if (distinct.length === 0) return { ok: true, code: '000000000000' };")],

      ['★ 체크디지트를 통과 못 한 해독 결과도 값으로 받음',
        s => s.replace('if (canon) got.push(canon);', 'got.push(canon || String(r.code));')],

      ['실효 범위에서 🔴(안 통하는 것) 줄을 지움 — 한계를 안 말하게 된다',
        s => s.replace(/\n  \{ mark: '🔴',[\s\S]*?why: '[^']*' \},/, '')],

      ['대조군 — 아무것도 안 망가뜨림', s => s],
    ];

    const out = [];
    let chain = Promise.resolve();
    for (const pair of MUT) {
      const name = pair[0];
      chain = chain.then(() => {
        const mutated = pair[1](PRISTINE);
        const 소스변경 = (mutated !== PRISTINE);
        let mod;
        try { mod = build(mutated); }
        catch (e) { out.push({ 변형: name, 소스변경, 실패: 'build throw: ' + e.message, 예시: [] }); return; }
        return __fuzz.runScan(mod).then(
          r => { out.push({ 변형: name, 소스변경, 실패: r.실패, 예시: (r.상세 || []).slice(0, 2) }); },
          e => { out.push({ 변형: name, 소스변경, 실패: 'run throw: ' + e.message, 예시: [] }); });
      });
    }
    return chain.then(() => out);
  });
};
'negcontrol-scan loaded';
