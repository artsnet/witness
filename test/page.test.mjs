// The verification page in a real browser, against the fixture. Needs
// Playwright; without it the tests are skipped. Set SHOTS to a directory to
// keep screenshots.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
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

async function open(url, name) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForSelector('body[data-state="done"]');
  assert.deepEqual(errors, []);
  if (SHOTS && name) {
    await page.screenshot({ path: join(SHOTS, `${name}-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 800 });
    await page.screenshot({ path: join(SHOTS, `${name}-phone.png`), fullPage: true });
  }
  return page;
}
const verdict = (page) => page.getAttribute('.banner', 'data-verdict');
const events = (page) => page.$$eval('.timeline li', (els) => els.map((e) => e.dataset.event));

test('a full lifecycle is shown, from receipt to deletion', { skip }, async () => {
  const page = await open(fixture.link('full', fixture.tokens.full), 'full');
  assert.equal(await verdict(page), 'ok');
  assert.deepEqual(await events(page), ['data.received', 'duty.alerted', 'data.decrypted', 'data.answered', 'data.plaintext_purged', 'duty.approval_requested', 'duty.approved', 'data.deleted']);
  const text = await page.innerText('#app');
  for (const s of ['確認できました', 'お問い合わせを受け付けました', '担当者が内容を読むために復号しました', '対応が完了しました（返信しました）', '削除を承認しました', '情報管理責任者', 'お預かりした情報（暗号文）を削除しました', '内部監査室が', 'EUCA の連署サーバーが', '個人情報取扱規程 第12条']) assert.ok(text.includes(s), s);
  assert.deepEqual(await page.$$eval('.plans li', (els) => els.map((e) => e.dataset.plan)), ['done', 'done', 'done']);
  assert.equal(await page.$$eval('.checks li', (els) => els.every((e) => e.className === 'is-ok')), true);
  for (const word of ['deedlog', 'tsutome', 'shinten', 'CUCON']) assert.ok(!(await page.innerText('body')).toLowerCase().includes(word.toLowerCase()), word);
  await page.close();
});

test('what is still due is shown with its deadline, and what is late as late', { skip }, async () => {
  const page = await open(fixture.link('due', fixture.tokens.due), 'due');
  assert.equal(await verdict(page), 'ok');
  assert.deepEqual(await page.$$eval('.plans li', (els) => els.map((e) => e.dataset.plan)), ['done', 'done', 'due']);
  const text = await page.innerText('#app');
  assert.ok(text.includes('返信不要と判断しました'));
  assert.ok(text.includes('対応が済んだお問い合わせは30日以内に削除する'));
  assert.ok(text.includes('まだ署名されていません'));
  await page.close();
  const late = await open(fixture.link('due', fixture.tokens.overdue), 'overdue');
  assert.deepEqual(await late.$$eval('.plans li', (els) => els.map((e) => e.dataset.plan)), ['overdue', 'overdue']);
  await late.close();
});

test('a changed record is found, and what the record says is not shown', { skip }, async () => {
  const page = await open(fixture.link('tampered', fixture.tokens.full), 'tampered');
  assert.equal(await verdict(page), 'fail');
  const text = await page.innerText('#app');
  assert.ok(text.includes('確認できませんでした'));
  assert.ok(text.includes('8 件目の記録'), text);
  assert.equal(await page.$('.timeline'), null);
  await page.close();
  const cut = await open(fixture.link('truncated'), 'truncated');
  assert.equal(await verdict(cut), 'fail');
  assert.ok((await cut.innerText('#app')).includes('記録が削除されています'));
  await cut.close();
});

test('a token nobody was given finds nothing', { skip }, async () => {
  const page = await open(fixture.link('full', fixture.tokens.unknown), 'unknown-token');
  assert.equal(await verdict(page), 'ok');
  assert.ok((await page.innerText('#app')).includes('まだ記録されていません'));
  assert.equal(await page.$('.timeline'), null);
  await page.close();
});

test('a checkpoint without the cosignature waits for it', { skip }, async () => {
  const page = await open(fixture.link('nocosig', fixture.tokens.full), 'no-cosignature');
  assert.equal(await verdict(page), 'pending');
  assert.ok((await page.innerText('#app')).includes('第三者の連署を待っています'));
  await page.close();
  const half = await open(fixture.link('nointernal'), 'no-internal');
  assert.equal(await verdict(half), 'ok');
  assert.ok((await half.innerText('#app')).includes('内部監査室の連署は、まだありません'));
  await half.close();
});

test('the overview, the list of logs, and a log that is not registered', { skip }, async () => {
  const page = await open(fixture.link('full'), 'overview');
  assert.equal(await verdict(page), 'ok');
  assert.ok((await page.innerText('#app')).includes('最近の記録'));
  await page.close();
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
