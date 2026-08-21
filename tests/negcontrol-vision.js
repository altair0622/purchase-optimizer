/* 음성 대조군 — 사진 인식(vision.js)을 일부러 망가뜨려 runVision 이 실제로 실패하는지 확인한다.
 * "확인 없는 0건 실패는 아무 의미가 없다" (tests/README.md)
 * 배포 대상 아님. 개발 중에만 콘솔에서 돌린다(fuzz-personas.js 를 먼저 로드할 것):
 *   fetch('tests/fuzz-personas.js?cb='+Date.now()).then(r=>r.text()).then(eval)
 *   fetch('tests/negcontrol-vision.js?cb='+Date.now()).then(r=>r.text()).then(eval)
 *   __negVision().then(o=>console.table(o))
 *
 * vision.js 는 ES 모듈이라 negcontrol-scan.js 와 같은 방식이다:
 * export 를 걷어내고 new Function 안에서 다시 만든 뒤, 그 객체를 runVision(mod) 에
 * **인자로 넘긴다**(전역 window.__vision 은 건드리지 않는다).
 *
 * ⚠️ `buildSearchLinks` / `needsReask` / `reaskReason` / `guessedLine` / `shapeResult` /
 *    `precheck` / `laplacianVar` / `dayCount` / `bumpDay` / `todayStr` / `askText` 와
 *    상수 `SEARCH_STORES` / `ASK_COPY` / `DAILY_CAP` / `MIN_LONG_EDGE` / `LONG_EDGE` /
 *    `JPEG_QUALITY` 는 **이름으로 찾는다.** 개명하면 아래 변형 문자열도 같이 고쳐야 하고,
 *    안 고치면 **변형이 안 먹은 채로 "대조군이 통과했다"고 보고한다** —
 *    그래서 `소스변경` 필드를 같이 찍는다. 이 값이 false 인데 실패가 0이면
 *    그건 통과가 아니라 **검사가 헛돈 것**이다.
 */
window.__negVision = function () {
  const SRC = new URL('vision.js', location.href).href;
  return fetch(SRC + '?cb=' + Date.now()).then(r => r.text()).then(raw => {

    // new Function 안에서 돌 수 있게 모듈 문법을 걷어낸다.
    // 화면·네트워크 함수는 테스트에 안 쓰이지만 문법상 남아 있어도 되므로 그대로 둔다.
    const PRISTINE = raw.replace(/\r\n?/g, '\n')
      .replace(/^export (async function|function|const)/gm, '$1')
      .replace(/\nif \(typeof window !== 'undefined'\) window\.__vision = \{[\s\S]*?\n\};\s*$/, '\n');

    const EXPORTS = ['SEARCH_STORES', 'buildSearchLinks', 'ASK_COPY', 'askText',
                     'needsReask', 'reaskReason', 'guessedLine', 'shapeResult',
                     'MIN_LONG_EDGE', 'MIN_LAPLACIAN_VAR', 'laplacianVar', 'precheck',
                     'DAILY_CAP', 'dayCount', 'bumpDay', 'todayStr',
                     'shouldPromote', 'queryIsGrounded', 'PROMOTE_DAILY_CAP', 'promoteCount', 'bumpPromote',
                     'PROMOTE_LONG_EDGE',
                     // 승격 상한 흐름 검사가 실제 DOM 경로를 태우려면 이 둘이 필요하다
                     'handleFile', 'resetVision',
                     'LONG_EDGE', 'JPEG_QUALITY'];

    function build(src) {
      return new Function(src + '\nreturn {' + EXPORTS.join(',') + '};')();
    }

    // 먼저 확인: 걷어낸 소스가 애초에 만들어지기는 하는가.
    // (여기서 터지면 아래 "변형이 안 먹었다"와 구분이 안 되므로 먼저 본다)
    try { build(PRISTINE); }
    catch (e) { return Promise.resolve([{ 변형: '⚠️ PRISTINE 자체가 안 만들어짐 — 아래 결과 전부 무의미', 소스변경: false, 실패: 'throw: ' + e.message, 예시: [] }]); }

    const BB = "  { id: 'bestbuy', name: 'Best Buy', ev: 'unknown',  build: q => 'https://www.bestbuy.com/site/searchpage.jsp?st=' + encodeURIComponent(q) },";

    const MUT = [
      // ★ 이 기능의 존재 이유 — "조용히 그럴듯하게 틀리지 않는다"
      ['★ 상한에 걸렸을 때 안내를 안 띄움 (조용한 누락 — 1차 결과인 줄 모른다)',
        s => s.replace('{ renderPromoteCapped(); return; }', '{ return; }')],

      ['★ 상한 안내가 1차 결과를 지움 (덧붙이기가 아니라 갈아끼움)',
        // ⚠️ appendChild 는 showSeeking 에도 있다 — 주석까지 포함해 **유일한 줄**을 찍는다
        s => s.replace('  box.appendChild(el);   // ← 1차 결과를 지우거나 바꾸지 않는다. 덧붙이기만 한다.', '  box.innerHTML = String(); box.appendChild(el);')],

      ['★ 승격 해상도를 1차와 같게 (12.4초로 되돌아간다)',
        s => s.replace('const PROMOTE_LONG_EDGE = 768;', 'const PROMOTE_LONG_EDGE = 1568;')],

      ['★ 숫자만 겹쳐도 뿌리로 침 (짐작뿐인데 승격을 안 하게 된다)',
        s => s.replace("      if (!/[a-z]/.test(t)) continue;          // 순수 숫자는 브랜드가 아니다", '')],

      ['★ 글자를 읽었는데도 승격함 — 비용이 5배로 튄다',
        s => s.replace('  return !queryIsGrounded(result);                // 검색어가 읽은 글자에 안 걸려 있으면 = 짐작뿐',
                       '  return true;')],

      ['★ 승격 하루 상한을 0으로 (승격이 영영 안 일어난다)',
        s => s.replace('const PROMOTE_DAILY_CAP = 40;', 'const PROMOTE_DAILY_CAP = 0;')],

      ['★ 승격 판단을 꺼버림 — 글자 없는 사진에서 영영 답을 못 낸다',
        // ⚠️ PRISTINE 은 export 를 이미 걷어낸 뒤다 — 붙이면 변형이 안 먹는다(전에 한 번 당했다)
        s => s.replace('function shouldPromote(result) {',
                       'function shouldPromote(result) { return false;')],
      ['★ read 가 비어도 안 되묻음 — 짐작뿐인 검색어를 확신처럼 내놓는다',
        s => s.replace('  if (!result.read || !result.read.length) return true;    // ← 급소',
                       '  if (false) return true;')],

      ['★ 모델의 ask 만 믿고 되묻음 — 실측에서 모델은 못 읽어도 12/12 확신했다',
        s => s.replace('function needsReask(result) {',
                       'function needsReask(result) { return !!(result && result.ok && result.ask && result.ask.reason);')],

      ['★ 후보가 0개인데도 안 되묻음 — 갈 곳 없는 화면',
        s => s.replace('  if (!result.candidates || !result.candidates.length) return true;',
                       '  if (false) return true;')],

      ['★ UNVERIFIED 내부 표시가 화면에 그대로 샘 — "짐작"이 사용자에게 안 보인다',
        s => s.replace('function guessedLine(s) {', 'function guessedLine(s) { return String(s || \'\');')],

      ['★ 되묻기 문구를 "다시 찍어 주세요"로 뭉갬 — 조사 9장 #5가 금지한 것',
        s => s.replace('function askText(reason) {', "function askText(reason) { return '다시 찍어 주세요';")],

      ['★ 딥링크에 어필리에이트 태그를 붙임 — H4·H5 위반',
        s => s.replace("build: q => 'https://www.amazon.com/s?k=' + encodeURIComponent(q)",
                       "build: q => 'https://www.amazon.com/s?k=' + encodeURIComponent(q) + '&tag=priceafter-20'")],

      ['딥링크 목록이 조용히 늘어남 (eBay 추가 — 실측 안 된 곳)',
        s => s.replace(BB, BB + "\n  { id: 'ebay', name: 'eBay', ev: 'unknown', build: q => 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(q) },")],

      ['★ Walmart 를 뺌 — 키워드 검색은 UPC와 달리 통한다(조사 3-E). 사진 경로의 이득이 사라진다',
        s => s.replace(/\n  \{ id: 'walmart',[\s\S]*?\n/, '\n')],

      ['빈 검색어로도 링크를 만듦',
        s => s.replace("  if (!q) return [];                       // 빈 검색어로 링크를 만들지 않는다",
                       '  if (false) return [];')],

      ['프리체크가 못 잰 사진을 막음 — 막는 쪽이 더 나쁘다',
        s => s.replace("  if (!(longEdge > 0)) return 'ok';", "  if (!(longEdge > 0)) return 'too-small';")],

      ['해상도 미달을 통과시킴 — 글자가 물리적으로 안 담긴 사진에 돈을 쓴다',
        s => s.replace("  if (longEdge < MIN_LONG_EDGE) return 'too-small';", '  if (false) return null;')],

      ['흐림 판정을 꺼버림',
        s => s.replace("  if (lapVar != null && lapVar < MIN_LAPLACIAN_VAR) return 'blurry';", '  if (false) return null;')],

      ['라플라시안 분산을 평균으로 바꿈 (평평한 판이 0이 아니게 된다)',
        s => s.replace('  return sum2 / n - mean * mean;', '  return sum2 / n;')],

      ['★ 하루 상한이 날짜를 무시함 — 첫날 20장 쓰면 영영 못 쓴다',
        s => s.replace("    return (j && j.d === today) ? (+j.n || 0) : 0;", '    return (+j.n || 0);')],

      ['저장소가 깨졌을 때 예외가 새어나감 (사파리 프라이빗에서 기능이 죽는다)',
        s => s.replace('  } catch (e) { return 0; }', '  } finally { }')],

      ['★ 업로드 긴 변을 1024 로 되돌림 — 12px 구간 실패율이 100% 로 돌아간다',
        // ⚠️ PRISTINE 은 `export ` 를 이미 걷어낸 뒤다. 여기에 export 를 붙이면
        //    변형이 안 먹고 소스변경:false 로 조용히 헛돈다(실제로 한 번 그랬다).
        s => s.replace('const LONG_EDGE = 1568;', 'const LONG_EDGE = 1024;')],

      ['shapeResult 가 빈 query 후보를 안 버림',
        s => s.replace("    .filter(c => c && typeof c.query === 'string' && c.query.trim())",
                       '    .filter(c => c)')],

      ['shapeResult 가 오류를 성공으로 봄',
        s => s.replace('  if (!j || j.ok !== true) {', '  if (false) {')],

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
        return __fuzz.runVision(mod).then(
          r => { out.push({ 변형: name, 소스변경, 실패: r.실패, 예시: (r.상세 || []).slice(0, 2) }); },
          e => { out.push({ 변형: name, 소스변경, 실패: 'run throw: ' + e.message, 예시: [] }); });
      });
    }
    return chain.then(() => out);
  });
};
'negcontrol-vision loaded';
