# witness.euca.in

一般社団法人エンドユーザーコンピューティング協会（EUCA）が <https://witness.euca.in>
で運営する、相乗りの連署サーバーと確認サイトです。

[English](README.md)

自分たちが行ったことを改ざんの分かる形で記録している組織（[deedlog](https://github.com/eucassoc/deedlog)
のチェーン）は、その記録のチェックポイントに定期的に署名します。しかし、組織自身の署名だけでは
あまり証明になりません。明日、別の履歴に署名し直すこともできるからです。この連署サーバーは、
組織の外の立場から、前に見た時点から記録が増えただけであることを確かめたうえで、チェックポイントに
連署します。連署があれば、記録がその時刻に存在していて、そのあと書き換えられていないことを、
誰でも確かめられます。

連署サーバーは相乗りです。複数の組織の記録に同じサーバーが連署し、同じページで確認できます。

- **連署サーバー**は [c2sp.org/tlog-witness](https://c2sp.org/tlog-witness) に沿い、Ed25519 の連署
  （[tlog-cosignature](https://c2sp.org/tlog-cosignature)）を返します。`dlog cosign` などの C2SP
  のクライアントがそのまま使えます。
- **確認サイト**は、見る人のブラウザの中で動きます。組織から記録とチェックポイントを取得し、記録の
  つながり、組織の署名、連署、マークル木のルートを自分で確かめます。確認用の番号が入ったリンクを
  開くと、1件のお問い合わせについての記録を平易な言葉で表示します（受付、復号、写しの削除、対応完了、
  削除の承認、削除）。番号は URL のフラグメントにあり、どこにも送られません。

連署が示すのは、記録が書き換えられていないことです。記録の内容が事実であることは示しません。
記録は組織自身の申告です。連署サーバーは内容を持たず、各記録について最後に連署したチェックポイント
だけを持ちます。

## エンドポイント

| | |
|---|---|
| `POST /add-checkpoint` | c2sp.org/tlog-witness。`200` で連署の行、`409` で連署サーバーが持っているサイズ（`text/x.tlog.size`）、登録簿にない記録は `404`、運用者の署名を確認できないときは `403`、整合性の証明を確認できないときは `422`。 |
| `GET /witness.vkey` | 連署サーバーの検証用の鍵。 |
| `GET /status.json` | 各記録について最後に連署したチェックポイント: `{"witness": "<vkey>", "logs": {"<origin>": {"size", "root", "time"}}}`。 |
| `GET /registry.json` | 連署する記録の登録簿。 |
| `GET /#o=<origin>` | その記録の確認ページ。 |
| `GET /#o=<origin>&t=<token>` | 1件についての記録。`item` が、番号の SHA-256 の先頭32桁（16進）である記録を表示します。 |

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
  "witnesses": [{ "name": "内部監査室", "key": "dlm.example.com/internal-audit+5e6f7a8b+BA..." }]
}
```

- `origin`: チェーンの名前。チェックポイントの鍵の名前でもあります。
- `checkpoint_key`: 運用者の検証用の鍵（`dlog keygen` が `*.vkey` に書き出すもの）。
- `url`: 運用者が `GET <url>/checkpoint`（連署つきの最新のチェックポイント）と
  `GET <url>/chain.jsonl`（記録）を公開している場所。どちらも
  `Access-Control-Allow-Origin: *` をつけます。読むのは確認サイトで、連署サーバーは読みません。
- `witnesses`（任意）: この記録のほかの連署サーバー。組織の内部監査室などで、確認サイトに EUCA の
  連署と並べて表示されます。

鍵を読めない項目や、鍵の名前が origin と違う項目は受け付けません。

## 連署サーバーの鍵

シークレット `WITNESS_KEY`（`dlog keygen -witness -name witness.euca.in -out witness` が書き出す
署名用の鍵）があれば、それで署名します。なければ、最初に使うときに鍵を作り、Durable Object の
ストレージに保管します。どちらの場合も、検証用の鍵は `/witness.vkey` にあります。
連署サーバーは鍵で識別されます。ほかの組織が頼るようになる前に、シークレットを設定し、控えを
取ってください。

## デプロイ

Cloudflare Workers で動きます。SQLite の Durable Object を1つ（無料プランで可）と、静的ファイルを
使います。ダッシュボードの Workers & Pages で Create、Import a repository を選び、このリポジトリを
指定します。既定のビルドとデプロイのコマンド（`npx wrangler deploy`）のままで動きます。
独自ドメイン `witness.euca.in` は [`wrangler.jsonc`](wrangler.jsonc) が割り当てます。

## 開発

```sh
npm install
npm test                         # 連署サーバーと共通のコード
DLOG=/path/to/dlog npm test      # deedlog のツールとの相互確認も行う
npx wrangler dev                 # Worker を手元で動かす
node test/fixture.mjs            # 見本の記録つきで確認サイトを開く（http://localhost:8930）
```

確認サイトのテストは、Playwright があればブラウザで実行し、なければスキップします。
`public/tlog.js` は共通のコードです。SHA-256、マークル木、署名つきノート、チェックポイント、連署を
依存なしで実装していて、連署サーバーと確認サイトの両方が使います。

## ライセンス

Apache-2.0
