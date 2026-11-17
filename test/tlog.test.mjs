// The shared code against deedlog's own tool: what `dlog` signs, this
// verifies, and the other way round. Set DLOG to the dlog binary.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as t from '../public/tlog.js';

const DLOG = process.env.DLOG;
const dlog = (...args) => execFileSync(DLOG, args, { encoding: 'utf8' });
// For calls that reach a server in this process: the event loop must keep running.
const dlogAsync = async (...args) => (await promisify(execFile)(DLOG, args, { encoding: 'utf8' })).stdout;

function grow(lines, n, name = 'log.example/test') {
  for (let i = 0; i < n; i++) {
    const chain = t.readChain(lines);
    lines.push(t.nextRecord(chain, { name, source: { type: 'test', id: name, collector: 'test' }, event: 'thing.happened', meta: { item: String(lines.length) } }));
  }
  return lines;
}
const leaves = (lines) => lines.map((l) => t.leafHash(l));

test('sha256 is SHA-256', () => {
  for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 70000]) {
    const b = randomBytes(n);
    assert.equal(t.hex(t.sha256(b)), createHash('sha256').update(b).digest('hex'), `length ${n}`);
  }
});

test('consistency and inclusion proofs verify for every pair of sizes', () => {
  const lv = leaves(grow([], 33));
  for (let n = 0; n <= 33; n++) {
    for (let m = 0; m <= n; m++) {
      const proof = t.consistencyProof(lv, m, n);
      t.verifyConsistency(m, n, t.merkleRoot(lv, m), t.merkleRoot(lv, n), proof);
      if (m > 0 && m < n) assert.throws(() => t.verifyConsistency(m, n, t.merkleRoot(lv, m), t.merkleRoot(lv, n - 1 || 1), proof));
    }
  }
});

test('a changed line is named', () => {
  const lines = grow([], 5);
  lines[2] = lines[2].replace('"item":"2"', '"item":"x"');
  const c = t.readChain(lines);
  assert.deepEqual(c.problems.map((p) => p.line), [4]);
});

test('keys and notes round-trip', async () => {
  const op = await t.generateKey('log.example/test');
  const w = await t.generateKey('witness.example', t.SIG_COSIGNATURE);
  const signer = await t.parseSigner(op.skey);
  assert.equal(signer.vkey, op.vkey);
  const lv = leaves(grow([], 7));
  const note = await t.signCheckpoint(lv, signer);
  const line = await t.cosign(t.parseNote(note).text, await t.parseSigner(w.skey), 1790000000);
  const c = await t.verifyCheckpoint(note + line, t.parseVerifier(op.vkey), [t.parseVerifier(w.vkey)], 1);
  assert.equal(c.size, 7);
  assert.equal(c.cosigned[0].time, 1790000000);
  await assert.rejects(t.verifyCheckpoint(note, t.parseVerifier(op.vkey), [t.parseVerifier(w.vkey)], 1), /0 of 1/);
  await assert.rejects(t.verifyCheckpoint(note.replace('\n7\n', '\n8\n'), t.parseVerifier(op.vkey)), /invalid/);
});

const listen = (handler) =>
  new Promise((resolve) => {
    const s = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => handler(req, body).then((r) => res.writeHead(r.status, r.type ? { 'content-type': r.type } : {}).end(r.body)));
    }).listen(0, 'localhost', () => resolve(s));
  });

test('with dlog', { skip: !DLOG && 'set DLOG to run' }, async (ctx) => {
  const dir = mkdtempSync(join(tmpdir(), 'tlog-'));
  const f = (n) => join(dir, n);
  const origin = 'log.example/test';
  const lines = grow([], 5, origin);
  const write = () => writeFileSync(f('chain.jsonl'), lines.join('\n') + '\n');
  write();
  dlog('keygen', '-name', origin, '-out', f('op'));
  const signer = await t.parseSigner(readFileSync(f('op.key'), 'utf8'));
  const operator = t.parseVerifier(readFileSync(f('op.vkey'), 'utf8'));

  await ctx.test('dlog reads the chain and the checkpoint signed here', async () => {
    assert.equal(JSON.parse(dlog('verify', f('chain.jsonl'))).count, 5);
    const note = await t.signCheckpoint(leaves(lines), signer);
    assert.equal(note, dlog('checkpoint', '-key', f('op.key'), f('chain.jsonl')));
    writeFileSync(f('cp5'), note);
    assert.equal(JSON.parse(dlog('verify', '-checkpoint', f('cp5'), '-key', f('op.vkey'), f('chain.jsonl'))).checkpoint_size, 5);
  });

  await ctx.test('dlog cosign against the witness here', async () => {
    const w = await t.generateKey('witness.example/here', t.SIG_COSIGNATURE);
    writeFileSync(f('w.vkey'), w.vkey + '\n');
    const state = new Map();
    const witness = { signer: await t.parseSigner(w.skey), logs: (o) => (o === origin ? operator : undefined), latest: async (o) => state.get(o), put: async (o, c) => void state.set(o, c) };
    const server = await listen((req, body) => t.addCheckpoint(body, witness));
    const url = `http://localhost:${server.address().port}`;
    try {
      await dlogAsync('cosign', '-key', f('op.vkey'), '-witness', `${f('w.vkey')}=${url}`, '-out', f('cp5.w'), f('chain.jsonl'), f('cp5'));
      dlog('verify', '-checkpoint', f('cp5.w'), '-key', f('op.vkey'), '-witness', f('w.vkey'), '-quorum', '1', f('chain.jsonl'));
      for (const n of [1, 2, 9]) {
        grow(lines, n, origin);
        write();
        writeFileSync(f('cp'), dlog('checkpoint', '-key', f('op.key'), f('chain.jsonl')));
        await dlogAsync('cosign', '-key', f('op.vkey'), '-witness', `${f('w.vkey')}=${url}`, '-out', f(`cp${lines.length}.w`), f('chain.jsonl'), f('cp'));
        dlog('verify', '-checkpoint', f(`cp${lines.length}.w`), '-key', f('op.vkey'), '-witness', f('w.vkey'), '-quorum', '1', f('chain.jsonl'));
        assert.equal(state.get(origin).size, lines.length);
      }
      // A different history of the same size is refused, and so is a log the witness does not know.
      const other = grow([], lines.length, origin).map((l) => l.replace('thing.happened', 'thing.rewritten'));
      const forked = await t.signCheckpoint(leaves(other), signer);
      const r = await t.addCheckpoint(`old ${lines.length}\n\n${forked}`, witness);
      assert.equal(r.status, 422);
      const stranger = await t.parseSigner((await t.generateKey('other.example/log')).skey);
      assert.equal((await t.addCheckpoint(`old 0\n\n${await t.signCheckpoint(leaves(lines), stranger)}`, witness)).status, 404);
      const imposter = await t.parseSigner((await t.generateKey(origin)).skey);
      assert.equal((await t.addCheckpoint(`old ${lines.length}\n\n${await t.signCheckpoint(leaves(lines), imposter)}`, witness)).status, 403);
    } finally {
      server.close();
    }
  });

  await ctx.test('cosignatures asked here from dlog witness', async () => {
    dlog('keygen', '-witness', '-name', 'witness.example/dlog', '-out', f('dw'));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const proc = spawn(DLOG, ['witness', '-key', f('dw.key'), '-state', f('dw.state'), '-listen', `localhost:${port}`, '-log', f('op.vkey')], { stdio: 'ignore' });
    try {
      const witness = t.parseVerifier(readFileSync(f('dw.vkey'), 'utf8'));
      const post = async (body) => {
        const r = await fetch(`http://localhost:${port}/add-checkpoint`, { method: 'POST', body });
        return { status: r.status, body: await r.text() };
      };
      for (let i = 0; i < 50; i++) {
        if (await post('').then(() => true, () => false)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      let held = 0;
      for (const n of [0, 3, 1, 16]) {
        grow(lines, n, origin);
        write();
        const note = await t.signCheckpoint(leaves(lines), signer);
        // Once from the size the witness holds, once without knowing it (409, then again).
        const got = await t.requestCosignature(note, leaves(lines), witness, post, n === 1 ? 0 : held);
        held = got.size;
        writeFileSync(f('cpd'), note + got.lines.join(''));
        dlog('verify', '-checkpoint', f('cpd'), '-key', f('op.vkey'), '-witness', f('dw.vkey'), '-quorum', '1', f('chain.jsonl'));
      }
    } finally {
      proc.kill();
    }
  });
});
