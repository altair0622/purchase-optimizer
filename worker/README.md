# price-proxy — 가격 자동조회용 Cloudflare Worker

계산기(`../index.html`)가 상품 페이지 가격을 읽어오기 위해 쓰는 서버리스 함수.
상품 URL을 받아 **가격만 파싱해서 JSON으로** 돌려준다.

## 왜 필요한가

계산기는 GitHub Pages에 올라간 정적 페이지라 다른 사이트를 직접 못 부른다(CORS).
그래서 공개 CORS 프록시 3개를 돌려썼는데, 2026-08-11 점검 결과:

| 프록시 | 상태 |
|---|---|
| corsproxy.io | ❌ HTTP 403 |
| api.allorigins.win | ❌ 무응답 |
| r.jina.ai | ✅ 동작 |

살아있는 건 하나뿐인데 순서상 마지막이라, 가격 하나 읽는 데 20초를 기다린 뒤에야
값이 떴다. 사용자 입장에선 "자동조회가 안 된다"로 보였다.

## 배포 (한 번만)

Cloudflare 계정이 필요하다. 무료 플랜으로 충분하다(10만 요청/일).

```bash
cd site/worker
npx wrangler login
npx wrangler deploy
```

배포되면 이런 URL이 나온다:

```
https://purchase-optimizer-price.<계정이름>.workers.dev
```

이 URL을 `site/index.html` 의 `PRICE_API` 상수에 넣고 커밋·푸시하면 끝이다.
비워두면 계산기는 기존 공개 프록시 체인으로만 동작한다(성공률 낮음).

## 확인

```bash
curl "https://purchase-optimizer-price.<계정>.workers.dev/?url=https://www.crocs.com/p/207021.html"
```

```json
{ "price": 34.99, "title": "…", "status": 200 }
```

## API

`GET /?url=<상품 URL>`

| 필드 | 뜻 |
|---|---|
| `price` | 파싱된 가격(숫자). 못 찾으면 `null` |
| `title` | og:title 또는 `<title>` — 계산기가 URL 슬러그로 추정하는 것보다 정확하다 |
| `status` | 원 사이트의 HTTP 상태 |
| `cached` | 30분 캐시에서 나온 응답이면 `true` |
| `error` | 실패 사유(사람이 읽는 문장) |

가져오기에 실패해도 **HTTP 200에 `price: null`** 로 응답한다. 계산기가 조용히
"직접 입력" 안내로 넘어가게 하기 위해서다.

## 설계상 정한 것

- **HTML을 그대로 돌려주지 않는다.** 가격만 파싱해 반환한다 → 아무나 쓰는 범용
  오픈 프록시가 되는 걸 막고, 응답 크기도 훨씬 작다.
- **SSRF 차단** — 사설망·루프백·링크로컬(`169.254.169.254` 같은 클라우드 메타데이터
  주소 포함)로는 요청을 보내지 않는다.
- **30분 캐시** — 같은 상품을 여러 번 열어도 원 사이트엔 한 번만 간다.
- **CORS 허용 오리진 고정** — `ALLOW_ORIGINS` 배열. 배포 도메인이 바뀌면 여기도 고쳐야 한다.

## 한계 (중요)

**서버를 둔다고 봇 차단이 풀리지는 않는다.** CORS만 사라진다.
Best Buy처럼 Akamai/PerimeterX급 봇 탐지를 쓰는 곳은 서버에서 불러도 막힌다.
Cloudflare IP가 AWS보다는 덜 막히지만 만능은 아니다.

근본적인 해결은 스크레이핑이 아니라 **공식 상품 API·제휴 네트워크 피드**다:

- Best Buy Developer API — 무료, 키 발급만
- eBay Browse API — 무료, 개발자 계정
- Amazon PA-API 5.0 — Associates 승인 + 실판매 유지 필요
- Rakuten Advertising · CJ · Impact — 상품 피드 + 커미션율 + 정식 추적 링크

이 워커는 그 전 단계의 임시 다리다.
