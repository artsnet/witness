// The witness: it cosigns the checkpoints of the logs in its registry, after
// checking the operator's signature and that the log only grew since the
// last checkpoint it cosigned (c2sp.org/tlog-witness, add-checkpoint).
//
// It keeps one thing per log, the last checkpoint it cosigned, and its own
// key. `store` is the storage of a Durable Object, or anything with the same
// `get` / `put` / `delete` / `list({ prefix })`.
import { SIG_COSIGNATURE, addCheckpoint, b64, generateKey, parseSigner, parseVerifier, unb64 } from '../public/tlog.js';

const CORS = { 'access-control-allow-origin': '*' };
const text = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } });

export class Witness {
  /**
   * @param {{ store: any, env?: { WITNESS_KEY?: string, WITNESS_NAME?: string }, now?: () => Date, registry: { operators?: { origin: string, checkpoint_key: string }[] } }} opts
   */
  constructor({ store, env = {}, now = () => new Date(), registry }) {
    this.store = store;
    this.env = env;
    this.now = now;
    // What the witness accepts: for each origin, the operator's verifier key.
    this.logs = new Map();
    this.rejected = [];
    for (const op of registry?.operators ?? []) {
      try {
        const v = parseVerifier(op.checkpoint_key);
        if (v.name !== op.origin) throw new Error(`the key is for ${v.name}`);
        this.logs.set(op.origin, v);
      } catch (e) {
        this.rejected.push({ origin: String(op.origin), reason: e.message });
      }
    }
    this.lock = Promise.resolve();
  }

  /** The witness's key: the secret if one is set, or else one made on first use and kept in the store. */
  signer() {
    this.signing ??= (async () => {
      let skey = this.env.WITNESS_KEY?.trim();
      if (!skey) {
        skey = await this.store.get('key');
        if (!skey) {
          skey = (await generateKey(this.env.WITNESS_NAME || 'witness.euca.in', SIG_COSIGNATURE)).skey;
          await this.store.put('key', skey);
        }
      }
      const signer = await parseSigner(skey);
      if (signer.typ !== SIG_COSIGNATURE) throw new Error('WITNESS_KEY is not a witness key (create one with dlog keygen -witness)');
      return signer;
    })();
    // A failure is not kept: the next request tries again.
    this.signing.catch(() => (this.signing = undefined));
    return this.signing;
  }

  /** Runs `fn` after every call before it has finished: check-and-update is one step. */
  serialized(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  async latest(origin) {
    const c = await this.store.get(`log:${origin}`);
    return c ? { size: c.size, root: unb64(c.root), time: c.time } : undefined;
  }

  async status() {
    const logs = {};
    for (const origin of this.logs.keys()) {
      const c = await this.store.get(`log:${origin}`);
      if (c) logs[origin] = c;
    }
    return { witness: (await this.signer()).vkey, logs };
  }

  /** @param {Request} request */
  async handle(request) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/add-checkpoint') {
        if (request.method !== 'POST') return text('POST a checkpoint here\n', 405, { allow: 'POST' });
        const body = await request.text();
        if (body.length > 1 << 20) return text('request too large\n', 413);
        const signer = await this.signer();
        const r = await this.serialized(() =>
          addCheckpoint(body, {
            signer,
            logs: (origin) => this.logs.get(origin),
            latest: (origin) => this.latest(origin),
            put: (origin, c) => this.store.put(`log:${origin}`, { size: c.size, root: b64(c.root), time: c.time }),
            now: this.now,
          }),
        );
        return text(r.body, r.status, r.type ? { 'content-type': r.type } : {});
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return text('not found\n', 404);
      if (pathname === '/witness.vkey') return text((await this.signer()).vkey + '\n', 200, CORS);
      if (pathname === '/status.json') return new Response(JSON.stringify(await this.status(), null, 1) + '\n', { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS } });
      return text('not found\n', 404);
    } catch (e) {
      return text(`the witness is not set up: ${e.message}\n`, 500);
    }
  }
}
