# witness.euca.in

一般社団法人エンドユーザーコンピューティング協会（EUCA）が <https://witness.euca.in>
で運営する、相乗りの連署サーバーと確認サイトです。

[English](README.md)

自分たちが行ったことを改ざんの分かる形で記録している組織（[deedlog](https://github.com/eucassoc/deedlog)
のチェーン）は、その記録に何度でも署名できます。しかし、自分の署名だけでは、明日、別の履歴に
署名し直すこともできます。この連署サーバーは、組織の外の立場から、見せられたものが増えただけで
あることを確かめたうえで連署します。

見せられるのは、記録そのものではありません。組織は記録を手もとに置いたまま、一定の間隔ごとに、
もう一つの公開のチェーンへ要約を1件足します。前回からあとに加わった記録の指紋で、出来事が
あってもなくても預けます。連署サーバーが連署するのは、このチェーンです
（[c2sp.org/tlog-witness](https://c2sp.org/tlog-witness) のまま。`dlog cosign` がそのまま使えます）。
連署サーバーに分かるのは時間が経ったことだけで、組織が何件、いつ行ったかは分かりません。

誰に何が見えるか:

| | 見えるもの | 資格 |
|---|---|---|
| 記録の対象になっている本人 | 自分の記録の内容と、それが要約に含まれている証明 | 受け取ったリンク |
| 組織の監査担当 | すべての記録（このサイトの上の、自分のブラウザの中で） | ここと組織の両方に登録したパスキー |
| 誰でも | 採用されているルール、連署の状態、監査担当が署名した検証結果 | なし |
| EUCA | 区間ごとの要約と、監査担当の検証結果 | — |

監査担当は組織自身の人（内部監査室）です。件数を見てよい立場の人です。組織の外にあるのは、
要約と検証結果の置き場所です。組織は、要約の裏で記録を書き換えることも、検証結果を消したり
直したりすることもできません。

連署が示すのは、記録が書き換えられていないことです。記録の内容が事実であることは示しません。
記録は組織自身の申告です。

## 確認サイト

確認は、すべて見る人のブラウザの中で行います。

- `/#o=<origin>&t=<token>`: 本人のリンク。組織に `ref`（番号の SHA-256 の先頭32桁。番号そのものは
  どこにも送りません）の記録を求め、1件ずつ連署された要約と突き合わせて、平易な言葉で表示します。
  区間がまだ来ていない記録は、確認待ちとして表示します。
- `/#o=<origin>`: 誰でも。連署の状態、採用されているルール、監査担当の検証結果。検証結果の署名は、
  登録された鍵でその場で確かめます。
- `/#o=<origin>&audit`: 監査担当。パスキーを作る。それで組織に本人であることを示して記録の全体を
  受け取る。要約と突き合わせる。ルールに照らした指摘を、組織のサービスと同じコード
  （[tsutome](https://github.com/eucassoc/tsutome)）で計算する。結果に署名して、ここに残す。

## エンドポイント

| | |
|---|---|
| `POST /add-checkpoint` | c2sp.org/tlog-witness。`200` で連署の行、`409` で連署サーバーが持っているサイズ（`text/x.tlog.size`）、登録簿にない記録は `404`、運用者の署名を確認できないときは `403`、整合性の証明を確認できないときは `422`。 |
| `GET /witness.vkey` | 連署サーバーの検証用の鍵。 |
| `GET /status.json` | 各記録について最後に連署したチェックポイント: `{"witness": "<vkey>", "logs": {"<origin>": {"size", "root", "time"}}}`。 |
| `POST /results` | 監査担当が署名した検証結果: `{"statement": "<JSON の文字列>", "credential": {"id", "authenticatorData", "clientDataJSON", "signature"}}`。記録が登録されていて、パスキーがその監査担当のもので、署名が声明のハッシュに対するもので、このサイトで、声明の時刻から10分以内に作られていれば保管します。`201`、または理由つきの `4xx`。 |
| `GET /results.json?o=<origin>` | その記録について保管している検証結果。新しい順、200件まで。 |
| `GET /registry.json` | 連署する記録と、その監査担当の鍵の登録簿。 |

声明:

```json
{ "type": "audit-statement/v1", "origin": "dlm.example.com/contact", "auditor": "内部監査室",
  "at": "2026-11-19T03:25:00Z",
  "covers": { "anchors": 144, "root": "<チェックポイントのルート、base64>", "through": "2026-11-19T03:20:00Z" },
  "checks": { "records": "ok", "anchors": "ok", "cosignature": "ok" },
  "findings": { "overdue": 0, "late": 1, "unapproved": 0, "plan_mismatch": 0, "not_told": 0, "no_key": 0 },
  "note": "任意。500字まで" }
```

## 組織が用意するもの

登録簿の `url` の下に、`Access-Control-Allow-Origin: *` をつけて置きます。

- `GET /chain.jsonl`、`GET /checkpoint`: 公開のチェーン（名前は `origin`）。記録は
  `{event: "chain.anchored", epoch, commit}`。署名と連署のついたチェックポイント。
- `GET /item?ref=<16進32桁>`、`GET /rules`: `{origin, chain, records: [{body, anchor?: {seq, epoch, size, index, path, nonce, blind, record}}]}`。
  `body` は、記録の内容（出来事、時刻、識別用の番号）です。記録の subject のダイジェストの元になる
  JSON の文字列で、記録の行そのものは渡しません。公開のチェーンの `seq` 番の `commit` に行き着きます
  （[`public/tlog.js`](public/tlog.js) の `commitOf`）。`anchor` のない記録は、次の区間を待っています。
- `POST /audit/challenge`、続けて、そのチャレンジへのパスキーの署名をつけた `POST /audit/chain`:
  `{origin, chain, records: [line...], anchors: [{seq, epoch, from, to, size, nonce, pad}]}`。
- `GET /key`: 検証用の鍵。

## 記録を登録する

連署サーバーは、[`public/registry.json`](public/registry.json) にある記録にだけ連署します。
追加するには、`operators` に項目を足して（プルリクエスト、または管理者による編集）デプロイします。
[`registry.example.json`](registry.example.json) が例です。

```json
{
  "name": "例示株式会社 お問い合わせの取り扱い記録",
  "origin": "dlm.example.com/contact",
  "checkpoint_key": "dlm.example.com/contact+1a2b3c4d+AQ...",
  "url": "https://dlm.example.com/log",
  "auditors": [{ "name": "内部監査室", "id": "<鍵の識別子>", "key": "<公開鍵>", "alg": -7 }]
}
```

- `origin`: 公開のチェーンの名前。チェックポイントの鍵の名前でもあります。
- `checkpoint_key`: 運用者の検証用の鍵。
- `url`: 運用者が、上に挙げたものを置いている場所。
- `auditors`: 検証結果を保管して表示するパスキー。監査担当が確認サイト（`/#o=<origin>&audit`）で
  鍵を作ると、この JSON が表示されます。ここと組織の両方に登録します。

記録は、名前と鍵の組です。同じ名前を新しい鍵で登録し直すと、最初から始まります。登録簿から
なくなった記録について保管していたものは、消します。鍵を読めない項目や、鍵の名前が `origin`
と違う項目は受け付けません。

### 記録そのものを公開する場合

記録の件数や時刻を隠す必要のない運用者もいます。記録の対象がもともと公開しているデータ
（たとえば政治資金の帳簿）で、公開している1件1件を記録と突き合わせられることに意味がある
場合です。このような記録は `"kind": "direct"` で登録します。

```json
{
  "name": "例示党 公開している帳簿の更新の記録",
  "kind": "direct",
  "origin": "ledger.example.org/changes",
  "checkpoint_key": "ledger.example.org/changes+1a2b3c4d+AQ...",
  "url": "https://ledger.example.org/ledger",
  "site": "https://ledger.example.org/"
}
```

運用者は `url` に、`GET /chain.jsonl`（記録そのもの。名前が `origin` の deedlog のチェーン）と
`GET /checkpoint`（署名と連署のあるチェックポイント）を、`Access-Control-Allow-Origin: *` を付けて
置きます。連署サーバーの動きは同じで、区別もしません。確認サイトは、記録をチェックポイントと、
EUCA が最後に連署した内容に照らして確かめ、件数、出来事の種類、新しい記録を表示します。`site`
があれば、公開しているデータと突き合わせる場所としてリンクします。本人用のリンクと監査担当の
手順はありません。`kind` を書かなければ、上で説明した要約の方式です。

## 守れないもの

- EUCA は、検証結果を出さなかったり、消したりできます。検証結果そのものは、記録簿に載せていません。
- ここで作ったパスキーは、このサイトのドメインに結びついています。サイトが移れば、監査担当は
  鍵を作り直します。
- 証明を受け取った人には、組織について二つのことが分かります。その区間の木の大きさ（2の累乗なので、
  その区間の記録の件数の上限）と、その中での記録の位置です。記録が組織のチェーンの何番目にあるか、
  チェーンの長さがどれだけかは分かりません。

## 連署サーバーの鍵

シークレット `WITNESS_KEY`（`dlog keygen -witness -name witness.euca.in -out witness` が書き出す
署名用の鍵）があれば、それで署名します。なければ、最初に使うときに鍵を作り、Durable Object の
保存領域に置きます。どちらの場合も、検証用の鍵は `/witness.vkey` にあります。
連署サーバーは鍵で識別されます。他の人が頼るようになる前に、シークレットを設定し、控えを取って
ください。

## デプロイ

Cloudflare Workers です。SQLite を使う Durable Object を1つ（無料プランで可）と、静的ファイルを
使います。ダッシュボードで Workers & Pages、Create、Import a repository からこのリポジトリを選べば、
既定のデプロイコマンド（`npx wrangler deploy`）で動きます。[`wrangler.jsonc`](wrangler.jsonc) が
カスタムドメイン `witness.euca.in` を割り当て、サイトの場所（`SITE_ORIGIN`）を決めています。
パスキーの署名は、その場所で作られたものだけを受け付けます。

## 開発

```sh
npm install
npm test                         # 連署サーバー、共通のコード、ブラウザでの確認サイト
DLOG=/path/to/dlog npm test      # deedlog のツールとも突き合わせる
npx wrangler dev --var SITE_ORIGIN:http://localhost:8787
node test/fixture.mjs            # サンプルの記録つきの確認サイト（http://localhost:8930）
npm run vendor                   # tsutome を更新したあと: public/vendor/tsutome-core.js を作り直す
```

確認サイトのテストは、Playwright があればブラウザで実行し、なければ飛ばします。
[`public/tlog.js`](public/tlog.js)（SHA-256、マークル木、署名つきノート、チェックポイント、連署、
要約）と [`public/webauthn.js`](public/webauthn.js)（パスキーの署名の検証）は依存がなく、
連署サーバーと確認サイトが共有します。`public/vendor/tsutome-core.js` は tsutome のパッケージから
生成したもので、コミットしてあります。このサイトはビルドなしでデプロイするためです。

## ライセンス

Apache-2.0
