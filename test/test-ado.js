'use strict';
/**
 * Tests for lib/ado.js against the in-process Azure DevOps stand-in (test/ado-stub.js). No network is used.
 * Expected values are written out by hand. Run: node test/test-ado.js
 */
const assert = require('assert');
const Ado = require('../lib/ado.js');
const Text = require('../lib/text.js');
const { createStub } = require('./ado-stub.js');

let failed = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

const BEARER = 'bearer-token-1';
const PAT = 'pat-token-1';
const noSleep = () => Promise.resolve();

function setup(stubOptions, clientOptions) {
  const stub = createStub(stubOptions);
  const log = [];
  const sleeps = [];
  let authCalls = 0;
  const client = Ado.createClient({
    org: 'contoso',
    fetch: stub.fetch,
    log: (l) => log.push(l),
    sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    auth: async () => { authCalls++; return { scheme: 'Bearer', token: stub.opts.bearer }; },
    ...(clientOptions || {}),
  });
  return { stub, client, log, sleeps, authCalls: () => authCalls };
}
const rejects = async (p, kind, re) => {
  try { await p; } catch (e) {
    assert.ok(e instanceof Ado.AdoError, 'an AdoError, got ' + (e && e.stack));
    if (kind) { assert.strictEqual(e.kind, kind, e.message); }
    if (re) { assert.match(e.message, re); }
    return e;
  }
  assert.fail('expected a rejection' + (kind ? ' of kind ' + kind : ''));
};

check('organisation names: accepted forms, and everything else refused', () => {
  const good = [
    ['contoso', 'contoso'], ['  Contoso  ', 'Contoso'], ['https://dev.azure.com/contoso', 'contoso'], ['https://dev.azure.com/contoso/', 'contoso'],
    ['dev.azure.com/contoso/Some%20Project', null], ['https://dev.azure.com/contoso/Shop/_backlogs', 'contoso'],
    ['https://contoso.visualstudio.com', 'contoso'], ['my-org-1', 'my-org-1'], ['a', 'a'],
  ];
  for (const [input, want] of good) {
    const r = Ado.parseOrganization(input);
    if (want === null) { assert.ok(!r.ok, input + ' contains an escape'); } else { assert.deepStrictEqual(r, { ok: true, org: want }, input); }
  }
  const bad = [
    '', ' ', 'a b', 'contoso.evil.com', 'evil.com/contoso', 'http://dev.azure.com/contoso', 'https://evil.com/dev.azure.com/contoso',
    'https://dev.azure.com@evil.com/contoso', 'https://user:pw@dev.azure.com/contoso', 'contoso/../x', '-contoso', 'contoso-', 'con\\toso', 'con%2Ftoso',
    'contoso?x=1', 'contoso#x', 'https://dev.azure.com/', 'https://dev.azure.com/con toso', 'x'.repeat(60), 'a'.repeat(201), '\u0000', 'conto\nso',
    'https://dev.azure.com.evil.com/contoso', 'https://evil.com/?https://dev.azure.com/contoso', 'ftp://dev.azure.com/contoso', null, undefined, 42, {}, [],
  ];
  for (const input of bad) { assert.ok(!Ado.parseOrganization(input).ok, JSON.stringify(input)); }
  assert.throws(() => Ado.createClient({ org: 'evil.com/x', auth: async () => ({}) }), /organisation/);
});

check('project names: Azure DevOps rules, and nothing that could change a path', () => {
  for (const ok of ['Shop', 'My Project', 'Shop-2', 'A', 'x'.repeat(64)]) { assert.ok(Ado.validProject(ok), ok); }
  for (const bad of ['', ' Shop', 'Shop ', '.Shop', '_Shop', 'Shop.', '../x', 'a/b', 'a\\b', 'a?b', 'a#b', 'a%b'.replace('%', '\u0000'), 'a;b', 'a"b', 'a<b', 'x'.repeat(65), null, undefined, 3, 'a\nb', 'a$b']) {
    assert.ok(!Ado.validProject(bad), JSON.stringify(bad));
  }
});

check('rich text from Azure DevOps becomes plain text: tags are dropped, never run', () => {
  const t = Text.stripTags('<div>As a <b>user</b> I can &lt;log in&gt; &amp; out<br>Second&nbsp;line</div><script>alert(1)</script><style>p{}</style><p>Para</p>');
  assert.strictEqual(t, 'As a user I can <log in> & out\nSecond line\n  Para\n');
  assert.strictEqual(Text.stripTags(null), ''); assert.strictEqual(Text.stripTags(undefined), ''); assert.strictEqual(Text.stripTags(42), '42');
  assert.strictEqual(Text.stripTags('&amp;lt;b&amp;gt;'), '&lt;b&gt;', 'an escaped ampersand is decoded once, so text that looks like a tag stays text');
  assert.strictEqual(Text.stripTags('&lt;script&gt;alert(1)&lt;/script&gt;'), '<script>alert(1)</script>', 'tags that were escaped come out as text, not as something to strip twice');
  assert.strictEqual(Text.stripTags('a < b and c'), 'a < b and c', 'a "<" with no ">" after it is just text');
  assert.strictEqual(Text.stripTags('<SCRIPT>x</SCRIPT>after'), ' after', 'tag names are matched whatever their case');
  assert.strictEqual(Text.stripTags('<script>never closed <b>bold</b>'), 'never closed bold', 'an unclosed script is not allowed to swallow the rest');
  assert.strictEqual(Text.stripTags('<ul><li>One</li><li>Two</li></ul>'), 'One\nTwo\n');
  assert.ok(!/\u0000/.test(Text.cleanText('a\u0000b', 50)));
  assert.strictEqual(Text.cleanText('x'.repeat(10000), 50).length, 50);
});

check('rich text from Azure DevOps is read in linear time, whatever it is made of', () => {
  // Each of these used to be able to make a backtracking pattern search to the end of the text from every "<". They are 1 to 2 MB each.
  const N = 200000;
  const BIG = 1000000;   // a million "<" is 1 MB: a search from every one of them to the end would be a trillion steps
  const nasty = [
    ['only "<"', '<'.repeat(BIG)],
    ['"<" and one ">" at the very end', '<'.repeat(BIG) + '>'],
    ['<pre> opened, never closed', '<pre>'.repeat(N / 2)],
    ['<script with no ">"', '<script '.repeat(N / 2)],
    ['<script> opened, never closed', '<script>'.repeat(N / 2)],
    ['<script></script> pairs', '<script></script>'.repeat(N / 4)],
    ['<style> opened, never closed, mixed with script', '<style><script>'.repeat(N / 4)],
    ['tag names with no end', '<a'.repeat(N)],
    ['<br> only', '<br>'.repeat(N)],
    ['entities', '&amp;'.repeat(N)],
    ['"&#" with no digits', '&#'.repeat(N)],
  ];
  for (const [name, input] of nasty) {
    const t0 = Date.now();
    const out = Text.stripTags(input);
    const ms = Date.now() - t0;
    assert.ok(ms < 1500, `${name}: took ${ms} ms`);
    assert.strictEqual(typeof out, 'string');
  }
  assert.strictEqual(Text.stripTags('<'.repeat(1000)), '<'.repeat(1000), 'nothing is lost from text that only looks like markup');
  assert.strictEqual(Text.stripTags('&amp;'.repeat(3)), '&&&');
});

check('listProjects: one GET to the organisation, Bearer sign-in, redirects off, no body', async () => {
  const { stub, client, log } = setup();
  const list = await client.listProjects();
  assert.deepStrictEqual(list.map((p) => p.name), ['Shop', 'Throwaway']);
  assert.strictEqual(stub.requests.length, 1);
  const r = stub.requests[0];
  assert.strictEqual(r.method, 'GET');
  assert.strictEqual(r.host, 'https://dev.azure.com');
  assert.strictEqual(r.path, '/contoso/_apis/projects');
  assert.strictEqual(r.query['api-version'], '7.1');
  assert.strictEqual(r.redirect, 'manual');
  assert.strictEqual(r.headers.Authorization, 'Bearer ' + BEARER);
  assert.strictEqual(r.body, undefined);
  assert.strictEqual(r.headers['X-TFS-FedAuthRedirect'], 'Suppress');
  assert.deepStrictEqual(log.length, 1);
  assert.match(log[0], /^GET \/contoso\/_apis\/projects -> 200 \(\d+ ms\)$/);
});

check('a personal access token goes as Basic with an empty user name', async () => {
  const { stub, client } = setup({}, { auth: async () => ({ scheme: 'Basic', token: PAT }) });
  await client.listProjects();
  assert.strictEqual(stub.requests[0].headers.Authorization, 'Basic ' + Buffer.from(':' + PAT).toString('base64'));
});

check('the sign-in is asked for on every request, never kept', async () => {
  const { client, authCalls } = setup();
  await client.listProjects(); await client.listProjects(); await client.getStory(5);
  assert.strictEqual(authCalls(), 3);
});

check('a bad token: the error says to connect again and contains no token; the log has none either', async () => {
  const secret = 'SECRET-TOKEN-VALUE-123';
  const { client, log } = setup({}, { auth: async () => ({ scheme: 'Bearer', token: secret }) });
  const e = await rejects(client.listProjects(), 'auth', /Connect again/);
  assert.ok(!JSON.stringify({ m: e.message, s: e.stack, k: e.kind, st: e.status }).includes(secret));
  assert.ok(!log.join('\n').includes(secret));
  assert.ok(!log.join('\n').toLowerCase().includes('authorization'));
});

check('a server message that echoes the token is cleaned before it reaches the error', async () => {
  const secret = 'ECHOED-SECRET-999';
  const { stub, client } = setup();
  stub.state.chaos = () => new Response(JSON.stringify({ message: `bad request: token ${secret} and ${Buffer.from(':' + secret).toString('base64')}` }), { status: 400, headers: { 'content-type': 'application/json' } });
  const c2 = Ado.createClient({ org: 'contoso', fetch: stub.fetch, sleep: noSleep, auth: async () => ({ scheme: 'Basic', token: secret }) });
  const e = await rejects(c2.listProjects(), 'invalid');
  assert.ok(!e.message.includes(secret) && !e.message.includes(Buffer.from(':' + secret).toString('base64')), e.message);
  assert.ok(!(e.detail || '').includes(secret));
  assert.ok(client);
});

check('redaction: the token is removed before the text is cut, whatever form it comes back in', async () => {
  const secret = 'Zq7/Tk+Pw=9Lm?x&y-Hidden_Tokenx';   // 31 characters, so both base64 forms end in padding
  const forms = {
    'plain': secret,
    'URL-encoded': encodeURIComponent(secret),
    'base64 of user:token': Buffer.from(':' + secret).toString('base64'),
    'base64 of token': Buffer.from(secret).toString('base64'),
    'base64url of user:token': Buffer.from(':' + secret).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    'base64 of the token with the padding cut off': Buffer.from(secret).toString('base64').replace(/=+$/, ''),
    'base64 of user:token with the padding cut off': Buffer.from(':' + secret).toString('base64').replace(/=+$/, ''),
    'with zero-width spaces and a bidi mark inside': secret.slice(0, 8) + '\u200b' + secret.slice(8, 15) + '\u202e' + secret.slice(15),
    'as numeric HTML entities': [...secret].map((c) => `&#${c.charCodeAt(0)};`).join(''),
    'as hex HTML entities': [...secret].map((c) => `&#x${c.charCodeAt(0).toString(16)};`).join(''),
  };
  const cases = [];
  for (const [name, form] of Object.entries(forms)) {
    cases.push([name, `rejected: ${form} was seen`]);
    // The token starts a few characters before the 300-character cut: it must be removed first, not left half-visible after the cut.
    cases.push([name + ', straddling the 300-character cut', 'x'.repeat(292) + form + ' trailing']);
  }
  for (const [name, message] of cases) {
    const stub = createStub();
    stub.state.chaos = () => new Response(JSON.stringify({ message }), { status: 400, headers: { 'content-type': 'application/json' } });
    const c = Ado.createClient({ org: 'contoso', fetch: stub.fetch, sleep: noSleep, auth: async () => ({ scheme: 'Basic', token: secret }) });
    const e = await rejects(c.listProjects(), 'invalid');
    const shown = `${e.message} ${e.detail || ''}`;
    for (const piece of ['Zq7/Tk', 'Tk+Pw', 'Hidden_Token', 'Hidden_', 'Zq7', secret.slice(0, 6), secret.slice(-6), Buffer.from(secret).toString('base64').slice(0, 12), Buffer.from(':' + secret).toString('base64').slice(0, 12)]) {
      assert.ok(!shown.includes(piece), `${name}: "${piece}" is still visible in: ${shown}`);
    }
    assert.ok(shown.includes('***'), `${name}: the removal is visible as ***: ${shown}`);
  }
});

check('tokens that cannot be header values are refused before any request', async () => {
  for (const token of ['', 'has space', 'new\nline', 'x'.repeat(5000), 'tab\there', null, 42]) {
    const stub = createStub();
    const c = Ado.createClient({ org: 'contoso', fetch: stub.fetch, auth: async () => ({ scheme: 'Bearer', token }) });
    await rejects(c.listProjects(), 'auth');
    assert.strictEqual(stub.requests.length, 0, JSON.stringify(token));
  }
  const stub = createStub();
  const c = Ado.createClient({ org: 'contoso', fetch: stub.fetch, auth: async () => ({ scheme: 'Digest', token: 'abc' }) });
  await rejects(c.listProjects(), 'auth');
  assert.strictEqual(stub.requests.length, 0);
});

check('a sign-in page (203, or 200 with HTML) is an auth error, not data', async () => {
  for (const code of [203, 200]) {
    const { client } = setup({ signInPageStatus: code });
    await rejects(client.listProjects(), 'auth', /sign-in/);
  }
});

check('redirects are never followed, to anywhere', async () => {
  for (const [status, to] of [[302, 'https://evil.example/steal'], [301, 'https://dev.azure.com/other/_apis/projects'], [307, 'http://dev.azure.com/contoso/_apis/projects']]) {
    const { stub, client } = setup();
    stub.state.chaos = () => new Response(null, { status, headers: { location: to } });
    await rejects(client.listProjects(), 'auth', /redirected/);
    assert.strictEqual(stub.requests.length, 1, 'one request only');
    assert.ok(stub.requests.every((r) => r.host === 'https://dev.azure.com' && r.redirect === 'manual'));
  }
});

check('status codes become plain, specific errors', async () => {
  const cases = [[403, 'forbidden', /permission/], [404, 'notfound', /could not find/], [409, 'conflict', /same time/], [412, 'conflict', /same time/], [500, 'server', /problem/], [502, 'server', /problem/], [400, 'invalid', /refused/]];
  for (const [status, kind, re] of cases) {
    const { stub, client } = setup();
    stub.state.chaos = () => new Response(JSON.stringify({ message: 'detail here' }), { status, headers: { 'content-type': 'application/json' } });
    await rejects(client.listProjects(), kind, re);
  }
});

check('429: waits as told, then succeeds; gives up after the retry limit', async () => {
  const { stub, client, sleeps } = setup();
  let n = 0;
  stub.state.chaos = () => (++n <= 2 ? new Response('', { status: 429, headers: { 'retry-after': '3' } }) : null);
  const list = await client.listProjects();
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(sleeps, [3000, 3000]);
  assert.strictEqual(stub.requests.length, 3);

  const t = setup();
  t.stub.state.chaos = () => new Response('', { status: 429, headers: { 'retry-after': '99999' } });
  await rejects(t.client.listProjects(), 'rate', /slow down/);
  assert.strictEqual(t.stub.requests.length, 3, 'first try plus two retries');
  assert.ok(t.sleeps.every((ms) => ms <= Ado.LIMITS.retryWaitMs), 'a huge Retry-After is capped: ' + t.sleeps);
});

check('network failures: a read is retried; a create is not (it might have happened)', async () => {
  const a = setup();
  let n = 0;
  a.stub.state.chaos = () => { if (++n === 1) { throw new TypeError('fetch failed'); } return null; };
  assert.strictEqual((await a.client.listProjects()).length, 2);
  assert.strictEqual(a.stub.requests.length, 2);

  const b = setup();
  const st = b.stub.addStory(10, 'Story');
  b.stub.state.chaos = () => { throw new TypeError('fetch failed'); };
  const story = { id: st.id, project: 'Shop', areaPath: 'Shop', iterationPath: 'Shop\\Sprint 1' };
  await rejects(b.client.createTrackingTask({ story, descriptionHtml: '<p>x</p>' }), 'network', /Could not reach/);
  assert.strictEqual(b.stub.requests.length, 1, 'no second create');
});

check('a request that times out says so and is not retried', async () => {
  const { stub, client } = setup();
  stub.state.chaos = () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
  await rejects(client.listProjects(), 'timeout', /did not answer/);
  assert.strictEqual(stub.requests.length, 1);
});

check('a reply bigger than the cap is refused, whether it announces its size or not', async () => {
  const big = 'x'.repeat(Ado.LIMITS.bytes + 10);
  const a = setup();
  a.stub.state.chaos = () => new Response(big, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(big.length) } });
  await rejects(a.client.listProjects(), 'too_large');

  const b = setup();
  b.stub.state.chaos = () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    let sent = 0;
    const body = new ReadableStream({ pull(c) { if (sent++ < 8) { c.enqueue(chunk); } else { c.close(); } } });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await rejects(b.client.listProjects(), 'too_large');
});

check('a reply that is not JSON is an error, not a crash', async () => {
  const { stub, client } = setup();
  stub.state.chaos = () => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  await rejects(client.listProjects(), 'auth');
  const t = setup();
  t.stub.state.chaos = () => new Response('', { status: 200 });
  assert.deepStrictEqual(await t.client.listProjects(), [], 'an empty reply is no projects');
});

check('project and organisation text can never change where a request goes', async () => {
  const { stub, client } = setup();
  for (const p of ['../other', 'Shop/../../x', 'a?b=c', 'a#b', '', ' Shop', null]) {
    await rejects(client.listStories({ project: p }), 'invalid');
  }
  await rejects(client.createTrackingTask({ story: { id: 1, project: '../x' }, descriptionHtml: 'x' }), 'invalid');
  assert.strictEqual(stub.requests.length, 0);
  const sneaky = setup();
  sneaky.stub.addStory(7, 'S');
  await sneaky.client.getStory(7);
  assert.ok(sneaky.stub.requests.every((r) => r.url.startsWith('https://dev.azure.com/contoso/')));
});

check('listStories: one query for numbers, one batch read; the query carries the project and quoted types', async () => {
  const { stub, client } = setup();
  stub.addStory(11, 'First', { 'System.Tags': 'x; y' });
  stub.addStory(12, 'Second', { 'Microsoft.VSTS.Scheduling.StoryPoints': undefined, 'Microsoft.VSTS.Scheduling.Effort': 8 });
  stub.addItem({ id: 13, fields: { 'System.Title': 'A bug', 'System.WorkItemType': 'Bug' } });
  const list = await client.listStories({ project: 'Shop' });
  assert.deepStrictEqual(list.map((s) => s.id), [12, 11], 'bugs are not stories; newest number first from the stand-in');
  assert.strictEqual(list[1].points, 5);
  assert.strictEqual(list[0].points, 8, 'points come from whichever field the process uses');
  assert.deepStrictEqual(list[1].tags, ['x', 'y']);
  assert.strictEqual(stub.count('POST', '/wit/wiql'), 1);
  assert.strictEqual(stub.count('GET', '/wit/workitems'), 1);
  const q = stub.requests.find((r) => r.method === 'POST').body.query;
  assert.match(q, /\[System\.TeamProject\] = @project/);
  assert.match(q, /IN \('User Story', 'Product Backlog Item', 'Requirement', 'Issue'\)/);
  assert.strictEqual(stub.requests.find((r) => r.method === 'POST').path, '/contoso/Shop/_apis/wit/wiql');
  assert.strictEqual(stub.requests.find((r) => r.method === 'POST').headers['Content-Type'], 'application/json');
});

check('listStories: a quote in a type name is doubled, bad type names are dropped', async () => {
  const { stub, client } = setup();
  await client.listStories({ project: 'Shop', types: ["Bob's Story", 'Bad\nType', '', 'x'.repeat(100), 'Good'] });
  const q = stub.requests.find((r) => r.method === 'POST').body.query;
  assert.match(q, /IN \('Bob''s Story', 'Good'\)/);
  assert.ok(!/Bad/.test(q));
  await rejects(client.listStories({ project: 'Shop', types: ['\n'] }), 'invalid', /story types/);
});

check('boards: the teams of a project, sorted by name; a bad project is refused before any request; a refusal is reported', async () => {
  const { stub, client } = setup();
  const teams = await client.listTeams('Shop');
  assert.deepStrictEqual(teams.map((t) => t.name), ['Checkout Team', 'Platform Team']);
  assert.ok(teams.every((t) => Ado.validTeamId(t.id)));
  assert.strictEqual(stub.requests[0].path, '/contoso/_apis/projects/Shop/teams');
  const before = stub.requests.length;
  for (const p of ['../x', 'a?b', '', null]) { await rejects(client.listTeams(p), 'invalid'); }
  assert.strictEqual(stub.requests.length, before, 'nothing was sent');
  const denied = setup({ teamListStatus: 403 });
  await rejects(denied.client.listTeams('Shop'), 'forbidden');
});

check('boards: a team is only ever addressed by its ID, so no name can change where a request goes', async () => {
  const { stub, client } = setup();
  assert.ok(Ado.validTeamId(stub.TEAM_CHECKOUT));
  for (const id of ['../x', 'Checkout Team', 'aaaaaaaa-0000-0000-0000-00000000000', '', null, `${stub.TEAM_CHECKOUT}/../..`]) {
    assert.ok(!Ado.validTeamId(id), String(id));
    await rejects(client.getTeamAreaPaths('Shop', id), 'invalid');
  }
  assert.strictEqual(stub.requests.length, 0, 'nothing was sent');
  const paths = await client.getTeamAreaPaths('Shop', stub.TEAM_PLATFORM);
  assert.deepStrictEqual(paths, [{ path: 'Shop\\Platform', includeChildren: false }, { path: 'Shop\\Shared', includeChildren: true }]);
  assert.strictEqual(stub.requests[0].path, `/contoso/Shop/${stub.TEAM_PLATFORM}/_apis/work/teamsettings/teamfieldvalues`);
  const odd = setup({ teamFieldName: 'Custom.Team' });
  await rejects(odd.client.getTeamAreaPaths('Shop', odd.stub.TEAM_CHECKOUT), 'invalid', /area path/);
});

check('listStories with area paths: only that board\'s stories; the sub-areas follow the team\'s setting; quotes are doubled', async () => {
  const { stub, client } = setup();
  stub.addStory(31, 'Checkout', { 'System.AreaPath': 'Shop\\Checkout' });
  stub.addStory(32, 'Checkout cart', { 'System.AreaPath': 'Shop\\Checkout\\Cart' });
  stub.addStory(33, 'Platform', { 'System.AreaPath': 'Shop\\Platform' });
  stub.addStory(34, 'Platform sub-area', { 'System.AreaPath': 'Shop\\Platform\\Sub' });
  stub.addStory(35, 'Shared', { 'System.AreaPath': 'Shop\\Shared\\Tools' });
  stub.addStory(36, 'Nobody');
  const ids = async (areaPaths) => (await client.listStories({ project: 'Shop', areaPaths })).map((s) => s.id).sort((a, b) => a - b);
  assert.deepStrictEqual(await ids(undefined), [31, 32, 33, 34, 35, 36], 'no board: everything');
  assert.deepStrictEqual(await ids(await client.getTeamAreaPaths('Shop', stub.TEAM_CHECKOUT)), [31, 32]);
  assert.deepStrictEqual(await ids(await client.getTeamAreaPaths('Shop', stub.TEAM_PLATFORM)), [33, 35], 'Platform does not include its own sub-areas, Shared does');
  const q = stub.requests.filter((r) => r.method === 'POST').pop().body.query;
  assert.match(q, /AND \(\[System\.AreaPath\] = 'Shop\\Platform' OR \[System\.AreaPath\] UNDER 'Shop\\Shared'\)/);
  await client.listStories({ project: 'Shop', areaPaths: [{ path: "Shop\\Bob's team", includeChildren: true }, { path: 'Bad\nPath' }, { path: '' }] });
  const q2 = stub.requests.filter((r) => r.method === 'POST').pop().body.query;
  assert.match(q2, /UNDER 'Shop\\Bob''s team'\)/);
  assert.ok(!/Bad/.test(q2));
  await rejects(client.listStories({ project: 'Shop', areaPaths: [] }), 'invalid', /no area path/);
  await rejects(client.listStories({ project: 'Shop', areaPaths: [{ path: '\n' }] }), 'invalid', /no area path/);
});

check('listStories: more than 200 numbers are read in batches of 200', async () => {
  const { stub, client } = setup();
  for (let i = 0; i < 205; i++) { stub.addStory(1000 + i, 'S' + i); }
  const list = await client.listStories({ project: 'Shop', top: 500 });
  assert.strictEqual(list.length, 205);
  const batches = stub.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/wit/workitems'));
  assert.deepStrictEqual(batches.map((b) => b.query.ids.split(',').length), [200, 5]);
  assert.strictEqual(new Set(list.map((s) => s.id)).size, 205);
});

check('a field this organisation does not have: ask again without the field list (either plausible reply)', async () => {
  for (const status of [400, 404]) {
    const { stub, client } = setup({ unknownFieldStatus: status });
    stub.addStory(21, 'Story');
    if (status === 404) {
      // 404 would be taken as "not found"; the client must not loop or hide it
      await rejects(client.listStories({ project: 'Shop' }), 'notfound');
    } else {
      const list = await client.listStories({ project: 'Shop' });
      assert.deepStrictEqual(list.map((s) => s.id), [21]);
      assert.strictEqual(stub.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/wit/workitems')).length, 2);
      assert.strictEqual(stub.requests[stub.requests.length - 1].query.fields, undefined);
    }
  }
});

check('getStory: fields, parent and child links; missing is null; bad numbers refused without a request', async () => {
  const { stub, client } = setup();
  const s = stub.addStory(30, 'Parent story', { 'System.Description': '<p>Do <b>it</b></p>', 'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>One</li><li>Two</li></ul>' });
  const c = stub.addItem({ id: 31, fields: { 'System.Title': 'Child task', 'System.WorkItemType': 'Task' }, relations: [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/contoso/_apis/wit/workItems/30' }] });
  s.relations.push({ rel: 'System.LinkTypes.Hierarchy-Forward', url: c.url }, { rel: 'AttachedFile', url: 'https://dev.azure.com/contoso/_apis/wit/attachments/abc' }, { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'https://evil.example/x' });
  const got = await client.getStory(30);
  assert.strictEqual(got.title, 'Parent story');
  assert.strictEqual(got.description, '', 'a story\'s description and acceptance criteria are never kept: the estimate does not use them');
  assert.ok(!JSON.stringify(got).includes('Do it') && !JSON.stringify(got).includes('One'), 'their text is nowhere in what the client returns');
  assert.deepStrictEqual(got.tags, []);
  assert.deepStrictEqual(got.children, [31], 'only work item links count');
  assert.strictEqual(got.project, 'Shop');
  assert.strictEqual((await client.getStory(31)).parent, 30);
  assert.strictEqual(await client.getStory(99999), null);
  stub.reset();
  for (const bad of [0, -1, 1.5, '12', NaN, null, 2147483648]) { await rejects(client.getStory(bad), 'invalid'); }
  assert.strictEqual(stub.requests.length, 0);
});

check('long text is not asked for: stories are read without a description, and only the one tracking Task is read with it', async () => {
  const { stub, client } = setup();
  stub.addStory(60, 'Story sixty', { 'System.Description': '<p>private details about the customer</p>', 'Microsoft.VSTS.Common.AcceptanceCriteria': '<p>secret criteria</p>' });
  const story = await client.getStory(60);
  const t = await client.createTrackingTask({ story, descriptionHtml: '<pre>{"schema":"x"}</pre>' });
  stub.reset();
  const kids = await client.getItems([60, t.id], { project: 'Shop' });
  const read = stub.requests[0];
  assert.strictEqual(stub.requests.length, 1);
  const asked = read.query.fields.split(',');
  assert.ok(!asked.includes('System.Description') && !asked.includes('Microsoft.VSTS.Common.AcceptanceCriteria'), 'the field list has no long text: ' + read.query.fields);
  assert.ok(kids.every((k) => k.description === ''), 'nothing long is returned');
  stub.reset();
  const found = await client.findTrackingTask({ ...story, children: [t.id] });
  assert.strictEqual(stub.requests.length, 2, 'one read of the children, then one read of the chosen Task alone');
  assert.ok(!stub.requests[0].query.fields.includes('System.Description'));
  assert.deepStrictEqual(stub.requests[1].query.ids, String(t.id), 'the second read is for the one Task');
  assert.ok(stub.requests[1].query.fields.includes('System.Description'));
  assert.strictEqual(found.task.description, '<pre>{"schema":"x"}</pre>');
});

check('hostile content from Azure DevOps is cleaned, capped and cannot pollute anything', async () => {
  const { stub, client } = setup();
  const evil = 'T\u0000i\u202etle\n\t' + 'x'.repeat(5000);
  stub.addStory(40, evil, { 'System.Tags': '__proto__; constructor; ' + 'y'.repeat(500), 'System.State': 'A\nB' });
  const it = stub.items.get(40);
  it.fields['__proto__x'] = 1;
  it.relations.push({ rel: 'System.LinkTypes.Hierarchy-Forward', url: 'javascript:alert(1)//workitems/41' });
  const got = await client.getStory(40);
  assert.ok(got.title.length <= 200 && !/[\u0000\n\t\u202e]/.test(got.title));
  assert.strictEqual(got.state, 'A B');
  assert.ok(got.tags.every((t) => t.length <= 60));
  assert.deepStrictEqual(got.children, [41], 'a number is a number whatever the link looks like; the host builds every URL it calls');
  assert.strictEqual({}.polluted, undefined);
  const bad = [{ value: [null, 1, 'x', { id: 'a', fields: {} }, { id: 5 }, { id: 6, fields: null }, { id: 7, rev: 'x', fields: {} }] }];
  stub.state.chaos = () => new Response(JSON.stringify(bad[0]), { status: 200, headers: { 'content-type': 'application/json' } });
  const items = await client.getItems([7]);
  assert.deepStrictEqual(items.map((i) => i.id), [7]);
  assert.strictEqual(items[0].rev, 0);
});

check('tracking task: none yet; then created under the story; found again; no second one', async () => {
  const { stub, client } = setup();
  stub.addStory(50, 'Story fifty', { 'System.AreaPath': 'Shop\\Team A', 'System.IterationPath': 'Shop\\Sprint 7' });
  const story = await client.getStory(50);
  assert.deepStrictEqual(await client.findTrackingTask(story), { task: null, duplicates: [] });
  const t = await client.createTrackingTask({ story, descriptionHtml: '<pre>{}</pre>' });
  assert.strictEqual(t.type, 'Task');
  assert.strictEqual(t.title, 'Copilot Lens usage for #50');
  assert.deepStrictEqual(t.tags, ['copilot-lens']);
  assert.strictEqual(t.areaPath, 'Shop\\Team A');
  assert.strictEqual(t.iterationPath, 'Shop\\Sprint 7');
  assert.strictEqual(t.parent, null, 'the create reply does not expand links');
  const post = stub.requests.find((r) => r.method === 'POST' && r.path.includes('/workitems/$Task'));
  assert.strictEqual(post.path, '/contoso/Shop/_apis/wit/workitems/$Task');
  assert.strictEqual(post.headers['Content-Type'], 'application/json-patch+json');
  const link = post.body.find((o) => o.path === '/relations/-');
  assert.strictEqual(link.value.rel, 'System.LinkTypes.Hierarchy-Reverse');
  assert.strictEqual(link.value.url, 'https://dev.azure.com/contoso/_apis/wit/workItems/50');
  assert.ok(post.body.every((o) => o.op === 'add'));
  const again = await client.findTrackingTask(await client.getStory(50));
  assert.strictEqual(again.task.id, t.id);
  assert.deepStrictEqual(again.duplicates, []);
  assert.strictEqual((await client.getStory(t.id)).parent, 50);
});

check('tracking task: other children are ignored; real duplicates are reported, the lowest number is used', async () => {
  const { stub, client } = setup();
  stub.addStory(60, 'S');
  const mk = (title, tags, type) => stub.addItem({ fields: { 'System.Title': title, 'System.Tags': tags, 'System.WorkItemType': type || 'Task' }, relations: [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/contoso/_apis/wit/workItems/60' }] });
  const link = (c) => stub.items.get(60).relations.push({ rel: 'System.LinkTypes.Hierarchy-Forward', url: c.url });
  const other = mk('Write the code', ''); link(other);
  const lookalike = mk('Copilot Lens usage for #60', 'unrelated'); link(lookalike);
  const wrongType = mk('Copilot Lens usage for #60', 'copilot-lens', 'Bug'); link(wrongType);
  const second = mk('Copilot Lens usage for #60', 'Copilot-Lens; x'); link(second);
  const first = mk('Copilot Lens usage (older name)', 'copilot-lens'); link(first);
  const r = await client.findTrackingTask(await client.getStory(60));
  assert.strictEqual(r.task.id, Math.min(second.id, first.id));
  assert.deepStrictEqual(r.duplicates, [Math.max(second.id, first.id)]);
});

check('tracking task: refuses to send what it cannot place or what is too big', async () => {
  const { stub, client } = setup();
  stub.addStory(70, 'S');
  const story = await client.getStory(70);
  stub.reset();
  await rejects(client.createTrackingTask({ story: null, descriptionHtml: 'x' }), 'invalid');
  await rejects(client.createTrackingTask({ story: { ...story, id: 0 }, descriptionHtml: 'x' }), 'invalid');
  await rejects(client.createTrackingTask({ story, descriptionHtml: 5 }), 'invalid');
  await rejects(client.createTrackingTask({ story, descriptionHtml: 'x'.repeat(Ado.LIMITS.description + 1) }), 'too_large');
  await rejects(client.updateTrackingTask({ task: { id: 1, rev: 0 }, descriptionHtml: 'x' }), 'invalid');
  await rejects(client.updateTrackingTask({ task: { id: 1, rev: 1.5 }, descriptionHtml: 'x' }), 'invalid');
  await rejects(client.updateTrackingTask({ task: { id: 1, rev: 1 }, descriptionHtml: 'x'.repeat(Ado.LIMITS.description + 1) }), 'too_large');
  assert.strictEqual(stub.requests.length, 0);
});

check('update: tests the revision first, replaces only the description, bumps the revision', async () => {
  const { stub, client } = setup();
  stub.addStory(80, 'S');
  const t = await client.createTrackingTask({ story: await client.getStory(80), descriptionHtml: '<p>v1</p>' });
  const updated = await client.updateTrackingTask({ task: t, descriptionHtml: '<p>v2</p>' });
  assert.strictEqual(updated.rev, t.rev + 1);
  assert.strictEqual(stub.items.get(t.id).fields['System.Description'], '<p>v2</p>', 'the description in Azure DevOps is the new one');
  assert.strictEqual(updated.description, '', 'the reply is not used to carry text back; the next sync reads the Task itself');
  const patch = stub.requests.filter((r) => r.method === 'PATCH');
  assert.strictEqual(patch.length, 1);
  assert.deepStrictEqual(patch[0].body, [{ op: 'test', path: '/rev', value: t.rev }, { op: 'replace', path: '/fields/System.Description', value: '<p>v2</p>' }]);
  assert.strictEqual(patch[0].headers['Content-Type'], 'application/json-patch+json');
  assert.strictEqual(stub.items.get(t.id).fields['System.Title'], 'Copilot Lens usage for #80', 'nothing else changed');
});

check('update: if someone changed the task meanwhile, nothing is overwritten (whatever status the service uses)', async () => {
  for (const status of [412, 409, 400]) {
    const { stub, client } = setup({ revFailureStatus: status });
    stub.addStory(90, 'S');
    const t = await client.createTrackingTask({ story: await client.getStory(90), descriptionHtml: '<p>v1</p>' });
    stub.touch(t.id, { 'System.Description': '<p>edited by a person</p>' });
    const e = await rejects(client.updateTrackingTask({ task: t, descriptionHtml: '<p>mine</p>' }));
    assert.ok(['conflict', 'invalid'].includes(e.kind), e.kind);
    assert.strictEqual(stub.items.get(t.id).fields['System.Description'], '<p>edited by a person</p>');
    const fresh = (await client.getItems([t.id], {}))[0];
    assert.ok(fresh.rev > t.rev, 'a re-read shows the newer revision, which is how the sync layer recognises a conflict');
  }
});

check('the client only ever reads, creates one Task, or replaces one description: no other verbs, no deletes', async () => {
  const { stub, client } = setup();
  stub.addStory(95, 'S');
  await client.whoAmI(); await client.listProjects(); await client.listStories({ project: 'Shop' });
  const s = await client.getStory(95);
  const t = await client.createTrackingTask({ story: s, descriptionHtml: 'a' });
  await client.updateTrackingTask({ task: t, descriptionHtml: 'b' });
  const verbs = new Set(stub.requests.map((r) => r.method));
  assert.deepStrictEqual([...verbs].sort(), ['GET', 'PATCH', 'POST']);
  for (const r of stub.requests) {
    assert.ok(r.url.startsWith('https://dev.azure.com/contoso/'), r.url);
    if (r.method !== 'GET') { assert.ok(/\/wit\/(wiql|workitems)/.test(r.path), r.path); }
  }
  assert.ok(!Object.keys(client).some((k) => /delete|remove|destroy/i.test(k)));
});

check('whoAmI: the signed-in person when known; null when the call is not available', async () => {
  const { client } = setup();
  assert.deepStrictEqual(await client.whoAmI(), { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Test Person' });
  const b = setup();
  b.stub.state.chaos = () => new Response('{}', { status: 404 });
  assert.strictEqual(await b.client.whoAmI(), null);
  const c = setup();
  c.stub.state.chaos = () => new Response(JSON.stringify({ authenticatedUser: { id: '<script>', providerDisplayName: 'Z' } }), { status: 200 });
  assert.deepStrictEqual(await c.client.whoAmI(), { id: '', name: 'Z' }, 'an id that is not an id is dropped');
});

check('work item numbers from links, and story points from whichever field exists', () => {
  assert.strictEqual(Ado.idFromUrl('https://dev.azure.com/o/_apis/wit/workItems/123'), 123);
  assert.strictEqual(Ado.idFromUrl('https://x/_apis/wit/workItems/123/revisions'), 123);
  for (const bad of ['', null, 'https://x/workitems/abc', 'https://x/workitems/0', 'https://x/workitems/99999999999', 'https://x/other/5']) { assert.strictEqual(Ado.idFromUrl(bad), null, String(bad)); }
  assert.strictEqual(Ado.pointsOf({ 'Microsoft.VSTS.Scheduling.StoryPoints': 3 }), 3);
  assert.strictEqual(Ado.pointsOf({ 'Microsoft.VSTS.Scheduling.Effort': 13 }), 13);
  assert.strictEqual(Ado.pointsOf({ 'Microsoft.VSTS.Scheduling.Size': 2, 'Microsoft.VSTS.Scheduling.StoryPoints': 0 }), 2);
  assert.strictEqual(Ado.pointsOf({ 'Microsoft.VSTS.Scheduling.StoryPoints': '5' }), null);
  assert.strictEqual(Ado.pointsOf({}), null);
});

(async () => {
  for (const [name, fn] of checks) {
    try { const r = await fn(); console.log('PASS ' + name + (r === undefined ? '' : ' -> ' + r)); } catch (e) { failed++; console.log('FAIL ' + name + ' -> ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e)); }
  }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nAzure DevOps client checks passed.');
  process.exit(failed ? 1 : 0);
})();
