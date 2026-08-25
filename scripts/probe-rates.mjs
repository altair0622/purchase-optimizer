// 포털 요율이 **하루 중 언제** 바뀌는지 재는 측정 스크립트. (P3)
//
// 왜: `update-rates.yml` 은 매일 14:17 UTC 에 돈다. `:17` 분은 근거가 있지만(GitHub Actions 는
// 정각에 예약 작업이 몰려 지연된다) **시(hour)는 근거가 없다.** 주석엔 "미 동부 오전 —
// Rakuten 공개 기본율 갱신"이라 적혀 있는데 **우리가 잰 적이 없다.**
// Rakuten 공식 FAQ 에도 "매일 바뀔 수 있다"만 있고 시각은 없다. → 물어볼 데가 없으니 잰다.
//
// ⚠️ 이 스크립트는 **rates.json 을 절대 건드리지 않는다.** 라이브가 그걸 읽는다.
//    측정이 제품 데이터를 오염시키면 안 된다. 출력은 `rate-probe.jsonl` 한 곳뿐이다.
//
// ⭐ **진짜 데이터는 `probe-data` 브랜치에 있다.**
//    `main` 은 GitHub Pages 소스 브랜치라(`build_type: legacy`, `source.branch: main`)
//    **커밋 하나가 배포 하나**다. 매시간 커밋하면 하루 24회 배포가 일어난다 —
//    8/25 13:01Z·14:00Z 봇 커밋이 실제로 Pages 배포를 트리거한 것을 실행 이력에서 봤다.
//    측정 데이터는 라이브가 읽지 않으므로 main 에 있을 이유가 없다.
//    ⚠️ `main` 에도 같은 이름의 사본이 남아 있는데 **8/25 전환 이전의 잔재**다.
//       지우려면 main 에 커밋해야 하고 그것도 배포라서, **다음 정당한 배포 때 삭제한다.**
//       그때까지 어느 쪽이 진짜인지 헷갈릴 자리다 — 진짜는 probe-data 다.
//
// 출력: 한 줄 = {"t":"<UTC ISO>","store":"nike","rk":8,"tcb":10}  (append only)
//       기본은 repo 루트의 rate-probe.jsonl, `PROBE_OUT` 이 있으면 그 경로로.

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
// ⚠️ 파싱 규칙은 update-rates.mjs 와 **같은 모듈**을 쓴다. 복사하면 두 벌이 갈라진다.
import { parseTitle, fetchTitle, fetchTcb, loadStores } from './portal-parse.mjs';

// 워크플로가 probe-data 브랜치를 따로 체크아웃해서 그 안의 파일을 가리킨다.
// ⚠️ 로컬에서 그냥 돌리면 예전처럼 repo 루트에 쌓인다 — 그건 커밋하지 말 것.
// ⚠️ 손으로 file:// URL 을 만들지 않는다 — 윈도우 경로의 역슬래시·공백 이스케이프를
//    직접 다루면 반드시 틀린다(실제로 한 번 틀렸다). pathToFileURL 이 그 일을 한다.
const OUT = process.env.PROBE_OUT
  ? pathToFileURL(process.env.PROBE_OUT)
  : new URL('../rate-probe.jsonl', import.meta.url);

// ---------------------------------------------------------------------------
// ⭐ 종료 조건 — **사람이 끄는 걸 기억해야 하는 구조로 만들지 않는다**
// ---------------------------------------------------------------------------
// 시작일로부터 5일이 지나면 스스로 아무것도 안 하고 끝난다. 워크플로를 지우는 걸
// 누가 잊어도 요청이 계속 나가지 않는다. 부하가 이 작업의 유일한 실제 위험이라서,
// "끄는 것"을 사람 기억에 맡기면 안 된다.
const START = '2026-08-25';        // 측정 시작일(UTC). 바꾸면 창이 통째로 옮겨간다
const DAYS = 5;
const deadline = new Date(START + 'T00:00:00Z').getTime() + DAYS * 86400_000;
// ⚠️ 창이 끝나서 안 쓰는 것과, 고장나서 못 쓰는 것을 **워크플로가 구분할 수 있어야 한다.**
//    둘 다 "파일에 변화 없음"으로 똑같이 보이는데, 앞은 정상이고 뒤는 회차를 잃은 거다.
//    구분이 없으면 조용히 비고, 나중에 "그 시각엔 변동이 없었다"로 잘못 읽힌다.
function signal(k, v) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}
`);
}

if (Date.now() > deadline) {
  console.log(`측정 창(${START} +${DAYS}일)이 끝났다 — 아무것도 하지 않고 종료.`);
  console.log('워크플로(.github/workflows/probe-rates.yml)를 지워도 된다.');
  signal('window', 'closed');
  process.exit(0);
}
signal('window', 'open');

// ---------------------------------------------------------------------------
// 대상 8곳 — **감이 아니라 git 이력에서 실제 변동 횟수를 세서 골랐다**
// ---------------------------------------------------------------------------
// rates.json 커밋 25개(2026-07-30 ~ 08-21)를 훑어 판매처별로 rk/tcb/cap 중 하나라도
// pct 가 바뀐 횟수를 셌다. 비교 가능했던 횟수로 나눈 **변동률**로 정렬했다
// (판매처가 21→57→114 곳으로 늘어서 절대 횟수만 보면 오래된 곳이 유리해진다).
//
//   booking  7/8 (.88)   expedia 6/8 (.75)   priceline 6/8 (.75)   gnc     4/8  (.50)
//   macys   11/24(.46)   nike   11/24(.46)   adidas   5/11(.45)    logitech 3/8 (.38)
//   athleta  4/11(.36)   columbia 4/11(.36)  hotels   3/8 (.38)    ...
//
// ⚠️ **여행 사이트를 2곳으로 제한했다.** 변동률 상위 4곳(booking·expedia·priceline·hotels)이
//    전부 여행인데, 4곳을 다 넣으면 "같은 시각에 바뀐다"는 결과가 나와도
//    **포털 전체 갱신인지 여행 카테고리만의 일정인지 구분할 수 없다.**
//    카테고리를 섞어야 "포털 전체가 한 시각에 바뀐다"는 결론을 낼 수 있다.
// ⚠️ **슬러그를 여기 적지 않는다.** index.html 의 STORE_LIST 에서 가져온다 —
//    update-rates 와 같은 표를 보게 하려는 것이다. 처음엔 손으로 적었다가 곧바로 틀렸다:
//    booking 의 Rakuten 슬러그를 'booking-com' 으로 썼는데 실제로는 'booking' 이다
//    (TopCashback 만 'booking-com'). 이 프로젝트가 슬러그 이중 관리로 이미 한 번 당한 그 지점이다.
const PROBE_KEYS = ['booking', 'expedia', 'gnc', 'macys', 'nike', 'adidas', 'logitech', 'athleta'];
const ALL = loadStores();
const STORES = PROBE_KEYS.map(k => {
  const row = ALL.find(x => x[0] === k);
  if (!row) throw new Error(`STORE_LIST 에 '${k}' 가 없다 — 이름이 바뀌었나?`);
  return row;
});

// ---------------------------------------------------------------------------
// 부하 — 이 작업의 유일한 실제 위험
// ---------------------------------------------------------------------------
// 현재 일 228요청(114곳×2포털)에 이 측정이 384요청(8×2×24)을 더한다 → 약 2.7배.
// **차단당하면 지금 잘 도는 114곳까지 같이 죽는다.** 벌크 수집을 접었던 이유가 이거다.
// → 요청 사이에 간격을 두고, **연속 실패가 나면 그 판매처를 이 회차에서 건너뛴다.**
const GAP_MS = 1500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const t = new Date().toISOString();
const rows = [];
let fails = 0, consecutiveFails = 0, skipped = 0;

for (const [key, rkSlug, tcbSlug] of STORES) {
  // 연속 실패가 3번 나면 그 회차는 접는다 — 차단 중일 가능성이 높고,
  // 그 상태로 계속 찌르면 차단이 길어진다.
  if (consecutiveFails >= 3) { skipped++; console.log(`  ${key}: 건너뜀(연속 실패 ${consecutiveFails})`); continue; }

  const rk = rkSlug ? parseTitle(await fetchTitle(rkSlug)) : null;
  await sleep(GAP_MS);
  const tcb = tcbSlug ? await fetchTcb(tcbSlug) : null;
  await sleep(GAP_MS);

  if (rk == null && tcb == null) { fails++; consecutiveFails++; }
  else consecutiveFails = 0;

  // ⚠️ 실패를 0% 로 뭉개지 않는다 — null 로 남긴다. "못 읽음"과 "0%"는 다른 값이고,
  //    0% 로 적으면 나중에 "그 시각에 0으로 떨어졌다"는 **없는 변동**을 만들어낸다.
  //    이 도구가 계속 지켜온 원칙과 같다.
  const row = {
    t, store: key,
    rk: rk ? (rk.flat != null ? null : rk.pct) : null,
    tcb: tcb ? tcb.pct : null,
  };
  if (rk && rk.upTo) row.rkUpTo = true;
  if (tcb && tcb.upTo) row.tcbUpTo = true;
  if (rk && rk.flat != null) row.rkFlat = rk.flat;
  if (rk == null) row.rkFail = true;
  if (tcb == null) row.tcbFail = true;

  rows.push(row);
  console.log(`  ${key}: RK ${rk ? (rk.flat != null ? '$' + rk.flat : rk.pct + '%') : 'FAIL'} · TCB ${tcb ? tcb.pct + '%' : 'FAIL'}`);
}

if (!rows.length) {
  // ⚠️ 조용히 끝내지 않는다. 창이 열려 있는데 한 줄도 못 얻었으면 **그 회차는 잃은 것**이고,
  //    P3 는 시각을 재는 측정이라 잃은 회차는 다시 못 잰다. 빨간 X 로 보여야 한다.
  console.error('한 줄도 못 얻었다 — 파일을 건드리지 않고 종료. ⚠️ 이 회차는 구멍이다.');
  process.exit(1);
}

appendFileSync(OUT, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`\n${t} — ${rows.length}줄 기록${fails ? ` · 실패 ${fails}` : ''}${skipped ? ` · 건너뜀 ${skipped}` : ''}`);

// 차단 징후를 로그에 눈에 띄게 남긴다 — Actions 로그를 훑을 때 바로 보이게.
if (fails >= STORES.length / 2) {
  console.log('⚠️ 절반 이상 실패 — 차단 징후일 수 있다. 워크플로를 멈추고 확인할 것.');
}
