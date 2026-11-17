// A local stand-in for the whole setting: this site's files, the witness, and
// a few operators' logs in different states, for the page tests and for
// looking at the page by hand (`node test/fixture.mjs`).
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as t from '../public/tlog.js';
import { Witness } from '../src/witness.js';
import { MemoryStore } from './store.mjs';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const itemOf = (token) => t.sha256hex(token).slice(0, 32);
const dutyId = (rule, item) => t.sha256hex([rule, `item=${item}`].join('\x1f')).slice(0, 12);

const RULES = [
  { rule: 'handle-inquiry', title: 'お問い合わせには3日以内に対応する', source: 'お問い合わせ対応規程 第4条', when: 'data.received', expect: 'data.answered', within: '3d', approval: 'none' },
  { rule: 'purge-plaintext', title: '復号した内容の写しは24時間以内に端末から消す', source: '個人情報取扱規程 第9条', when: 'data.decrypted', expect: 'data.plaintext_purged', within: '24h', approval: 'none' },
  { rule: 'delete-after-answer', title: '対応が済んだお問い合わせは30日以内に削除する', source: '個人情報取扱規程 第12条', when: 'data.answered', expect: 'data.deleted', within: '30d', approval: 'required' },
];

/** Writes a log: `steps` are [minutes before now, event, meta]. */
function chainOf(origin, now, steps) {
  const lines = [];
  const source = { type: 'cucon', id: origin, collector: 'test' };
  const add = (ago, event, meta) => lines.push(t.nextRecord(t.readChain(lines), { name: origin, source, event, meta, at: new Date(now - ago) }));
  for (const r of RULES) add(40 * DAY, 'rule.adopted', { ...r, notice: r.within, owner: 'support', escalate: 'manager', per: 'item', by: 'manager', digest: t.sha256hex(r.rule) });
  add(40 * DAY - MIN, 'key.published', { form: 'contact', by: 'manager' });
  for (const [ago, event, meta] of steps) add(ago, event, meta);
  return lines;
}

const lifecycle = (item, start, upTo) =>
  [
    [start, 'data.received', { item, form: 'contact', by: 'site' }],
    [start - 2 * MIN, 'duty.alerted', { duty: dutyId('handle-inquiry', item), stage: 'due', to: 'support', item, by: 'support-agent' }],
    [start - 3 * MIN, 'data.decrypted', { item, by: 'support-agent' }],
    [start - 9 * MIN, 'data.answered', { item, by: 'support', outcome: 'replied' }],
    [start - 10 * MIN, 'data.plaintext_purged', { item, by: 'support-agent' }],
    [start - 11 * MIN, 'duty.approval_requested', { duty: dutyId('delete-after-answer', item), item, plan: t.sha256hex('plan' + item), by: 'support-agent' }],
    [start - 13 * MIN, 'duty.approved', { duty: dutyId('delete-after-answer', item), item, by: 'manager', plan: t.sha256hex('plan' + item), channel: 'screen' }],
    [start - 14 * MIN, 'data.deleted', { item, by: 'support-agent', plan: t.sha256hex('plan' + item), place: 'google-form:contact', rows: '1', responses: '1' }],
  ].slice(0, upTo);

export async function startFixture({ port = 0, now = Date.now() } = {}) {
  const tokens = { full: 'Zk3vT0q9mB1xYw7cR2dLhA', due: 'pQ8sN5uJ4eG6tV1bX0zKfM', overdue: 'aH2jD7lO9rC3yI6wU8nEsB', unknown: 'nobody-has-this-token0' };
  const logs = {
    full: { name: '合同会社Burug お問い合わせの取り扱い記録', steps: [...lifecycle(itemOf(tokens.full), 30 * MIN), [5 * MIN, 'data.received', { item: itemOf('another'), form: 'contact', by: 'site' }]] },
    due: {
      name: '例示株式会社 お問い合わせの取り扱い記録',
      steps: [
        [3 * DAY + 60 * MIN, 'data.received', { item: itemOf(tokens.overdue), form: 'contact', by: 'site' }],
        [30 * 60 * MIN, 'data.decrypted', { item: itemOf(tokens.overdue), by: 'support-agent' }],
        ...lifecycle(itemOf(tokens.due), 50 * MIN, 5).map((s) => (s[1] === 'data.answered' ? [s[0], s[1], { ...s[2], outcome: 'no_reply_needed' }] : s)),
      ],
      unsigned: [[MIN, 'data.received', { item: itemOf('later'), form: 'contact', by: 'site' }]],
    },
    tampered: { name: '改ざんされた記録', steps: lifecycle(itemOf(tokens.full), 30 * MIN), tamper: true },
    truncated: { name: '記録が消された記録', steps: lifecycle(itemOf(tokens.full), 30 * MIN), truncate: 2 },
    nocosig: { name: '連署のない記録', steps: lifecycle(itemOf(tokens.full), 30 * MIN), euca: false, internal: false },
    nointernal: { name: '組織内の連署がない記録', steps: lifecycle(itemOf(tokens.full), 30 * MIN), internal: false },
  };

  const registry = { witness: { name: 'witness.euca.in', operator: '一般社団法人エンドユーザーコンピューティング協会' }, quorum: 1, operators: [] };
  const made = {};
  for (const [id, log] of Object.entries(logs)) {
    const origin = `${id}.example/dlm`;
    const op = await t.generateKey(origin);
    const audit = await t.generateKey(`${id}.example/internal-audit`, t.SIG_COSIGNATURE);
    made[id] = { origin, op, audit, lines: chainOf(origin, now, log.steps) };
    registry.operators.push({ name: log.name, origin, checkpoint_key: op.vkey, url: `/logs/${id}`, witnesses: [{ name: '内部監査室', key: audit.vkey }] });
  }
  const witness = new Witness({ store: new MemoryStore(), registry, now: () => new Date(now) });
  const witnessKey = t.parseVerifier((await (await witness.handle(new Request('http://w/witness.vkey'))).text()).trim());
  const post = async (body) => {
    const r = await witness.handle(new Request('http://w/add-checkpoint', { method: 'POST', body }));
    return { status: r.status, body: await r.text() };
  };
  for (const [id, log] of Object.entries(logs)) {
    const m = made[id];
    const leaves = m.lines.map((l) => t.leafHash(l));
    let note = await t.signCheckpoint(leaves, await t.parseSigner(m.op.skey));
    const body = t.parseNote(note).text;
    if (log.euca !== false) note += (await t.requestCosignature(note, leaves, witnessKey, post)).lines.join('');
    if (log.internal !== false) note += await t.cosign(body, await t.parseSigner(m.audit.skey), Math.floor(now / 1000) - 1);
    m.checkpoint = note;
    for (const [ago, event, meta] of log.unsigned ?? []) m.lines.push(t.nextRecord(t.readChain(m.lines), { name: m.origin, source: { type: 'cucon', id: m.origin, collector: 'test' }, event, meta, at: new Date(now - ago) }));
    if (log.tamper) m.lines[6] = m.lines[6].replace('"by":"support-agent"', '"by":"support"');
    if (log.truncate) m.lines.length -= log.truncate;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, type, body) => res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*', 'cache-control': 'no-store' }).end(body);
    const log = /^\/logs\/([a-z]+)\/(checkpoint|chain\.jsonl)$/.exec(url.pathname);
    if (log && made[log[1]]) return send(200, 'text/plain; charset=utf-8', log[2] === 'checkpoint' ? made[log[1]].checkpoint : made[log[1]].lines.join('\n') + '\n');
    if (url.pathname === '/test-registry.json') return send(200, 'application/json', JSON.stringify(registry));
    if (url.pathname === '/witness.vkey' || url.pathname === '/status.json') {
      const r = await witness.handle(new Request('http://w' + url.pathname));
      return send(r.status, r.headers.get('content-type'), await r.text());
    }
    try {
      const path = normalize(join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!path.startsWith(PUBLIC)) throw new Error('outside');
      send(200, TYPES[extname(path)] ?? 'application/octet-stream', await readFile(path));
    } catch {
      send(404, 'text/plain', 'not found\n');
    }
  });
  await new Promise((r) => server.listen(port, 'localhost', r));
  const base = `http://localhost:${server.address().port}`;
  const link = (id, token) => `${base}/?registry=/test-registry.json#o=${id}.example/dlm${token ? `&t=${token}` : ''}`;
  return { base, tokens, link, list: `${base}/?registry=/test-registry.json`, close: () => new Promise((r) => server.close(r)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const f = await startFixture({ port: Number(process.env.PORT ?? 8930) });
  console.log(f.list);
  for (const [id, token] of [['full', f.tokens.full], ['due', f.tokens.due], ['due', f.tokens.overdue], ['full', f.tokens.unknown], ['tampered', f.tokens.full], ['truncated'], ['nocosig', f.tokens.full], ['nointernal'], ['full']]) console.log(f.link(id, token));
}
