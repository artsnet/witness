// Anchoring and passkey signatures: the two things the operator's service,
// the witness and the page all have to agree on.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import * as t from '../public/tlog.js';
import { challengeFor, verifyAssertion } from '../public/webauthn.js';
import { passkey } from './passkey.mjs';

const hex = (n) => randomBytes(n).toString('hex');

test('a record leads to its interval\'s commitment, and to no other', () => {
  for (const k of [0, 1, 2, 3, 4, 5, 8, 9, 31]) {
    const lines = Array.from({ length: k }, (_, i) => JSON.stringify({ seq: i, r: hex(4) }));
    const terms = { chain: 'log.example/dlm/records', epoch: '2026-11-19T03:20:00Z', nonce: hex(16), pad: hex(16) };
    const a = t.anchor(lines.map((l) => t.leafHash(l)), terms);
    assert.equal(a.size, k <= 1 ? 1 : 2 ** Math.ceil(Math.log2(k)), `${k} records fill a tree of a power of two`);
    lines.forEach((line, index) => {
      const at = { epoch: terms.epoch, size: a.size, index, path: t.inclusionProof(a.leaves, index).map(t.b64), nonce: terms.nonce };
      assert.equal(t.commitOf(line, terms.chain, at), a.commit);
      assert.notEqual(t.commitOf(line + ' ', terms.chain, at), a.commit, 'a changed record');
      assert.notEqual(t.commitOf(line, terms.chain, { ...at, epoch: '2026-11-19T03:30:00Z' }), a.commit, 'another interval');
      assert.notEqual(t.commitOf(line, terms.chain, { ...at, nonce: hex(16) }), a.commit, 'another nonce');
      if (a.size > 1) assert.notEqual(t.commitOf(line, terms.chain, { ...at, index: (index + 1) % a.size }), a.commit, 'another place');
    });
  }
});

test('an interval with nothing in it looks like any other', () => {
  const terms = (epoch) => ({ chain: 'c', epoch, nonce: hex(16), pad: hex(16) });
  const a = t.anchor([], terms('2026-11-19T03:20:00Z'));
  const b = t.anchor([], terms('2026-11-19T03:30:00Z'));
  assert.equal(a.size, 1);
  assert.notEqual(a.commit, b.commit);
  assert.match(a.commit, /^[0-9a-f]{64}$/);
});

test('a passkey\'s signature is checked against the key, the challenge and the site', async () => {
  const origin = 'https://witness.example';
  const key = await passkey({ origin });
  const statement = JSON.stringify({ type: 'audit-statement/v1', origin: 'log.example/dlm', at: '2026-11-19T03:25:00Z', findings: { overdue: 0 } });
  const challenge = challengeFor(statement);
  const credential = await key.sign(challenge);
  const ok = await verifyAssertion({ key: key.entry.key, credential, challenge, origin, rpId: 'witness.example' });
  assert.equal(ok.userVerified, true);
  const refuse = (what, args) => assert.rejects(verifyAssertion({ key: key.entry.key, credential, challenge, origin, rpId: 'witness.example', ...args }), undefined, what);
  await refuse('another statement', { challenge: challengeFor(statement + ' ') });
  await refuse('another site', { origin: 'https://evil.example' });
  await refuse('another relying party', { rpId: 'evil.example' });
  await refuse('another key', { key: (await passkey({ origin })).entry.key });
  await refuse('a registration, not a signature', { credential: await key.sign(challenge, { type: 'webauthn.create' }) });
  await refuse('nobody there', { credential: await key.sign(challenge, { present: false }) });
  await refuse('made at another site', { credential: await key.sign(challenge, { at: 'https://evil.example' }) });
  // Many signatures: the encoding of r and s varies in length.
  for (let i = 0; i < 40; i++) await verifyAssertion({ key: key.entry.key, credential: await key.sign(challenge), challenge, origin, rpId: 'witness.example' });
});
