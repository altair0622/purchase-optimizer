# vendor — 우리가 직접 커밋해 둔 제3자 코드

여기 있는 파일은 **런타임에 CDN에서 불러오지 않는다.** 우리 저장소에 커밋해
**같은 출처(priceafter.com)에서** 필요할 때만 지연 로딩한다.

이유는 두 가지고, 둘 다 구속 문서다:

- **프라이버시-원칙 H7 — 원격 코드를 불러와 실행하지 않는다.** CDN 스크립트는
  제3자가 사후에 내용을 바꿀 수 있다. 그 구조 자체를 만들지 않는다.
- **v0.27 감사에서 확립한 "외부 스크립트 0개".** 같은 출처에서 받는 파일은
  `rates.json`과 같은 등급이라 이 원칙을 깨지 않는다
  (`리서치/바코드-매장스캔-조사.md` 8-D 표).

---

## quagga2.min.js

| | |
|---|---|
| 패키지 | `@ericblade/quagga2` |
| 버전 | **1.12.1** |
| 라이선스 | **MIT** (`quagga2.LICENSE` 원문 동봉 — MIT는 저작권 고지 동봉이 조건) |
| 크기 | **156,608 B** (gzip -9 기준 42,803 B) |
| 출처 | `https://registry.npmjs.org/@ericblade/quagga2/-/quagga2-1.12.1.tgz` 의 `package/dist/quagga.min.js` |
| 받은 날 | 2026-08-18 |
| 손 안 댐 | **npm 배포본과 바이트 단위로 동일.** 우리가 한 줄도 고치지 않았다 |

### 진짜 그 파일인지 직접 확인하는 법

```bash
# 1) npm 레지스트리가 말하는 타르볼 해시
curl -s https://registry.npmjs.org/@ericblade/quagga2/1.12.1 | grep -o '"shasum":"[^"]*"'
#    → "shasum":"ed71780fbb96c7c8a180d70bad20284b5f73f351"

# 2) 타르볼을 받아 그 해시가 맞는지
curl -sL https://registry.npmjs.org/@ericblade/quagga2/-/quagga2-1.12.1.tgz -o q2.tgz
sha1sum q2.tgz

# 3) 타르볼 안의 파일이 이 저장소의 파일과 같은지
tar xzf q2.tgz package/dist/quagga.min.js
cmp package/dist/quagga.min.js site/vendor/quagga2.min.js && echo IDENTICAL
```

이 저장소 사본의 SHA-256:

```
ae6c469103c5d427625a9a4c41175bd15420a14aa5579ea57dc1571d42346f4d
```

### 이 파일이 밖으로 요청을 보내나 — 안 보낸다

받은 직후 소스에서 직접 센 것(2026-08-18):

| 찾은 것 | 건수 | 무엇인가 |
|---|---|---|
| `http://` | **0** | — |
| `https://` | 1 | **regenerator-runtime의 MIT 라이선스 주석 URL.** 코드가 아니다 |
| `Worker(` | 1 | `Blob` + `createObjectURL`로 만드는 **같은 출처 워커.** 우리는 `numOfWorkers: 0`으로 꺼서 아예 안 만든다 |
| `navigator.mediaDevices` / `getUserMedia` | 2 / 2 | **실시간 스트림 경로 전용.** 우리는 `decodeSingle()`만 쓰므로 이 경로에 진입하지 않는다 |
| `createObjectURL` | 1 | 위 워커 생성용 |

즉 **사진은 이 기기 밖으로 나가지 않는다.** 해독은 전부 브라우저 안에서 끝난다.

### 왜 이 라이브러리인가

`리서치/바코드-매장스캔-조사.md` 2-C·8-E 실측 비교. 요지만:

- **크기가 경쟁 라이브러리의 1/2.3.** ZXing UMD 362,150 B · zxing-wasm 1,093,289 B
- **1D 전용 설계** — `upc_reader`·`upc_e_reader`·`ean_reader`·`ean_8_reader` 포함. QR은 우리에게 필요 없다
- **정지 이미지 API가 문서에 명시** — `decodeSingle()`이 *"does not rely on getUserMedia and operates on a single image instead"*
- **`blob:` URL이면 EXIF `orientation`을 라이브러리가 직접 읽어 보정한다**(소스에서 확인). 아이폰 사진의 회전 문제가 여기서 이미 처리된다

⚠️ **인식 정확도는 아직 검증되지 않았다.** 신뢰할 벤치마크를 찾지 못했고, 라이브러리
자체 주장은 근거로 쓰지 않는다. **실기 측정 도구가 `site/tests/scan-field-test.html`에
있다** — 실제 매장 상품을 찍어 성공률을 재고, **낮으면 이 기능을 버린다.**
