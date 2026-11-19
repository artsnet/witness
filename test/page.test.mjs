// The verification page in a real browser, against the fixture. Needs
// Playwright; without it the tests are skipped. Set SHOTS to a directory to
// keep screenshots.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { audit, parseChain } from 'tsutome/core';
import { startFixture } from './fixture.mjs';

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  // not installed here
}
const skip = !chromium && 'Playwright is not installed';
const SHOTS = process.env.SHOTS;

let fixture;
let browser;
before(async () => {
  if (skip) return;
  fixture = await startFixture();
  browser = await chromium.launch();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => {
  await browser?.close();
  await fixture?.close();
});

async function shoot(page, name) {
  if (!SHOTS || !name) return;
  await page.screenshot({ path: join(SHOTS, `${name}-desktop.png`), fullPage: true });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.screenshot({ path: join(SHOTS, `${name}-phone.png`), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function open(url, name) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(url);
  await page.waitForSelector('body[data-state="done"]');
  assert.deepEqual(page.errors, []);
  await shoot(page, name);
  return page;
}
const verdict = (page) => page.getAttribute('.banner', 'data-verdict');
const events = (page) => page.$$eval('.timeline li', (els) => els.map((e) => e.dataset.event));
const states = (page) => page.$$eval('.timeline li', (els) => els.map((e) => e.dataset.state));
const PRODUCTS = ['deedlog', 'tsutome', 'shinten', 'cucon'];
const noProducts = async (page) => {
  const text = (await page.innerText('body')).toLowerCase();
  for (const word of PRODUCTS) assert.ok(!text.includes(word), word);
};

test('a person sees their own records, each checked against the cosigned commitments', { skip }, async () => {
  const page = await open(fixture.link('full', fixture.tokens.full), 'person-full');
  assert.equal(await verdict(page), 'ok');
  assert.deepEqual(await events(page), ['data.received', 'duty.alerted', 'data.decrypted', 'data.answered', 'data.plaintext_purged', 'duty.approval_requested', 'duty.approved', 'data.deleted']);
  assert.ok((await states(page)).every((s) => s === 'confirmed'));
  const text = await page.innerText('#app');
  for (const s of ['確認できました', 'お問い合わせを受け付けました', '担当者が内容を読むために復号しました', '対応が完了しました（返信しました）', '削除を承認しました', '情報管理責任者', 'お預かりした情報（暗号文）を削除しました', 'EUCA の連署サーバーが', '個人情報取扱規程 第12条', '8 件すべてが、連署された要約に含まれている']) assert.ok(text.includes(s), s);
  assert.ok(!text.includes('件目の記録'), 'no running number of the operator\'s records');
  assert.deepEqual(await page.$$eval('.plans li', (els) => els.map((e) => e.dataset.plan)), ['done', 'done', 'done']);
  assert.equal(await page.$$eval('.checks li', (els) => els.every((e) => e.className === 'is-ok')), true);
  await noProducts(page);
  await page.close();
});

test('only a value computed from the token is sent, and only to the operator', { skip }, async () => {
  const page = await browser.newPage();
  const seen = [];
  page.on('request', (r) => seen.push(r.url() + (r.postData() ?? '')));
  await page.goto(fixture.link('full', fixture.tokens.full));
  await page.waitForSelector('body[data-state="done"]');
  assert.ok(seen.some((u) => u.includes('/logs/full/item?ref=')));
  assert.ok(!seen.some((u) => u.includes(fixture.tokens.full)), 'the token itself is sent nowhere');
  await page.close();
});

test('what is still due is shown with its deadline, and what is late as late', { skip }, async () => {
  const page = await open(fixture.link('due', fixture.tokens.due), 'person-due');
  assert.equal(await verdict(page), 'ok');
  assert.deepEqual(await page.$$eval('.plans li', (els) => els.map((e) => e.dataset.plan)), ['done', 'done', 'due']);
  const text = await page.innerText('#app');
  assert.ok(text.includes('返信不要と判断しました'));
  assert.ok(text.includes('対応が済んだお問い合わせは30日以内に削除する'));
  await page.close();
  const late = await open(fixture.link('due', fixture.tokens.overdue), 'person-overdue');
  assert.deepEqual(await late.$$eval('.plans li', (els) => els.map((e) => e.dataset.plan)), ['overdue', 'overdue']);
  await late.close();
});

test('records whose interval has not come wait, calmly', { skip }, async () => {
  const page = await open(fixture.link('waiting', fixture.tokens.full), 'person-partly-waiting');
  assert.equal(await verdict(page), 'ok');
  assert.deepEqual(await states(page), ['confirmed', 'confirmed', 'confirmed', 'waiting', 'waiting']);
  const text = await page.innerText('#app');
  assert.ok(text.includes('第三者の確認待ち（次の区間で確認されます）'));
  assert.ok(text.includes('新しい 2 件は、まだ第三者の確認を待っています'));
  await page.close();
  // Nothing of this inquiry is confirmed yet: the page says so in amber, and does not call it a failure.
  const fresh = await open(fixture.link('waiting', fixture.tokens.fresh), 'person-waiting');
  assert.equal(await verdict(fresh), 'waiting');
  assert.deepEqual(await states(fresh), ['waiting']);
  const t2 = await fresh.innerText('#app');
  assert.ok(t2.includes('第三者の確認を待っています'));
  assert.ok(t2.includes('受付は記録されています'));
  assert.ok(!t2.includes('確認できませんでした'));
  await fresh.close();
});

test('a record that is not the one committed to is a failure, and is not shown', { skip }, async () => {
  const page = await open(fixture.link('altered', fixture.tokens.full), 'person-altered');
  assert.equal(await verdict(page), 'fail');
  const text = await page.innerText('#app');
  assert.ok(text.includes('確認できませんでした'));
  assert.ok(text.includes('連署された要約と一致しません'));
  assert.equal(await page.$('.timeline'), null);
  await page.close();
});

test('a changed commitment is found, and nothing is read from that log', { skip }, async () => {
  const page = await open(fixture.link('tampered', fixture.tokens.full), 'tampered-anchor');
  assert.equal(await verdict(page), 'fail');
  const text = await page.innerText('#app');
  assert.ok(text.includes('3 件目の要約'), text);
  assert.equal(await page.$('.timeline'), null);
  await page.close();
  const over = await open(fixture.link('tampered'));
  assert.equal(await verdict(over), 'fail');
  assert.equal(await over.$('#results'), null);
  await over.close();
});

test('a token nobody was given finds nothing', { skip }, async () => {
  const page = await open(fixture.link('full', fixture.tokens.unknown), 'person-unknown');
  assert.equal(await verdict(page), 'ok');
  assert.ok((await page.innerText('#app')).includes('まだ記録されていません'));
  assert.equal(await page.$('.timeline'), null);
  await page.close();
});

test('a checkpoint without the cosignature waits for it', { skip }, async () => {
  const page = await open(fixture.link('nocosig', fixture.tokens.full), 'no-cosignature');
  assert.equal(await verdict(page), 'pending');
  assert.ok((await page.innerText('#app')).includes('第三者の連署を待っています'));
  assert.ok((await states(page)).every((s) => s === 'waiting'));
  await page.close();
});

test('anyone sees the state of cosigning, the rules, and the auditor\'s results: no records, no counts of them', { skip }, async () => {
  const page = await open(fixture.link('full'), 'overview');
  assert.equal(await verdict(page), 'ok');
  const text = await page.innerText('#app');
  for (const s of ['連署の状態', '最後に要約が預けられた区間', '7 件（区間ごとに 1 件）', '採用されているルール', 'お問い合わせには3日以内に対応する', '内部監査室による検証結果', 'ここで見えるもの、見えないもの', 'ルールの採用の記録が、連署された要約に含まれている']) assert.ok(text.includes(s), s);
  assert.equal(await page.$('.timeline'), null);
  assert.equal(await page.$('table'), null);
  // One result verifies; the other was changed after it was signed, and says nothing.
  assert.deepEqual(await page.$$eval('.results .result', (els) => els.map((e) => e.dataset.result)), ['invalid', 'valid']);
  const valid = await page.innerText('.result[data-result="valid"]');
  for (const s of ['署名を確認', '内部監査室', '期限後に完了', '指摘が 1 件', '10月分を確認しました']) assert.ok(valid.includes(s), s);
  const invalid = await page.innerText('.result[data-result="invalid"]');
  assert.ok(invalid.includes('署名を確認できません'));
  assert.ok(!invalid.includes('期限超過'));
  await noProducts(page);
  await page.close();

  const none = await open(fixture.link('due'), 'overview-no-results');
  assert.ok((await none.innerText('#results')).includes('まだ検証結果はありません'));
  await none.close();
});

test('the list of logs, and a log that is not registered', { skip }, async () => {
  const list = await open(fixture.list, 'list');
  assert.equal(await list.$$eval('.logs li', (els) => els.length), 6);
  // Following a link from the list checks that log, without reloading.
  await list.click('.logs a');
  await list.waitForSelector('.banner');
  assert.equal(await verdict(list), 'ok');
  await list.close();
  const unknown = await open(`${fixture.list}#o=nobody.example/log`, 'unregistered');
  assert.equal(await verdict(unknown), 'unavailable');
  await unknown.close();
});

test('the auditor makes a key, verifies the whole chain in the browser, and leaves a signed result', { skip }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // A passkey authenticator that says yes: what a laptop's fingerprint reader is to a person.
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

  const url = fixture.link('due', '', '&audit');
  await page.goto(url);
  await page.waitForSelector('body[data-state="done"]');
  // No key is registered for this log yet: nothing to verify with.
  assert.equal(await page.isDisabled('#run-audit'), true);
  await shoot(page, 'audit-start');

  // 1. A key, made here; its public half is what gets registered.
  await page.fill('#auditor-name', '内部監査室');
  await page.click('#make-key');
  await page.waitForSelector('#key-json');
  const entry = JSON.parse(await page.innerText('#key-json'));
  assert.deepEqual(Object.keys(entry), ['name', 'id', 'key', 'alg']);
  assert.equal(entry.alg, -7);
  await shoot(page, 'audit-key');
  fixture.addAuditor('due', entry);

  // 2. Registered: the page lets the auditor in, and everything is checked in the browser.
  await page.reload();
  await page.waitForSelector('body[data-state="done"]');
  assert.equal(await page.isDisabled('#run-audit'), false);
  const sent = [];
  page.on('request', (r) => sent.push({ url: r.url(), body: r.postData() ?? '' }));
  await page.click('#run-audit');
  await page.waitForSelector('#audit-verdict');
  assert.equal(await page.getAttribute('#audit-verdict', 'data-ok'), 'true', await page.innerText('#verify-out'));
  const report = await page.innerText('#verify-out');
  // What the page works out in the browser is what the same code works out here.
  const expected = { overdue: 0, late: 0, unapproved: 0, plan_mismatch: 0, not_told: 0, no_key: 0 };
  for (const f of audit(parseChain(fixture.ops.due.lines).entries, new Date())) expected[f.kind]++;
  const total = Object.values(expected).reduce((a, b) => a + b, 0);
  assert.equal(expected.overdue, 2);
  for (const s of ['検証できました', '記録のつながり', '要約との一致', '第三者の連署', `ルールに照らした指摘（${total} 件）`, '期限超過', '通知の漏れ', '進行中の作業', 'まだ要約に入っていない記録']) assert.ok(report.includes(s), s);
  assert.equal((await page.$$eval('.findings li', (els) => els.map((e) => e.dataset.kind))).filter((k) => k === 'overdue').length, 2);
  await shoot(page, 'audit-verified');

  // 3. The result, signed with the same key, is kept by the site and shown to anyone.
  await page.fill('#audit-note', '確認用の検証です。期限超過の2件は担当に連絡しました。');
  await page.click('#sign-result');
  await page.waitForSelector('#signed');
  await shoot(page, 'audit-signed');
  // The records went from the operator to the browser, and nowhere else: what the site was sent is the statement.
  const toSite = sent.filter((x) => x.url.endsWith('/results'));
  assert.equal(toSite.length, 1);
  const posted = JSON.parse(toSite[0].body);
  const statement = JSON.parse(posted.statement);
  assert.deepEqual(statement.findings, expected);
  assert.deepEqual(statement.checks, { records: 'ok', anchors: 'ok', cosignature: 'ok' });
  assert.equal(statement.covers.anchors, fixture.ops.due.outer.length);
  assert.ok(!toSite[0].body.includes('data.received'), 'no records in what the site is sent');
  assert.equal(JSON.parse(fixture.ops.due.lines.at(-1)).meta.event, 'audit.viewed', 'the operator recorded that its chain was looked at');

  await page.click('#sign-out a');
  await page.waitForSelector('.result');
  await page.waitForSelector('body[data-state="done"]');
  assert.deepEqual(await page.$$eval('.results .result', (els) => els.map((e) => e.dataset.result)), ['valid']);
  const shown = await page.innerText('.result');
  for (const s of ['署名を確認', '内部監査室', `指摘が ${total} 件`, '確認用の検証です']) assert.ok(shown.includes(s), s);
  await shoot(page, 'audit-published');
  assert.deepEqual(errors, []);
  await noProducts(page);

  // Someone without the key is not handed the records; nor is the auditor with a challenge the operator did not give.
  const ask = async (credential) => (await fetch(`${fixture.base}/logs/due/audit/chain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential }) })).status;
  assert.equal(await ask({ id: 'nobody', authenticatorData: '', clientDataJSON: '', signature: '' }), 403);
  assert.equal(await ask(posted.credential), 403, 'a signature over a statement is not a way in');
  await context.close();
});
