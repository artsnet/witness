// The witness with an in-memory store, as the Durable Object runs it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as t from '../public/tlog.js';
import { Witness } from '../src/witness.js';
import { MemoryStore } from './store.mjs';

const origin = 'log.example/test';
const source = { type: 'test', id: origin, collector: 'test' };
function grow(lines, n, event = 'thing.happened') {
  for (let i = 0; i < n; i++) lines.push(t.nextRecord(t.readChain(lines), { name: origin, source, event, meta: { item: String(lines.length) } }));
  return lines;
}
const leaves = (lines) => lines.map((l) => t.leafHash(l));

async function setup(env = {}) {
  const op = await t.generateKey(origin);
  const store = new MemoryStore();
  const registry = { operators: [{ origin, checkpoint_key: op.vkey }, { origin: 'bad.example/log', checkpoint_key: 'nonsense' }] };
  const make = () => new Witness({ store, env, registry, now: () => new Date('2026-11-18T01:00:00Z') });
  const witness = make();
  const call = (w, method, path, body) => w.handle(new Request('https://witness.example' + path, { method, body }));
  const post = (w) => async (body) => {
    const r = await call(w, 'POST', '/add-checkpoint', body);
    return { status: r.status, body: await r.text(), type: r.headers.get('content-type') };
  };
  return { op, signer: await t.parseSigner(op.skey), store, make, witness, call, post };
}

test('cosigns a log in its registry, and keeps what it cosigned', async () => {
  const s = await setup();
  const vkeyRes = await s.call(s.witness, 'GET', '/witness.vkey');
  assert.equal(vkeyRes.headers.get('access-control-allow-origin'), '*');
  const vkey = (await vkeyRes.text()).trim();
  const w = t.parseVerifier(vkey);
  assert.equal(w.name, 'witness.euca.in');
  assert.equal(w.typ, t.SIG_COSIGNATURE);

  const lines = grow([], 4);
  const note = await t.signCheckpoint(leaves(lines), s.signer);
  const got = await t.requestCosignature(note, leaves(lines), w, s.post(s.witness));
  const c = await t.verifyCheckpoint(note + got.lines.join(''), t.parseVerifier(s.op.vkey), [w], 1);
  assert.equal(c.cosigned[0].time, Date.parse('2026-11-18T01:00:00Z') / 1000);

  // A new instance over the same store (the Durable Object restarted): same key, same state.
  const again = s.make();
  assert.equal((await (await s.call(again, 'GET', '/witness.vkey')).text()).trim(), vkey);
  grow(lines, 5);
  const note2 = await t.signCheckpoint(leaves(lines), s.signer);
  const raw = await s.post(again)(`old 0\n\n${note2}`);
  assert.equal(raw.status, 409);
  assert.equal(raw.type, 'text/x.tlog.size');
  assert.equal(raw.body, '4\n');
  await t.requestCosignature(note2, leaves(lines), w, s.post(again), 0);

  const status = await (await s.call(again, 'GET', '/status.json')).json();
  assert.equal(status.witness, vkey);
  assert.deepEqual(status.logs[origin], { size: 9, root: t.b64(t.merkleRoot(leaves(lines))), time: Date.parse('2026-11-18T01:00:00Z') / 1000 });
});

test('refuses a rewritten history, an unknown log, a wrong key, and nonsense', async () => {
  const s = await setup();
  const post = s.post(s.witness);
  const lines = grow([], 6);
  assert.equal((await post(`old 0\n\n${await t.signCheckpoint(leaves(lines), s.signer)}`)).status, 200);

  const rewritten = grow([], 8, 'thing.rewritten');
  const forked = await t.signCheckpoint(leaves(rewritten), s.signer);
  const r = await post(`old 6\n${t.consistencyProof(leaves(rewritten), 6, 8).map((h) => t.b64(h) + '\n').join('')}\n${forked}`);
  assert.equal(r.status, 422);
  assert.equal((await (await s.call(s.witness, 'GET', '/status.json')).json()).logs[origin].size, 6);

  const stranger = await t.parseSigner((await t.generateKey('other.example/log')).skey);
  assert.equal((await post(`old 0\n\n${await t.signCheckpoint(leaves(lines), stranger)}`)).status, 404);
  const imposter = await t.parseSigner((await t.generateKey(origin)).skey);
  assert.equal((await post(`old 6\n\n${await t.signCheckpoint(leaves(lines), imposter)}`)).status, 403);
  assert.equal((await post('hello')).status, 400);
  assert.equal((await s.call(s.witness, 'GET', '/add-checkpoint')).status, 405);
  assert.equal((await s.call(s.witness, 'GET', '/elsewhere')).status, 404);
  // The registry entry whose key does not parse is not accepted, and is remembered as such.
  assert.deepEqual(s.witness.rejected.map((x) => x.origin), ['bad.example/log']);
});

test('requests that arrive together are answered one after another', async () => {
  const s = await setup();
  const post = s.post(s.witness);
  const lines = grow([], 3);
  assert.equal((await post(`old 0\n\n${await t.signCheckpoint(leaves(lines), s.signer)}`)).status, 200);
  // Two operators' processes race from size 3: to 5 and to 7. Exactly one is cosigned from 3;
  // the other is told the size the witness now holds.
  grow(lines, 4);
  const req = async (n) => `old 3\n${t.consistencyProof(leaves(lines), 3, n).map((h) => t.b64(h) + '\n').join('')}\n${await t.signCheckpoint(leaves(lines), s.signer, n)}`;
  const [a, b] = await Promise.all([post(await req(5)), post(await req(7))]);
  assert.deepEqual([a.status, b.status], [200, 409]);
  assert.equal(b.body, '5\n');
});

test('uses the key in WITNESS_KEY when one is set', async () => {
  const k = await t.generateKey('witness.example/own', t.SIG_COSIGNATURE);
  const s = await setup({ WITNESS_KEY: k.skey + '\n' });
  assert.equal((await (await s.call(s.witness, 'GET', '/witness.vkey')).text()).trim(), k.vkey);
  assert.equal(await s.store.get('key'), undefined);
  const wrong = await setup({ WITNESS_KEY: (await t.generateKey('witness.example/own')).skey });
  const r = await wrong.call(wrong.witness, 'GET', '/witness.vkey');
  assert.equal(r.status, 500);
  assert.match(await r.text(), /not a witness key/);
});
