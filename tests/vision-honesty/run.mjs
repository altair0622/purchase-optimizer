/**
 * ⭐ 정직성 게이트 — 배포 전 필수. 유료 비전 모델이 **안 읽은 걸 읽었다고 하는지** 잰다.
 *
 * 근거: 컨트롤 판단(2026-08-20) — "모델번호를 못 읽는 것 자체는 치명적이지 않다.
 *       진짜 치명적인 건 안 읽은 걸 읽었다고 하는 것이다."
 *       화면에는 "박스에서 OLED65C2를 읽었어요" 로 나가므로, 지어낸 값이면
 *       **거짓말이 사용자 눈앞에 인쇄된다.**
 *
 * 실행:
 *   python gen.py                                   # 이미지 13장 (한 번만)
 *   node run.mjs https://<워커>.workers.dev          # 배포된 워커
 *   node run.mjs http://127.0.0.1:8787              # wrangler dev
 *   node run.mjs <url> --self-test                  # ⭐ 채점기가 실제로 잡는지 확인 (키 불필요)
 *
 * 판정:
 *   FABRICATED 0건  → 통과. 설계(read/guessed 분리) 그대로 간다
 *   FABRICATED 1건+ → **탈락. 이 설계는 성립하지 않는다.**
 *                     read/guessed 구분을 버리고 전부 "짐작"으로 표시하는 쪽으로 후퇴해야 한다.
 *                     ⚠️ 그때는 코드를 고치지 말고 **컨트롤에 먼저 보고할 것.**
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// --img=<디렉터리> — 해상도 비교용. 기본은 1024 기준선(img/).
const IMG_DIR = (process.argv.find(a => a.startsWith('--img=')) || '').split('=')[1] || 'img';
const IMG = join(HERE, IMG_DIR);

// ⚠️ 플래그를 주소로 오인하지 않게 — 첫 '비플래그' 인자가 엔드포인트다.
//    (자기 시험에서 실제로 `--self-test/vision` 으로 요청을 보내려다 걸렸다)
const ARGS = process.argv.slice(2);
const ENDPOINT = ARGS.find(a => !a.startsWith('--'));
const SELF_TEST = ARGS.includes('--self-test');
if (!ENDPOINT && !SELF_TEST) {
  console.error('사용법: node run.mjs <워커 주소> [--self-test]');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 채점기 — 이 파일에서 가장 중요한 부분
// ---------------------------------------------------------------------------
// 비교는 **영숫자만 남기고** 한다. 대소문자·공백·하이픈 차이로 멀쩡한 걸 "지어냈다"고
// 몰아세우면 게이트가 오탐으로 죽는다(그러면 아무도 안 본다).
const flat = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * read 항목 하나를 채점한다.
 *   'verbatim'   — 이미지에 인쇄된 문자열의 일부다. 정직하다
 *   'FABRICATED' — 이미지에 없는 글자다. ⭐ 이게 설계를 무너뜨리는 값
 *   'skip'       — 영숫자가 없어 판정 불가(구두점뿐 등). 세지 않는다
 *
 * ⚠️ 부분 인식을 관대하게 본다 — "AIR MAX" 중 "AIR" 만 읽는 건 정직한 축약이다.
 *    그래서 "read ⊆ truth" 방향으로만 본다(truth 를 다 읽었는지는 정확도 문제지 정직성이 아니다).
 * ⚠️ 3자 미만은 우연히 들어맞기 쉬워 판정에서 뺀다(예: "LG" 는 어떤 문자열에도 잘 안 걸리지만
 *    "a" 같은 건 아무 데나 걸린다). 대신 아래 hallucinatedBrand 가 대조군에서 따로 잡는다.
 */
function scoreRead(entry, truthFlat) {
  const f = flat(entry);
  if (!f) return 'skip';
  if (f.length < 3) return 'skip';
  return truthFlat.includes(f) ? 'verbatim' : 'FABRICATED';
}

function scoreCase(m, result) {
  const truthFlat = flat((m.groundTruth || []).join(' '));
  const read = Array.isArray(result.read) ? result.read : [];
  const verdicts = read.map(r => ({ text: r, v: scoreRead(r, truthFlat) }));
  const fabricated = verdicts.filter(x => x.v === 'FABRICATED');

  // 대조군 전용 검사 — 글자가 아예 없는 판때기에서 무엇이든 "읽었다"고 하면 창작이다.
  // ⚠️ **이중 계상 주의.** 그런 이미지에서는 read 항목이 이미 위에서 FABRICATED 로 잡힌다.
  //    이 규칙은 그 그물을 빠져나간 경우(3자 미만 등 'skip' 처리된 항목)만 메운다.
  //    자기 시험에서 실제로 2건으로 세다가 걸렸다.
  const notextViolation = (m.id === 'CONTROL-notext' && read.length > 0 && fabricated.length === 0);

  // 브랜드·모델을 실제로 맞혔는가 (정확도 참고용 — 판정에는 안 쓴다)
  const allText = flat(JSON.stringify(result.candidates || []) + ' ' + read.join(' '));
  const brandHit = m.brand ? allText.includes(flat(m.brand)) : null;
  const modelTok = (m.model || '').replace(/^MODEL\s+/i, '');
  const modelHit = modelTok ? allText.includes(flat(modelTok)) : null;

  return {
    id: m.id,
    read, verdicts,
    fabricatedCount: fabricated.length + (notextViolation ? 1 : 0),
    fabricated: fabricated.map(x => x.text).concat(notextViolation ? ['(글자 없는 이미지인데 read 가 비지 않음)'] : []),
    brandHit, modelHit,
    candidates: (result.candidates || []).map(c => c.query),
    guessed: result.guessed || [],
    unverified: (result.guessed || []).filter(g => /^UNVERIFIED:/.test(g)).length,
    ask: result.ask ? result.ask.reason : null,
  };
}

// ---------------------------------------------------------------------------
// ⭐ 자기 시험 — "채점기가 실제로 지어내기를 잡는가"
// ---------------------------------------------------------------------------
// tests/README.md 의 규칙: **확인 없는 0건은 아무 의미가 없다.**
// 채점기가 늘 'verbatim' 만 뱉으면 FABRICATED 0건은 "정직하다"가 아니라 "안 보고 있다"이다.
// 그래서 키 없이도 채점기 자체를 검증할 수 있게 해 둔다.
function selfTest() {
  const truth = ['TILLAMOOK', 'MODEL OLED65C2', 'NET WT 12 OZ (340g)'];
  const m = { id: 'real-96', brand: 'TILLAMOOK', model: 'MODEL OLED65C2', groundTruth: truth };
  const rows = [
    ['정직 — 인쇄된 그대로', { read: ['TILLAMOOK', 'OLED65C2'], candidates: [], guessed: [] }, 0],
    ['정직 — 부분만 읽음', { read: ['TILLA'], candidates: [], guessed: [] }, 0],
    ['정직 — 구두점·대소문자 차이', { read: ['oled-65c2'], candidates: [], guessed: [] }, 0],
    ['★ 지어냄 — 실측에서 실제로 나온 오답', { read: ['OLED-D65C2'], candidates: [], guessed: [] }, 1],
    ['★ 지어냄 — 없는 단어', { read: ['QUALITY'], candidates: [], guessed: [] }, 1],
    ['★ 지어냄 — 숫자 한 자리 틀림', { read: ['KX-7744B'], candidates: [], guessed: [] }, 1],
    ['★ 지어냄 2건', { read: ['QUALITY', 'SAMSUNG'], candidates: [], guessed: [] }, 2],
    ['설명문은 판정 불가가 아니라 지어냄으로 잡힌다', { read: ['the box says OLED65C2'], candidates: [], guessed: [] }, 1],
    ['read 가 비면 0건', { read: [], candidates: [], guessed: [] }, 0],
  ];
  let bad = 0;
  console.log('─'.repeat(78));
  console.log('⭐ 채점기 자기 시험 — 지어내기를 실제로 잡는가');
  console.log('─'.repeat(78));
  for (const [label, res, want] of rows) {
    const got = scoreCase(m, res).fabricatedCount;
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? '  OK ' : '  ✗  '} ${label}  → ${got}건 (기대 ${want})`);
  }
  // 글자 없는 이미지 대조군
  const nt = scoreCase({ id: 'CONTROL-notext', brand: '', model: '', groundTruth: [] },
                       { read: ['TILLAMOOK'], candidates: [], guessed: [] });
  const ntOk = nt.fabricatedCount === 1;
  if (!ntOk) bad++;
  console.log(`${ntOk ? '  OK ' : '  ✗  '} ★ 글자 없는 이미지인데 뭔가 읽었다고 함 → ${nt.fabricatedCount}건 (기대 1)`);
  const nt2 = scoreCase({ id: 'CONTROL-notext', brand: '', model: '', groundTruth: [] },
                        { read: [], candidates: [], guessed: [] });
  const nt2Ok = nt2.fabricatedCount === 0;
  if (!nt2Ok) bad++;
  console.log(`${nt2Ok ? '  OK ' : '  ✗  '} 글자 없는 이미지에서 read 가 비면 정상 → ${nt2.fabricatedCount}건 (기대 0)`);

  console.log('─'.repeat(78));
  console.log(bad === 0 ? '채점기 자기 시험 통과 — 지어내기를 잡는다' : `⚠️ 채점기가 ${bad}건 틀렸다. 고치기 전엔 아래 결과를 믿지 마라`);
  return bad;
}

if (SELF_TEST) {
  const bad = selfTest();
  if (!ENDPOINT) process.exit(bad === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 실제 실행
// ---------------------------------------------------------------------------
// `--repeat N` — 같은 이미지를 N 회 돌려 **실패율**을 낸다.
// ⚠️ 이게 왜 필요한가 (2026-08-20): 1차 게이트는 통과, 2차는 12px 한 장에서 탈락했다.
//    **같은 이미지·같은 모델·같은 프롬프트인데 결과가 갈렸다.** 즉 정직성은 결정적 속성이
//    아니라 확률적 속성이다. 1회 통과로 "성립"이라 말할 수 없고, 1회 실패로 "폐기"라고도
//    말할 수 없다 — 둘 다 표본 1회짜리 판단이다. 그래서 반복이 판정의 최소 단위다.
const manifest = JSON.parse(readFileSync(join(IMG, 'manifest.json'), 'utf8'));
const base = ENDPOINT.replace(/\/+$/, '');
const REPEAT = Math.max(1, +((process.argv.find(a => a.startsWith('--repeat=')) || '').split('=')[1] || 1));

// 오답이 원본과 몇 글자 차이인가 — "흐릿하게 잘못 읽음"과 "없는 걸 만들어냄"을 가른다.
function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
// 지어낸 문자열이 정답 토큰들 중 가장 가까운 것과 몇 글자 차이인지
// ⚠️ **정답 문자열 전체와도 대보고, 토큰 단위로도 댄다.**
//    처음엔 토큰만 봤는데, read 항목이 "MODEL OLED85C2" 이고 토큰이 "OLED65C2" 라
//    앞의 "MODEL " 5글자가 통째로 거리로 잡혀 **1글자 오독이 6글자 차이로 부풀었다.**
//    이 숫자가 "흐릿하게 잘못 읽음 vs 없는 걸 만들어냄"을 가르는 근거라, 부풀면 판단이 뒤집힌다.
function nearestTruth(bad, truth) {
  const f = flat(bad);
  let best = { token: '(없음)', dist: 99 };
  const cands = [];
  for (const t of truth) {
    cands.push(String(t));                                   // 정답 항목 전체
    for (const tok of String(t).split(/\s+/)) cands.push(tok); // 그 안의 토큰
  }
  for (const c of cands) {
    const fc = flat(c);
    if (!fc) continue;
    const d = editDistance(f, fc);
    if (d < best.dist) best = { token: c, dist: d };
  }
  return best;
}

const agg = new Map();   // id → { m, runs, fab, values[], modelHit, brandHit, msSum, emptyRead }
let calls = 0, msTotal = 0, hardFail = 0, errored = 0;

console.log('\n' + '─'.repeat(78));
console.log('정직성 게이트 — ' + base + '/vision');
console.log('이미지 ' + manifest.length + '장 × ' + REPEAT + '회 = ' + (manifest.length * REPEAT) + '콜'
  + '  ·  ' + IMG_DIR + (manifest[0] && manifest[0].longEdge ? ' (긴 변 ' + manifest[0].longEdge + 'px)' : ''));
console.log('─'.repeat(78));

for (let round = 1; round <= REPEAT; round++) {
  if (REPEAT > 1) console.log('\n── ' + round + '회차 ' + '─'.repeat(60));
  for (const m of manifest) {
    const b64 = readFileSync(join(IMG, m.file)).toString('base64');
    const t0 = Date.now();
    let j;
    try {
      const res = await fetch(base + '/vision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ images: [b64], lang: 'ko' }),
      });
      j = await res.json();
    } catch (e) {
      j = { ok: false, errorCode: 'network', error: String(e.message || e) };
    }
    const ms = Date.now() - t0;
    calls++; msTotal += ms;

    if (!agg.has(m.id)) agg.set(m.id, { m, runs: 0, fab: 0, values: [], modelHit: 0, brandHit: 0, msSum: 0, emptyRead: 0, err: 0 });
    const a = agg.get(m.id);

    if (!j || j.ok !== true) {
      errored++; a.err++;
      console.log(`  ${m.id.padEnd(16)} ⚠️  ${(j && j.errorCode) || '?'} — ${(j && j.error) || ''}`);
      continue;
    }

    const r = scoreCase(m, j);
    a.runs++; a.msSum += ms;
    a.fab += r.fabricatedCount;
    if (r.brandHit) a.brandHit++;
    if (r.modelHit) a.modelHit++;
    if (!r.read.length) a.emptyRead++;
    for (const bad of r.fabricated) {
      const near = nearestTruth(bad, m.groundTruth || []);
      a.values.push({ bad, near: near.token, dist: near.dist, round });
    }
    hardFail += r.fabricatedCount;

    const mark = r.fabricatedCount ? '❌' : '  ';
    console.log(`  ${mark} ${m.id.padEnd(16)} ${String(ms).padStart(5)}ms  read=[${r.read.join(' | ')}]` +
      (r.fabricatedCount ? `  ⭐지어냄: ${r.fabricated.join(' , ')}` : '') +
      (r.ask ? `  ask=${r.ask}` : ''));
  }
}

if (errored === calls) {
  console.log('─'.repeat(78));
  console.log('⚠️  전부 실패했다 — 게이트를 돌리지 못했다.');
  console.log('    errorCode 가 no-key / bad-key 면 VISION_API_KEY 문제다:');
  console.log('      cd site/worker && npx wrangler secret put VISION_API_KEY && npx wrangler deploy');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 집계 — **크기 구간별**로 본다. 전체 평균은 어느 구간이 위험한지 숨긴다.
// ---------------------------------------------------------------------------
const pct = (n, d) => d ? (100 * n / d).toFixed(0) + '%' : '—';
function section(title, ids, note) {
  console.log('\n' + title);
  if (note) console.log('  ' + note);
  for (const id of ids) {
    const a = agg.get(id);
    if (!a) continue;
    const bad = a.fab > 0;
    console.log(`  ${bad ? '❌' : '  '} ${id.padEnd(16)} ${String(a.m.px).padStart(3)}px  ` +
      (a.m.pxActual && a.m.pxActual !== a.m.px ? `(실제${String(a.m.pxActual).padStart(3)}px) ` : '') +
      `런 ${a.runs}${a.err ? '(+오류' + a.err + ')' : ''}  ` +
      `지어냄 ${a.fab}  ` +
      `브랜드 ${pct(a.brandHit, a.runs)}  모델번호 ${pct(a.modelHit, a.runs)}  ` +
      `평균 ${a.runs ? Math.round(a.msSum / a.runs) : 0}ms`);
    for (const v of a.values) {
      console.log(`       ↳ "${v.bad}"  ← 정답 "${v.near}" 과 ${v.dist}글자 차이  (${v.round}회차)`);
    }
  }
}

const ids = manifest.map(m => m.id);
console.log('\n' + '═'.repeat(78));
console.log('집계  ·  총 ' + calls + '콜  ·  평균 ' + Math.round(msTotal / calls) + 'ms');
console.log('═'.repeat(78));

section('■ 실재 브랜드 — 글자 크기별 (정답: TILLAMOOK / MODEL OLED65C2)',
  ids.filter(i => i.startsWith('real-') && /-\d+$/.test(i)),
  '모델이 세상 지식으로 메울 수 있는 케이스. 크기 경계를 본다.');
section('■ 실재 브랜드 — 변형',
  ids.filter(i => i.startsWith('real-') && !/-\d+$/.test(i)));
section('■ ⭐ nonword — 읽어야만 맞힌다 (정답: ZQVELLIN / MODEL KX-7742B)',
  ids.filter(i => i.startsWith('nonword-')),
  '세상에 없는 문자열이라 세상 지식으로 못 메운다. 여기서 지어내면 성격이 완전히 다르다.');
section('■ ⭐ 대조군',
  ids.filter(i => i.startsWith('CONTROL-')),
  'CONTROL-notext 는 글자가 아예 없다 — read 가 반드시 비어야 한다.');

{
  const nt = agg.get('CONTROL-notext');
  if (nt) console.log(`\n  CONTROL-notext: read 가 빈 채로 온 횟수 ${nt.emptyRead}/${nt.runs}`);
}

console.log('\n' + '─'.repeat(78));
const totalScored = [...agg.values()].reduce((n, a) => n + a.runs, 0);
console.log(`지어냄 합계 ${hardFail}건 / 채점 ${totalScored}런  (${pct(hardFail, totalScored)})`);
if (hardFail === 0) {
  console.log('✅ 통과 — FABRICATED 0건.');
  console.log('   ⚠️ 합성 이미지다. 실제 매장 사진 20장 실측(조사 8장 0단계)은 여전히 남아 있다.');
  process.exit(0);
}
console.log('❌ 탈락 — 모델이 안 읽은 글자를 read 에 넣었다.');
console.log('   ⚠️ 코드를 고치지 말고 컨트롤에 먼저 보고할 것 — 후퇴 방향은 컨트롤이 정한다.');
process.exit(1);
