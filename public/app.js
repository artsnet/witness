// The verification page. Everything is checked here, in the reader's
// browser: the page fetches the registry, the log's chain and its checkpoint,
// and trusts none of them until the signatures and the hashes agree. The
// token in the link stays in the fragment and is sent nowhere.
import { b64, equal, hex, leafHash, merkleRoot, parseVerifier, readChain, sha256, unb64, utf8, verifyCheckpoint } from './tlog.js';

const app = document.getElementById('app');
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

// ---- small helpers ----

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === undefined || v === null) continue;
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === false || c === undefined || c === null) continue;
    el.append(c.nodeType ? c : String(c));
  }
  return el;
}

const jst = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function when(t, seconds = true) {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '日時不明';
  const p = Object.fromEntries(jst.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}年${p.month}月${p.day}日 ${p.hour === '24' ? '00' : p.hour}:${p.minute}${seconds ? ':' + p.second : ''}`;
}

async function get(url) {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

const WHO = { 'support-agent': '対応担当のAIエージェント', support: '対応担当', manager: '情報管理責任者', site: 'フォーム', audit: '内部監査室' };
const who = (id) => WHO[id] ?? id;

const duration = (s) => {
  const m = /^(\d{1,5})([dhm])$/.exec(s ?? '');
  return m ? Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2]] : undefined;
};
const span = (s) => {
  const m = /^(\d{1,5})([dhm])$/.exec(s ?? '');
  return m ? `${m[1]}${{ d: '日', h: '時間', m: '分' }[m[2]]}` : s;
};

// ---- the rules a chain holds, and what they ask for one item ----

function rulesOf(entries) {
  const versions = new Map();
  for (const e of entries) {
    const id = e.meta.rule;
    if (!id) continue;
    if (e.event === 'rule.adopted') {
      const where = Object.entries(e.meta).filter(([k]) => k.startsWith('where.')).map(([k, v]) => [k.slice(6), v]);
      versions.set(id, [...(versions.get(id) ?? []), { id, title: e.meta.title ?? id, source: e.meta.source, when: e.meta.when, expect: e.meta.expect, within: e.meta.within, approval: e.meta.approval, per: e.meta.per ?? 'item', where, seq: e.seq, at: e.at, retired: false }]);
    } else if (e.event === 'rule.retired') {
      const last = versions.get(id)?.at(-1);
      if (last) last.retired = true;
    }
  }
  return [...versions.values()].map((v) => ({ ...v.at(-1), firstSeq: v[0].seq, firstAt: v[0].at })).filter((r) => !r.retired);
}

/** The same id an operator's service gives a duty: the rule and the thing it is about. */
const dutyId = (rule, item) => hex(sha256(utf8([rule, `item=${item}`].join(String.fromCharCode(0x1f))))).slice(0, 12);

function plansFor(rules, entries, item, now) {
  const out = [];
  for (const rule of rules) {
    if (rule.per !== 'item') continue;
    const ms = duration(rule.within);
    if (ms === undefined) continue;
    const trigger = entries.find((e) => e.event === rule.when && e.meta.item === item && rule.where.every(([k, v]) => e.meta[k] === v));
    if (!trigger) continue;
    const done = entries.find((e) => e.event === rule.expect && e.seq > trigger.seq && e.meta.item === item);
    // What was already there when the rule was first adopted comes under it from the adoption on.
    const due = Date.parse(rule.firstSeq > trigger.seq ? rule.firstAt : trigger.at) + ms;
    out.push({ rule, due, done, late: done ? Date.parse(done.at) > due : now > due });
  }
  return out;
}

// ---- words for events ----

function describe(e, rules) {
  switch (e.event) {
    case 'data.received':
      return { step: '受付', title: 'お問い合わせを受け付けました', note: '入力された内容は、送信の前にお使いのブラウザで暗号化されています。', by: e.meta.by ?? 'site' };
    case 'data.decrypted':
      return { step: '復号', title: '担当者が内容を読むために復号しました' };
    case 'data.plaintext_purged':
      return { step: '写しの削除', title: '担当者の端末から、復号した内容の写しを削除しました' };
    case 'data.answered':
      return { step: '対応完了', title: e.meta.outcome === 'no_reply_needed' ? '対応が完了しました（返信不要と判断しました）' : e.meta.outcome === 'replied' ? '対応が完了しました（返信しました）' : '対応が完了しました' };
    case 'data.deleted':
      return { step: '削除', title: 'お預かりした情報（暗号文）を削除しました', final: true };
    case 'duty.approval_requested':
      return { step: '承認の依頼', title: `${approvalOf(e, rules)}の承認を依頼しました`, minor: true };
    case 'duty.approved':
      return { step: '承認', title: `${approvalOf(e, rules)}を承認しました` };
    case 'duty.alerted':
      return { step: '通知', title: e.meta.stage === 'overdue' ? '期限を過ぎた作業があることを知らせました' : '期限のある作業を担当者に知らせました', minor: true, by: e.meta.by };
    default:
      return { step: 'その他', title: e.event, minor: true };
  }
}

function approvalOf(e, rules) {
  const rule = rules.find((r) => e.meta.item && dutyId(r.id, e.meta.item) === e.meta.duty);
  if (!rule) return '作業';
  return rule.expect === 'data.deleted' ? '削除' : `「${rule.title}」の実行`;
}

const SHORT = { 'rule.adopted': 'ルールを定めました', 'rule.retired': 'ルールを廃止しました', 'key.published': '暗号化に使う鍵を公開しました' };

const PROBLEMS = [
  [/^not JSON/, '記録として読めません。'],
  [/^prev does not match/, 'ひとつ前の記録とつながりません。記録が変更、削除、または並べ替えられています。'],
  [/^the first record names/, '先頭より前にあったはずの記録がありません。'],
  [/^seq is/, '通し番号が合いません。'],
  [/^spec is/, '記録の形式が違います。'],
  [/^chain is/, '別の記録簿の記録が混ざっています。'],
];
const problemText = (p) => `${p.line} 件目の記録: ${PROBLEMS.find(([re]) => re.test(p.reason))?.[1] ?? p.reason}`;

// ---- checking a log ----

async function verifyLog(op, eucaKey, status) {
  const r = { op, checks: [], verdict: 'ok', reasons: [], entries: [], rules: [], size: 0, unsigned: 0 };
  const check = (label, state, detail) => r.checks.push({ label, state, detail });
  const fail = (reason) => {
    r.verdict = 'fail';
    r.reasons.push(reason);
  };

  let operator;
  let euca;
  try {
    operator = parseVerifier(op.checkpoint_key);
    euca = parseVerifier(eucaKey);
  } catch (e) {
    r.verdict = 'unavailable';
    r.reasons.push(`登録簿にある検証用の鍵を読めません（${e.message}）。`);
    return r;
  }
  const internal = [];
  for (const w of op.witnesses ?? []) {
    try {
      internal.push({ name: w.name, verifier: parseVerifier(w.key) });
    } catch {
      internal.push({ name: w.name });
    }
  }

  let note;
  let lines;
  try {
    const base = op.url.replace(/\/$/, '');
    [note, lines] = await Promise.all([get(`${base}/checkpoint`), get(`${base}/chain.jsonl`).then((t) => t.split('\n').filter(Boolean))]);
  } catch {
    r.verdict = 'unavailable';
    r.reasons.push('運用者のサーバーから記録を取得できませんでした。時間をおいて、もう一度開いてください。');
    return r;
  }

  // 1. The chain: every record names the one before it.
  const chain = readChain(lines);
  r.entries = chain.entries;
  r.count = lines.length;
  if (chain.name !== op.origin) chain.problems.unshift({ line: 1, reason: `chain is ${JSON.stringify(chain.name)}` });
  if (chain.problems.length) {
    chain.problems.slice(0, 3).forEach((p) => fail(problemText(p)));
    check('記録のつながり', 'fail', problemText(chain.problems[0]));
  } else check('記録のつながり', 'ok', `${lines.length} 件すべてが、ひとつ前の記録とつながっています。`);

  // 2. The checkpoint: the operator's signature, and the cosignatures.
  let cp;
  try {
    cp = await verifyCheckpoint(note, operator, [euca, ...internal.map((w) => w.verifier).filter(Boolean)]);
    check('運用者の署名', 'ok', `${op.name} の鍵による署名を確認しました。`);
  } catch (e) {
    const cosig = /^signature by /.test(e.message) && !e.message.startsWith(`signature by ${operator.name}:`);
    fail(cosig ? '連署の署名が正しくありません。' : '運用者の署名を確認できませんでした。');
    check(cosig ? '連署' : '運用者の署名', 'fail', `${cosig ? '連署の署名が正しくありません' : '運用者の署名を確認できませんでした'}（${e.message}）。`);
    return r;
  }
  r.size = cp.size;
  r.unsigned = Math.max(0, lines.length - cp.size);

  const byEuca = cp.cosigned.find((c) => c.verifier === euca);
  r.eucaTime = byEuca?.time;
  if (byEuca) check('第三者の連署', 'ok', `EUCA の連署サーバーが ${when(byEuca.time * 1000)} に連署しました。`);
  else {
    if (r.verdict === 'ok') r.verdict = 'pending';
    check('第三者の連署', 'warn', 'この時点の記録に対する EUCA の連署が、まだありません。');
  }
  for (const w of internal) {
    const c = w.verifier && cp.cosigned.find((x) => x.verifier === w.verifier);
    if (c) check(`${w.name}の連署`, 'ok', `${w.name}が ${when(c.time * 1000)} に連署しました。`);
    else check(`${w.name}の連署`, 'warn', w.verifier ? `${w.name}の連署は、まだありません。` : `登録簿にある${w.name}の鍵を読めません。`);
  }

  // 3. What was signed is what is published.
  const leaves = lines.map((l) => leafHash(l));
  if (cp.size > lines.length) {
    fail(`署名された時点では ${cp.size} 件あった記録が、いまは ${lines.length} 件しか公開されていません。記録が削除されています。`);
    check('署名された内容との一致', 'fail', `署名は ${cp.size} 件に対するものですが、公開されている記録は ${lines.length} 件です。`);
  } else if (!equal(merkleRoot(leaves, cp.size), cp.root)) {
    fail('公開されている記録が、署名された内容と一致しません。署名のあとで記録が書き換えられています。');
    check('署名された内容との一致', 'fail', '公開されている記録から計算した値が、署名された値と一致しません。');
  } else check('署名された内容との一致', 'ok', `署名された ${cp.size} 件が、公開されている記録と一致します。${r.unsigned ? `そのあとに追加された ${r.unsigned} 件は、まだ署名されていません。` : ''}`);

  // 4. What EUCA's witness last cosigned is still there.
  const held = status?.logs?.[op.origin];
  if (held) {
    let root;
    try {
      root = unb64(held.root);
    } catch {
      root = undefined;
    }
    if (held.size > lines.length) {
      fail(`EUCA が連署した時点では ${held.size} 件あった記録が、いまは ${lines.length} 件しか公開されていません。`);
      check('EUCA の控えとの照合', 'fail', `EUCA は ${held.size} 件の時点に連署していますが、公開されている記録は ${lines.length} 件です。`);
    } else if (!root || !equal(merkleRoot(leaves, held.size), root)) {
      fail('公開されている記録が、EUCA が連署した内容と一致しません。');
      check('EUCA の控えとの照合', 'fail', 'EUCA が最後に連署した内容と、公開されている記録が一致しません。');
    } else check('EUCA の控えとの照合', 'ok', `EUCA が最後に連署した時点（${held.size} 件、${when(held.time * 1000)}）の内容が、そのまま残っています。`);
  }

  r.rules = rulesOf(chain.entries);
  return r;
}

// ---- the screens ----

const ICON = { ok: '✓', warn: '…', fail: '×', unavailable: '?' };

function banner(r, forItem) {
  const meta = r.verdict === 'unavailable' ? [] : [r.op.name, r.count !== undefined && `記録 ${r.count} 件`, r.eucaTime && `EUCA の連署 ${when(r.eucaTime * 1000)}`].filter(Boolean);
  const body = {
    ok: ['確認できました', forItem ? 'この記録は、作成されたあとに書き換えられていません。' : 'この記録簿は、作成されたあとに書き換えられていません。'],
    pending: ['第三者の連署を待っています', '運用者の署名は確認できましたが、この時点の記録に対する EUCA の連署がまだありません。しばらくしてから、もう一度開いてください。'],
    fail: ['確認できませんでした', null],
    unavailable: ['確認できませんでした', null],
  }[r.verdict];
  return h(
    'section',
    { class: `banner is-${r.verdict}`, 'data-verdict': r.verdict },
    h('div', { class: 'banner-icon', 'aria-hidden': 'true' }, ICON[r.verdict === 'pending' ? 'warn' : r.verdict]),
    h(
      'div',
      { class: 'banner-body' },
      h('h1', null, body[0]),
      body[1] ? h('p', null, body[1]) : r.reasons.map((x) => h('p', null, x)),
      r.verdict === 'ok' && r.unsigned > 0 && h('p', { class: 'banner-note' }, `このあとに追加された ${r.unsigned} 件は、まだ署名されていません。次の署名で確認できるようになります。`),
      meta.length > 0 && h('p', { class: 'banner-meta' }, meta.map((m) => h('span', null, m))),
    ),
  );
}

function checksSection(r) {
  return h(
    'section',
    { class: 'card' },
    h('h2', null, '確認した内容'),
    h('ul', { class: 'checks' }, r.checks.map((c) => h('li', { class: `is-${c.state}` }, h('span', { class: 'mark', 'aria-hidden': 'true' }, ICON[c.state]), h('div', null, h('b', null, c.label), h('span', null, c.detail))))),
    // The rules are read from the chain: shown only when the chain checks out.
    (r.verdict === 'ok' || r.verdict === 'pending') && r.rules.length > 0 && [
      h('h3', null, '運用者が定めているルール'),
      h('ul', { class: 'rules' }, r.rules.map((rule) => h('li', null, h('b', null, rule.title), h('span', null, [rule.source && `根拠: ${rule.source}`, rule.within && `期限: ${span(rule.within)}以内`, rule.approval === 'required' && '実行の前に承認が必要'].filter(Boolean).join(' ・ '))))),
    ],
  );
}

function explain() {
  return h(
    'section',
    { class: 'card explain' },
    h('h2', null, 'この確認でわかること'),
    h(
      'dl',
      null,
      h('dt', null, 'わかること'),
      h('dd', null, '記録が、連署の時刻にはすでに存在していたこと。そのあとで、書き換えられたり、消されたりしていないこと。'),
      h('dt', null, 'わからないこと'),
      h('dd', null, '記録の内容が事実かどうか。記録は運用者自身による申告です。EUCA は、申告があとから書き換えられていないことだけを確かめています。'),
      h('dt', null, 'EUCA が持っているもの'),
      h('dd', null, 'お問い合わせの内容は持っていません。記録にあるのは、出来事の名前、日時、識別用の番号だけです。この確認はすべてお使いのブラウザの中で行われ、リンクに含まれる確認用の番号は、EUCA にも運用者にも送られません。'),
    ),
  );
}

function timeline(r, item) {
  const mine = r.entries.filter((e) => e.meta.item === item);
  if (!mine.length) {
    return h('section', { class: 'card' }, h('h2', null, 'あなたのお問い合わせの記録'), h('p', { class: 'empty' }, h('b', null, 'まだ記録されていません。'), 'この確認用のリンクに対応する記録は、まだありません。送信の直後は、記録されるまで少し時間がかかることがあります。リンクが途中で切れていないかも確かめてください。'));
  }
  const signed = r.verdict === 'ok' || r.verdict === 'pending';
  const plans = plansFor(r.rules, r.entries, item, Date.now());
  return h(
    'section',
    { class: 'card' },
    h('h2', null, 'あなたのお問い合わせの記録'),
    h('p', { class: 'lead' }, '日時は日本時間です。'),
    h(
      'ol',
      { class: 'timeline' },
      mine.map((e) => {
        const d = describe(e, r.rules);
        const by = d.by ?? e.meta.by;
        return h(
          'li',
          { class: [d.minor && 'is-minor', d.final && 'is-final'].filter(Boolean).join(' '), 'data-event': e.event },
          h('span', { class: 'step' }, d.step),
          h('b', null, d.title),
          d.note && h('span', { class: 'note' }, d.note),
          h('span', { class: 'facts' }, [when(e.at), by && who(by), `${e.seq + 1} 件目の記録`].filter(Boolean).map((x) => h('span', null, x)), signed && e.seq >= r.size && h('span', { class: 'tag' }, 'まだ署名されていません')),
        );
      }),
    ),
    plans.length > 0 && [
      h('h3', null, 'ルールにもとづく予定'),
      h(
        'ul',
        { class: 'plans' },
        plans.map((p) => {
          const state = p.done ? (p.late ? 'late' : 'done') : p.late ? 'overdue' : 'due';
          const label = { done: '完了', late: '期限後に完了', overdue: '期限超過', due: '予定' }[state];
          return h('li', { class: `is-${state}`, 'data-plan': state }, h('span', { class: 'badge' }, label), h('div', null, h('b', null, p.rule.title), h('span', null, p.done ? `${when(p.done.at, false)} に完了（期限 ${when(p.due, false)}）` : `期限 ${when(p.due, false)}`)));
        }),
      ),
    ],
  );
}

function recent(r) {
  const rows = r.entries.slice(-30).reverse();
  if (!rows.length) return null;
  return h(
    'section',
    { class: 'card' },
    h('h2', null, '最近の記録'),
    h('p', { class: 'lead' }, `全 ${r.entries.length} 件のうち、新しいものから ${rows.length} 件です。日時は日本時間です。`),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        null,
        h('thead', null, h('tr', null, ['件目', '日時', '出来事', '識別用の番号', '担当'].map((x) => h('th', null, x)))),
        h(
          'tbody',
          null,
          rows.map((e) => {
            const d = SHORT[e.event] ? { title: SHORT[e.event] + (e.meta.title ? `（${e.meta.title}）` : '') } : describe(e, r.rules);
            return h('tr', null, h('td', null, e.seq + 1), h('td', null, when(e.at)), h('td', null, d.title), h('td', { class: 'mono' }, e.meta.item ? e.meta.item.slice(0, 8) : ''), h('td', null, who(d.by ?? e.meta.by ?? '')));
          }),
        ),
      ),
    ),
  );
}

function listLogs(registry) {
  const ops = registry.operators ?? [];
  return [
    h('section', { class: 'intro' }, h('h1', null, '記録の確認'), h('p', null, '事業者が残した取り扱いの記録が、あとから書き換えられていないことを確かめるサイトです。確認用のリンクをお持ちの方は、そのリンクを開いてください。')),
    h(
      'section',
      { class: 'card' },
      h('h2', null, '連署している記録'),
      ops.length
        ? h('ul', { class: 'logs' }, ops.map((op) => h('li', null, h('a', { href: `#o=${encodeURIComponent(op.origin)}` }, h('b', null, op.name), h('span', { class: 'mono' }, op.origin)))))
        : h('p', { class: 'empty' }, 'まだ登録されている記録はありません。'),
    ),
    explain(),
  ];
}

async function main() {
  const params = new URLSearchParams(location.hash.slice(1));
  const origin = params.get('o');
  const token = params.get('t');
  app.replaceChildren(h('p', { class: 'loading' }, '記録を確認しています…'));
  document.body.dataset.state = 'loading';

  let registry;
  let eucaKey;
  let status;
  try {
    const custom = LOCAL && new URLSearchParams(location.search).get('registry');
    [registry, eucaKey, status] = await Promise.all([get(custom || '/registry.json').then(JSON.parse), get('/witness.vkey'), get('/status.json').then(JSON.parse).catch(() => undefined)]);
  } catch {
    app.replaceChildren(h('section', { class: 'banner is-unavailable', 'data-verdict': 'unavailable' }, h('div', { class: 'banner-icon', 'aria-hidden': 'true' }, '?'), h('div', { class: 'banner-body' }, h('h1', null, '確認できませんでした'), h('p', null, '確認に必要な情報を読み込めませんでした。時間をおいて、もう一度開いてください。'))));
    document.body.dataset.state = 'done';
    return;
  }

  if (!origin) {
    app.replaceChildren(...listLogs(registry));
    document.body.dataset.state = 'done';
    return;
  }
  const op = (registry.operators ?? []).find((o) => o.origin === origin);
  if (!op) {
    app.replaceChildren(
      h('section', { class: 'banner is-unavailable', 'data-verdict': 'unavailable' }, h('div', { class: 'banner-icon', 'aria-hidden': 'true' }, '?'), h('div', { class: 'banner-body' }, h('h1', null, '確認できませんでした'), h('p', null, 'この記録は、EUCA の登録簿にありません。リンクが正しいか確かめてください。'), h('p', { class: 'banner-meta' }, h('span', { class: 'mono' }, origin)))),
      h('p', { class: 'back' }, h('a', { href: '#' }, '連署している記録の一覧へ')),
    );
    document.body.dataset.state = 'done';
    return;
  }

  const r = await verifyLog(op, eucaKey, status);
  const item = token ? hex(sha256(utf8(token))).slice(0, 32) : undefined;
  const trusted = r.verdict === 'ok' || r.verdict === 'pending';
  app.replaceChildren(
    ...[
      banner(r, Boolean(item)),
      // What a record says is shown only when the record itself checks out.
      item && trusted && timeline(r, item),
      !item && trusted && recent(r),
      r.checks.length > 0 && checksSection(r),
      explain(),
      h('p', { class: 'back' }, h('button', { type: 'button', id: 'again' }, 'もう一度確認する'), !item && h('a', { href: '#' }, '連署している記録の一覧へ')),
    ].filter(Boolean),
  );
  document.getElementById('again')?.addEventListener('click', main);
  document.body.dataset.state = 'done';
}

window.addEventListener('hashchange', main);
main();
