# witness.euca.in

A shared witness and a verification page, run by the End User Computing
Association (EUCA) at <https://witness.euca.in>.

[日本語](README.ja.md)

An organization that keeps a tamper-evident record of what it did (a
[deedlog](https://github.com/eucassoc/deedlog) chain) signs a checkpoint of
that record from time to time. A checkpoint signed only by the organization
itself proves little: it could sign a different history tomorrow. This
witness is a party outside the organization that cosigns each checkpoint after
checking that the record only grew since the last one it saw. With the
cosignature, anyone can check that a record existed at that time and has not
been rewritten since.

The witness is shared: several organizations' records are cosigned by the
same server, and one page checks them all.

- **The witness** speaks [c2sp.org/tlog-witness](https://c2sp.org/tlog-witness)
  with Ed25519 cosignatures ([tlog-cosignature](https://c2sp.org/tlog-cosignature)),
  so `dlog cosign` and other C2SP clients work against it unchanged.
- **The verification page** runs in the reader's browser. It fetches the
  record and its checkpoint from the organization, and checks the chain, the
  organization's signature, the cosignatures and the Merkle root itself. A
  link with a token shows the records about one inquiry in plain words:
  received, decrypted, working copy deleted, answered, deletion approved,
  deleted. The token stays in the URL fragment and is sent to nobody.

What the cosignature shows is that a record was not rewritten. It does not
show that what the record says is true: records are the organization's own
statements. The witness holds no contents, only the last checkpoint it
cosigned for each record.

## Endpoints

| | |
|---|---|
| `POST /add-checkpoint` | c2sp.org/tlog-witness. `200` with the cosignature line; `409` with the size the witness holds (`text/x.tlog.size`); `404` for a log that is not in the registry; `403` when the operator's signature does not verify; `422` when the consistency proof does not. |
| `GET /witness.vkey` | The witness's verifier key. |
| `GET /status.json` | The last checkpoint cosigned for each log: `{"witness": "<vkey>", "logs": {"<origin>": {"size", "root", "time"}}}`. |
| `GET /registry.json` | The logs the witness cosigns. |
| `GET /#o=<origin>` | The verification page for a log. |
| `GET /#o=<origin>&t=<token>` | The records about one item: those whose `item` is the first 32 hex digits of SHA-256 of the token. |

## Registering a log

The witness cosigns only the logs in [`public/registry.json`](public/registry.json).
To add one, add an entry to `operators` (a pull request, or an edit by a
maintainer) and deploy; see [`registry.example.json`](registry.example.json).

```json
{
  "name": "Example Inc. inquiry handling record",
  "origin": "dlm.example.com/contact",
  "checkpoint_key": "dlm.example.com/contact+1a2b3c4d+AQ...",
  "url": "https://dlm.example.com/log",
  "witnesses": [{ "name": "Internal audit", "key": "dlm.example.com/internal-audit+5e6f7a8b+BA..." }]
}
```

- `origin`: the name of the chain, which is also the name of the checkpoint key.
- `checkpoint_key`: the operator's verifier key (`dlog keygen` writes it to `*.vkey`).
- `url`: where the operator publishes `GET <url>/checkpoint` (the latest signed
  checkpoint with its cosignatures) and `GET <url>/chain.jsonl` (the records),
  both with `Access-Control-Allow-Origin: *`. The page reads them; the witness does not.
- `witnesses` (optional): other witnesses of this log, such as the
  organization's internal audit office, shown on the page next to EUCA's.

An entry whose key does not parse, or whose key name is not the origin, is
not accepted.

## The witness's key

If the secret `WITNESS_KEY` is set (a signer key written by
`dlog keygen -witness -name witness.euca.in -out witness`), the witness signs
with it. Otherwise it makes a key on first use and keeps it in the Durable
Object's storage. Either way the verifier key is at `/witness.vkey`.
A witness is known by its key: set the secret, and keep a copy, before others
come to rely on it.

## Deploying

Cloudflare Workers, with one SQLite-backed Durable Object (free plan) and
static assets. In the dashboard: Workers & Pages, Create, Import a repository,
this repository; the default build and deploy command (`npx wrangler deploy`)
works. [`wrangler.jsonc`](wrangler.jsonc) attaches the custom domain
`witness.euca.in`.

## Development

```sh
npm install
npm test                         # the witness and the shared code
DLOG=/path/to/dlog npm test      # also against deedlog's own tool
npx wrangler dev                 # the Worker, locally
node test/fixture.mjs            # the page with sample logs, at http://localhost:8930
```

The page tests run in a browser when Playwright is installed, and are skipped
when it is not. `public/tlog.js` is the shared code: SHA-256, the Merkle tree,
signed notes, checkpoints and cosignatures, with no dependencies, used by the
witness and by the page.

## License

Apache-2.0
