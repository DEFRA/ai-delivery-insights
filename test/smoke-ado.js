'use strict';
// Loads extension.js against a mock of the VS Code API and a stand-in Azure DevOps to check the wiring of the Azure DevOps
// pages: nothing leaves the machine until the person turns it on; a token never reaches a page, a log, a message or a setting;
// pages cannot import, estimate or change where data goes; workspace settings cannot redirect it; and the whole flow works.
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { createMock } = require('./vscode-mock.js');
const { createStub } = require('./ado-stub.js');

const M = createMock();
const MS_TOKEN = 'ms-token-SECRET-1';
const PAT = 'pat-token-1';
const stub = createStub({ bearer: MS_TOKEN, pat: PAT });
let fetchCount = 0;
globalThis.fetch = (...a) => { fetchCount++; return stub.fetch(...a); };

const gs = (process.env.LENS_FIXTURE || '/tmp/lens-fixture') + '/Code/User/globalStorage/local.ai-delivery-insights'; fs.mkdirSync(gs, { recursive: true });
for (const f of fs.readdirSync(gs)) { if (f.startsWith('stories.json')) { fs.rmSync(path.join(gs, f), { force: true }); } }
const ext = require('../extension.js');
const ctx = M.makeContext(gs);
const ok = (msg, detail) => console.log('PASS', msg, detail === undefined ? '' : '-> ' + detail);
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));
const last = (a) => a[a.length - 1];
const waitFor = async (cond, what, ms) => { const end = Date.now() + (ms || 60000); while (Date.now() < end) { if (cond()) { return; } await tick(25); } throw new Error('timed out waiting for ' + what); };
const diskStore = () => JSON.parse(fs.readFileSync(path.join(gs, 'stories.json'), 'utf8'));
const storiesMsgs = (p) => p.posted.filter((m) => m.type === 'stories');
let ridCounter = 100;
async function ask(panel, op, extra) {
  const rid = ++ridCounter;
  const before = panel.posted.length;
  await panel.handler({ type: 'ado', rid, op, ...(extra || {}) });
  const reply = panel.posted.slice(before).find((m) => m.type === 'ado' && m.rid === rid);
  assert.ok(reply, `a reply to ${op}`);
  return reply;
}
const edit = async (panel, op) => { const rid = ++ridCounter; const n = storiesMsgs(panel).length; await panel.handler({ type: 'story', rid, op }); await tick(); return last(storiesMsgs(panel)).result; };
const requestsToOtherHosts = () => stub.requests.filter((r) => r.host !== 'https://dev.azure.com');

(async () => {
  /* ---------------- manifest ---------------- */
  const manifest = require('../package.json');
  const props = manifest.contributes.configuration.properties;
  const adoProps = Object.keys(props).filter((k) => k.startsWith('aiDeliveryInsights.ado.'));
  assert.deepStrictEqual(adoProps.sort(), ['aiDeliveryInsights.ado.authMethod', 'aiDeliveryInsights.ado.enabled', 'aiDeliveryInsights.ado.organization', 'aiDeliveryInsights.ado.project', 'aiDeliveryInsights.ado.shareName', 'aiDeliveryInsights.ado.storyTypes']);
  for (const k of adoProps) { assert.strictEqual(props[k].scope, 'application', k + ' is read from user settings only'); }
  assert.strictEqual(props['aiDeliveryInsights.ado.enabled'].default, false, 'off by default');
  assert.strictEqual(props['aiDeliveryInsights.ado.authMethod'].default, 'microsoft');
  assert.strictEqual(props['aiDeliveryInsights.ado.shareName'].default, false);
  assert.strictEqual(manifest.capabilities.untrustedWorkspaces.supported, 'limited');
  assert.ok(manifest.capabilities.untrustedWorkspaces.description.length > 20);
  for (const k of ['prodLinesPerDay', 'testLinesPerDay', 'hoursPerDay', 'overheadPercent', 'hoursPerPoint']) { assert.ok(props['aiDeliveryInsights.effort.' + k], k); }
  ok('manifest: Azure DevOps settings are user-level, off by default; untrusted workspaces are "limited"');

  ext.activate(ctx);
  const expected = ['aiDeliveryInsights.open', 'aiDeliveryInsights.rescan', 'aiDeliveryInsights.exportCsv', 'aiDeliveryInsights.diagnose', 'aiDeliveryInsights.openStories', 'aiDeliveryInsights.openStory', 'aiDeliveryInsights.exportStoryCsv', 'aiDeliveryInsights.exportTags', 'aiDeliveryInsights.importTags',
    'aiDeliveryInsights.adoConnect', 'aiDeliveryInsights.adoImport', 'aiDeliveryInsights.adoSetToken', 'aiDeliveryInsights.adoClearToken', 'aiDeliveryInsights.adoDisconnect'];
  assert.deepStrictEqual(Object.keys(M.handlers).sort(), expected.slice().sort());
  assert.deepStrictEqual(manifest.contributes.commands.map((c) => c.command).sort(), expected.slice().sort());
  ok('commands registered and declared', expected.length + ' commands');

  M.handlers['aiDeliveryInsights.open']();
  const main = M.panels[0];
  await main.handler({ type: 'ready' });
  await waitFor(() => main.posted.some((m) => m.type === 'data'), 'the first scan');
  const sessions = main.posted.find((m) => m.type === 'data').payload.sessions;
  const [s1, s2] = sessions.slice().sort((a, b) => b.prompts.length - a.prompts.length);

  /* ---------------- off by default: nothing leaves the machine ---------------- */
  assert.strictEqual(fetchCount, 0); assert.strictEqual(M.auth.calls.length, 0); assert.strictEqual(M.secretCalls.length, 0);
  const st0 = await ask(main, 'status');
  assert.deepStrictEqual([st0.ok, st0.enabled, st0.signedIn, st0.organization, st0.trusted], [true, false, false, '', true]);
  for (const op of ['test', 'backlog', 'import', 'refresh', 'syncPreview', 'syncApply']) {
    const r = await ask(main, op, { project: 'Shop', ids: [1], storyId: 'x', planId: 'y' });
    assert.ok(r.ok === false && /turned off/.test(r.error), op + ': ' + JSON.stringify(r));
  }
  const openedBefore = M.opened.length;
  assert.strictEqual((await ask(main, 'open', { storyId: 'x' })).ok, false, 'there is nothing to open while it is off');
  assert.strictEqual(M.opened.length, openedBefore, 'and no address was opened');
  assert.strictEqual(fetchCount, 0, 'no web request while Azure DevOps is off');
  assert.strictEqual(M.auth.calls.length, 0, 'the sign-in provider is not even asked');
  assert.strictEqual(M.secretCalls.length, 0, 'secret storage is not touched');
  ok('while Azure DevOps is off: every request is refused; no web request, no sign-in call, no secret read');

  /* ---------------- the page cannot reach the extension-only operations ---------------- */
  const keep = fs.existsSync(path.join(gs, 'stories.json')) ? JSON.stringify(diskStore()) : null;
  let r = await edit(main, { type: 'adoImport', items: [{ id: 9, title: 'x' }] }); assert.strictEqual(r.ok, false);
  r = await edit(main, { type: 'setEffortEstimate', storyId: 'x', effort: { hours: 5 } }); assert.strictEqual(r.ok, false);
  r = await edit(main, { type: 'adoRecord', storyId: 'x', link: { taskId: 5 } }); assert.strictEqual(r.ok, false);
  assert.strictEqual(fs.existsSync(path.join(gs, 'stories.json')) ? JSON.stringify(diskStore()) : null, keep, 'nothing changed');
  const before = M.executed.length;
  await main.handler({ type: 'command', name: 'workbench.action.quit' }); await main.handler({ type: 'command', name: 'adoImport' });
  assert.strictEqual(M.executed.length, before, 'only the listed commands can be requested');
  for (const name of ['adoConnect', 'adoSetToken', 'adoClearToken', 'adoDisconnect']) { await main.handler({ type: 'command', name }); assert.deepStrictEqual(last(M.executed), ['aiDeliveryInsights.' + name]); }
  const bad = [null, 'x', 5, { type: 'ado' }, { type: 'ado', op: 'nope' }, { type: 'ado', op: { toString: () => 'status' } }];
  for (const msg of bad) { try { await main.handler(msg); } catch (e) { assert.fail('a malformed message threw: ' + e.message); } }
  assert.strictEqual((await ask(main, 'nope')).ok, false);
  ok('pages cannot import, set an estimate or record a link; only the listed commands can be requested; malformed messages are ignored');

  /* ---------------- connect wizard: the ways out ---------------- */
  const setPick = () => { M.dialogs.pickChoice = (items) => (items[0] && items[0].method ? items.find((i) => i.method === M.dialogs.method) : items.find((i) => i.label === 'Shop')); };
  setPick(); M.dialogs.method = 'microsoft';
  M.dialogs.input = [undefined]; await M.handlers['aiDeliveryInsights.adoConnect']();
  assert.deepStrictEqual(M.updates, [], 'cancelling the first box changes nothing');
  const validate = M.dialogs.inputCalls[0].validateInput;
  for (const badOrg of ['evil.com/x', 'a b', '', 'http://dev.azure.com/x', 'x'.repeat(60), 'a@b']) { assert.ok(validate(badOrg), badOrg); }
  for (const goodOrg of ['contoso', 'https://dev.azure.com/contoso', 'https://contoso.visualstudio.com']) { assert.strictEqual(validate(goodOrg), null, goodOrg); }
  M.dialogs.input = ['contoso']; M.dialogs.infoChoice = undefined;
  await M.handlers['aiDeliveryInsights.adoConnect']();
  assert.deepStrictEqual(M.updates, [], 'declining "Turn on" changes nothing');
  assert.strictEqual(M.auth.calls.length, 0, 'and asks the sign-in provider nothing');
  assert.strictEqual(fetchCount, 0);
  const consent = last(M.dialogs.infoCalls);
  assert.match(consent[0], /https:\/\/dev\.azure\.com\/contoso/); assert.match(consent[0], /never sends prompts, responses, session titles, file names or paths/); assert.deepStrictEqual([consent[1], consent[2]], [{ modal: true }, 'Turn on']);
  ok('connect wizard: cancel and "do not turn on" change nothing; the consent says exactly what is sent');

  /* ---------------- connect with a Microsoft sign-in ---------------- */
  stub.addStory(7001, 'Login', { 'Microsoft.VSTS.Scheduling.StoryPoints': 5 }); stub.addStory(7002, 'Reports', { 'Microsoft.VSTS.Scheduling.StoryPoints': 3 });
  M.auth.session = { accessToken: MS_TOKEN };
  M.dialogs.input = ['https://dev.azure.com/contoso/']; M.dialogs.infoChoice = 'Turn on';
  const posted0 = main.posted.length;
  await M.handlers['aiDeliveryInsights.adoConnect']();
  assert.deepStrictEqual(M.updates.map((u) => [u.k, u.v, u.target]), [['ado.organization', 'contoso', 1], ['ado.authMethod', 'microsoft', 1], ['ado.enabled', true, 1], ['ado.project', 'Shop', 1]], 'saved to the user settings, in this order, project last');
  assert.ok(M.auth.calls.some((c) => c.opts && c.opts.createIfNone === true && c.provider === 'microsoft' && c.scopes[0].endsWith('/.default')), 'the sign-in was requested from the Microsoft provider');
  const probe = stub.requests[0];
  assert.deepStrictEqual([probe.method, probe.host, probe.path, probe.headers.Authorization], ['GET', 'https://dev.azure.com', '/contoso/_apis/projects', 'Bearer ' + MS_TOKEN]);
  assert.ok(main.posted.slice(posted0).some((m) => m.type === 'adoChanged'), 'open pages are told to refresh');
  assert.match(last(M.msgs.info), /Connected to contoso as Test Person/);
  const st1 = await ask(main, 'status');
  assert.deepStrictEqual([st1.enabled, st1.signedIn, st1.organization, st1.project, st1.authMethod, st1.user], [true, true, 'contoso', 'Shop', 'microsoft', { name: 'Test Person' }]);
  assert.ok(!('token' in st1) && !('accessToken' in st1));
  ok('connect with Microsoft: settings saved at user level, sign-in asked of the Microsoft provider, connection tested, status shown without any token');

  /* ---------------- a workspace cannot redirect or switch anything ---------------- */
  M.workspaceSettings['ado.organization'] = 'evil.com/steal'; M.workspaceSettings['ado.authMethod'] = 'pat'; M.workspaceSettings['ado.enabled'] = false; M.workspaceSettings['ado.storyTypes'] = ["x') OR 1=1 --"];
  const stW = await ask(main, 'status');
  assert.deepStrictEqual([stW.enabled, stW.organization, stW.authMethod], [true, 'contoso', 'microsoft'], 'workspace values are ignored');
  stub.reset(); const t = await ask(main, 'test');
  assert.ok(t.ok); assert.ok(stub.requests.every((q) => q.url.startsWith('https://dev.azure.com/contoso/')));
  for (const k of Object.keys(M.workspaceSettings)) { delete M.workspaceSettings[k]; }
  ok('settings in a workspace (.vscode/settings.json) cannot change the organisation, the sign-in, the switch or the story types');

  /* ---------------- the other settings that choose where data is read from, or how it is worked out ---------------- */
  const extraRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-extra-'));
  const extraUser = path.join(extraRoot, 'Code', 'User'); fs.mkdirSync(path.join(extraUser, 'workspaceStorage'), { recursive: true });
  const dataMsgs = () => main.posted.filter((m) => m.type === 'data');
  const rescan = async () => { const n = dataMsgs().length; await main.handler({ type: 'rescan' }); await waitFor(() => dataMsgs().length > n, 'a rescan'); return last(dataMsgs()).payload; };
  M.workspaceSettings.extraDataDirs = [extraUser]; M.workspaceSettings['effort.hoursPerDay'] = 1; M.workspaceSettings['effort.overheadPercent'] = 900; M.workspaceSettings['effort.prodLinesPerDay'] = 1;
  const viaWorkspace = await rescan();
  assert.ok(!viaWorkspace.sources.some((x) => x.dir === extraUser), 'a folder named by a repository\'s settings is not read');
  const stE = await ask(main, 'status');
  assert.deepStrictEqual([stE.effort.hoursPerDay, stE.effort.overheadPercent, stE.effort.prodLinesPerDay], [8, 25, 150], 'effort rates from a repository\'s settings are ignored');
  M.globalSettings.extraDataDirs = [extraUser]; M.globalSettings['effort.hoursPerDay'] = 6;
  const viaUser = await rescan();
  assert.ok(viaUser.sources.some((x) => x.dir === extraUser), 'the person\'s own setting is honoured');
  assert.strictEqual((await ask(main, 'status')).effort.hoursPerDay, 6);
  for (const k of ['extraDataDirs', 'effort.hoursPerDay', 'effort.overheadPercent', 'effort.prodLinesPerDay']) { delete M.workspaceSettings[k]; delete M.globalSettings[k]; }
  await rescan();
  fs.rmSync(extraRoot, { recursive: true, force: true });
  ok('extra data folders and effort rates are read from the person\'s own settings only');

  /* ---------------- import from the backlog ---------------- */
  await M.handlers['aiDeliveryInsights.open'](); // reuses the main tab
  await main.handler({ type: 'newTab', route: { name: 'stories' } });
  const other = M.panels[1]; await other.handler({ type: 'ready' }); await tick();
  const list = await ask(main, 'backlog', { project: 'Shop' });
  assert.deepStrictEqual(list.items.map((i) => [i.id, i.title, i.points, i.imported]).sort((a, b) => a[0] - b[0]), [[7001, 'Login', 5, false], [7002, 'Reports', 3, false]]);
  const nOther = storiesMsgs(other).length;
  const imp = await ask(main, 'import', { ids: [7001, 7002, 31337] });
  assert.ok(imp.ok, imp.error); assert.match(imp.message, /Imported 2 stories/);
  assert.strictEqual(storiesMsgs(other).length, nOther + 1, 'every tab hears about the import');
  const ds = diskStore();
  assert.deepStrictEqual(ds.stories.map((x) => [x.id, x.adoId]).sort(), [['7001', 7001], ['7002', 7002]]);
  assert.strictEqual(ds.ado['7001'].project, 'Shop');
  ok('backlog import through the page: only listed stories, saved, and every tab updated');

  /* ---------------- sync ---------------- */
  assert.strictEqual((await edit(main, { type: 'tagSessions', ids: [s1.id, s2.id], storyId: '7001' })).ok, true);
  const prev = await ask(main, 'syncPreview', { storyId: '7001' });
  assert.ok(prev.ok, prev.error);
  assert.strictEqual(prev.changes.added, 2);
  assert.strictEqual(stub.count('POST', 'workitems/$Task'), 0, 'previewing created nothing');
  assert.strictEqual(M.panels.indexOf(other), 1);
  assert.ok(!other.posted.some((m) => m.type === 'ado' && m.planId), 'the preview went only to the tab that asked');
  const nStories = storiesMsgs(main).length;
  // The extension asks for itself, in a window of its own, before it writes to a target it has not written to before.
  M.dialogs.warnChoice = undefined; M.dialogs.warnCalls.length = 0;
  const declined = await ask(main, 'syncApply', { storyId: '7001', planId: prev.planId });
  assert.ok(!declined.ok && declined.cancelled && /Nothing was written/.test(declined.error), JSON.stringify(declined));
  assert.strictEqual(stub.count('POST', 'workitems/$Task'), 0, 'closing the window wrote nothing');
  assert.strictEqual(M.dialogs.warnCalls.length, 1);
  const win = M.dialogs.warnCalls[0];
  assert.strictEqual(win.options && win.options.modal, true, 'a window the page cannot click through');
  assert.deepStrictEqual(win.buttons, ['Write to Azure DevOps']);
  assert.ok(/Organisation: contoso/.test(win.options.detail) && /Work item #7001: Login/.test(win.options.detail) && /create one new Task/.test(win.options.detail), win.options.detail);
  assert.ok(!/SECRET|prompt text:/.test(win.options.detail));
  M.dialogs.warnChoice = 'first';
  const done = await ask(main, 'syncApply', { storyId: '7001', planId: prev.planId, html: '<script>x</script>', description: 'nope' });
  assert.ok(done.ok && done.created, done.error);
  assert.ok(storiesMsgs(main).length > nStories, 'the new sync state is pushed to the pages');
  assert.strictEqual(last(storiesMsgs(main)).store.ado['7001'].taskId, done.taskId);
  const task = stub.items.get(done.taskId);
  const desc = task.fields['System.Description'];
  assert.match(desc, /"contributor_id": "inst-[0-9a-f]{20}"/);
  assert.strictEqual(M.state.get('aiDeliveryInsights.installId'), /"contributor_id": "([^"]+)"/.exec(desc)[1], 'the contributor is this installation\'s random ID');
  const rawTexts = sessions.flatMap((s) => [s.title, s.file, ...s.prompts.slice(0, 3).map((p) => p.text)]).filter((x) => x && x.length > 8);
  assert.ok(rawTexts.length > 3);
  for (const t2 of rawTexts) { assert.ok(!desc.includes(t2.slice(0, 30)), 'private text found in what was sent: ' + t2.slice(0, 30)); }
  assert.ok(!/<script/.test(desc.replace(/<\/?(div|b|table|tr|td|br|pre)[^>]*>/g, '')));
  assert.strictEqual(requestsToOtherHosts().length, 0, 'every request went to dev.azure.com');
  assert.ok(stub.requests.every((q) => q.redirect === 'manual' && /^Bearer /.test(q.headers.Authorization)));
  ok('sync through the page: confirmed by plan ID only, one Task created, no private text sent, state pushed to pages');

  /* ---------------- effort through the page (fixture repositories are not real git repositories) ---------------- */
  const fe = await ask(main, 'effortFind', { storyId: '7001' });
  assert.ok(fe.ok, fe.error);
  assert.deepStrictEqual(fe.commits, []);
  assert.strictEqual(fe.estimate.ok, false);
  assert.ok((await ask(main, 'effortCompute', { storyId: '7001', cacheId: 'nope', selected: [] })).ok === false);
  assert.ok((await ask(main, 'effortSave', { storyId: '7002', cacheId: fe.cacheId, selected: [] })).ok === false, 'a list belongs to the story it was made for');
  ok('effort through the page: no commits is reported, not guessed; the commit list belongs to one story');

  /* ---------------- opening in the browser ---------------- */
  await ask(main, 'open', { storyId: '7001', url: 'https://evil.example/' });
  assert.deepStrictEqual(M.opened, ['https://dev.azure.com/contoso/_workitems/edit/7001'], 'the page cannot choose the address');
  await ask(main, 'open', { storyId: '7001', kind: 'task' });
  assert.strictEqual(last(M.opened), `https://dev.azure.com/contoso/_workitems/edit/${done.taskId}`);
  const none = await ask(main, 'open', { storyId: 'nope' });
  assert.strictEqual(none.ok, false); assert.strictEqual(M.opened.length, 2);
  ok('opening a work item: the address is built by the extension');

  /* ---------------- personal access token fallback ---------------- */
  // closing the confirmation window changes nothing
  M.dialogs.warnChoice = undefined; M.dialogs.warnCalls.length = 0;
  const sc0 = M.secretCalls.length;
  await M.handlers['aiDeliveryInsights.adoDisconnect']();
  assert.strictEqual(M.globalSettings['ado.enabled'], true, 'still on');
  assert.strictEqual(M.secretCalls.length, sc0, 'no secret was touched');
  assert.strictEqual(M.dialogs.warnCalls.length, 1); assert.strictEqual(M.dialogs.warnCalls[0].options.modal, true);
  assert.deepStrictEqual(M.dialogs.warnCalls[0].buttons, ['Turn off and remove the token']);
  M.dialogs.warnChoice = 'first';
  await M.handlers['aiDeliveryInsights.adoDisconnect']();
  assert.strictEqual(M.globalSettings['ado.enabled'], false);
  assert.deepStrictEqual(last(M.secretCalls), ['delete', 'aiDeliveryInsights.ado.pat']);
  const fc0 = fetchCount;
  assert.match((await ask(main, 'test')).error, /turned off/);
  assert.strictEqual(fetchCount, fc0, 'disconnected: no request');
  assert.match(last(M.msgs.info), /turned off and the stored token was removed/);

  M.dialogs.method = 'pat'; M.dialogs.input = ['contoso', 'has space', PAT]; M.dialogs.infoChoice = 'Turn on';
  M.auth.calls.length = 0; stub.reset(); M.updates.length = 0;
  await M.handlers['aiDeliveryInsights.adoConnect']();
  // the second input box (the token) refused a token with a space, which cancelled the wizard: nothing was turned on
  assert.ok(/no spaces/.test(M.dialogs.lastInvalid), 'a token with spaces is refused');
  assert.deepStrictEqual(M.updates, []);
  M.dialogs.input = ['contoso', PAT]; M.dialogs.infoChoice = 'Turn on';
  await M.handlers['aiDeliveryInsights.adoConnect']();
  assert.strictEqual(M.secrets.get('aiDeliveryInsights.ado.pat'), PAT, 'the token is in secret storage');
  const tokenBox = M.dialogs.inputCalls.filter((c) => c.password === true);
  assert.ok(tokenBox.length >= 2 && tokenBox.every((c) => c.ignoreFocusOut === true), 'a password box that survives losing focus');
  for (const v of ['', '   ', 'a b', 'x'.repeat(5000)]) { assert.ok(last(tokenBox).validateInput(v), JSON.stringify(v).slice(0, 20)); }
  assert.strictEqual(last(tokenBox).validateInput(PAT), null);
  assert.strictEqual(M.auth.calls.length, 0, 'the Microsoft sign-in was not used');
  assert.strictEqual(stub.requests[0].headers.Authorization, 'Basic ' + Buffer.from(':' + PAT).toString('base64'));
  assert.deepStrictEqual(M.updates.map((u) => [u.k, u.v]).slice(0, 3), [['ado.organization', 'contoso'], ['ado.authMethod', 'pat'], ['ado.enabled', true]]);
  const stP = await ask(main, 'status');
  assert.deepStrictEqual([stP.authMethod, stP.signedIn], ['pat', true]);
  M.dialogs.warnChoice = undefined; M.dialogs.warnCalls.length = 0;
  await M.handlers['aiDeliveryInsights.adoClearToken']();
  assert.strictEqual(M.secrets.get('aiDeliveryInsights.ado.pat'), PAT, 'closing the window keeps the token');
  assert.strictEqual(M.dialogs.warnCalls[0].options.modal, true); assert.deepStrictEqual(M.dialogs.warnCalls[0].buttons, ['Remove the token']);
  M.dialogs.warnChoice = 'first';
  await M.handlers['aiDeliveryInsights.adoClearToken']();
  assert.strictEqual(M.secrets.has('aiDeliveryInsights.ado.pat'), false);
  const fc1 = fetchCount;
  const noTok = await ask(main, 'test');
  assert.ok(!noTok.ok && /No personal access token is stored/.test(noTok.error));
  assert.strictEqual(fetchCount, fc1, 'with no token no request is made');
  assert.strictEqual((await ask(main, 'status')).signedIn, false);
  await M.handlers['aiDeliveryInsights.adoSetToken'](); // input queue is empty: cancelled
  assert.strictEqual(M.secrets.has('aiDeliveryInsights.ado.pat'), false, 'cancelling stores nothing');
  M.dialogs.input = [PAT]; await M.handlers['aiDeliveryInsights.adoSetToken']();
  assert.strictEqual(M.secrets.get('aiDeliveryInsights.ado.pat'), PAT);
  assert.ok((await ask(main, 'test')).ok);
  ok('token fallback: stored only in secret storage, sent as Basic, validated, removable, and no request without one');

  /* ---------------- a token that cannot list projects ---------------- */
  stub.opts.projectListStatus = 401;
  M.globalSettings['ado.project'] = ''; M.dialogs.method = 'pat'; M.dialogs.infoChoice = 'Turn on'; M.updates.length = 0; M.msgs.info.length = 0; M.msgs.error.length = 0; M.dialogs.inputCalls.length = 0;
  M.dialogs.input = ['contoso', PAT, 'Shop'];
  await M.handlers['aiDeliveryInsights.adoConnect']();
  const projBox = M.dialogs.inputCalls.find((c) => /Which project/.test(c.title || ''));
  assert.ok(projBox, 'the wizard asks for the project by name when the list is refused');
  assert.ok(projBox.validateInput('x/y') && projBox.validateInput('') && projBox.validateInput('..') && projBox.validateInput(' Shop ') === null, 'only a valid project name is accepted');
  assert.strictEqual(M.globalSettings['ado.project'], 'Shop');
  assert.match(last(M.msgs.info), /cannot list projects/); assert.deepStrictEqual(M.msgs.error, []);
  assert.strictEqual((await ask(main, 'status')).project, 'Shop');
  // if the project name is not given, the person is told what failed and nothing is pretended
  M.globalSettings['ado.project'] = ''; M.msgs.error.length = 0; M.dialogs.input = ['contoso', PAT, undefined];
  await M.handlers['aiDeliveryInsights.adoConnect']();
  assert.match(last(M.msgs.error), /test failed/); assert.match(last(M.msgs.error), /Project and Team: Read/);
  stub.opts.projectListStatus = 0; M.globalSettings['ado.project'] = 'Shop';
  ok('a token without "Project and Team: Read": the wizard asks for the project name instead of failing, and says what is missing if it is not given');

  /* ---------------- Restricted Mode ---------------- */
  M.trusted = false;
  const fc2 = fetchCount;
  for (const op of ['test', 'backlog', 'syncPreview', 'effortFind']) { const rr = await ask(main, op, { project: 'Shop', storyId: '7001' }); assert.ok(!rr.ok && /Restricted Mode/.test(rr.error), op); }
  assert.strictEqual((await ask(main, 'status')).trusted, false);
  const upd = M.updates.length;
  await M.handlers['aiDeliveryInsights.adoConnect']();
  assert.strictEqual(M.updates.length, upd); assert.match(last(M.msgs.warn), /Restricted Mode/);
  assert.strictEqual(fetchCount, fc2, 'untrusted: no request');
  const op0 = M.opened.length;
  assert.strictEqual((await ask(main, 'open', { storyId: '7001' })).ok, false); assert.strictEqual((await ask(main, 'open', { storyId: '7001', kind: 'task' })).ok, false);
  assert.strictEqual(M.opened.length, op0, 'untrusted: nothing is opened either');
  M.trusted = true;
  ok('Restricted Mode: Azure DevOps and git reading are refused, and the wizard will not run');

  /* ---------------- no token anywhere it should not be ---------------- */
  const everywhere = JSON.stringify([M.panels.map((p) => p.posted), M.msgs, M.outputLines, [...M.state], M.globalSettings, M.updates, M.dialogs.infoCalls, M.executed]);
  for (const secret of [MS_TOKEN, PAT, Buffer.from(':' + PAT).toString('base64')]) { assert.ok(!everywhere.includes(secret), 'a token leaked: ' + secret.slice(0, 8)); }
  assert.ok(M.outputLines.some((l) => /^\[azure devops\] (GET|POST|PATCH) \/contoso\//.test(l)), 'requests are logged as method, path and status only');
  assert.ok(M.outputLines.every((l) => !/authorization|bearer|basic /i.test(l)));
  assert.strictEqual(requestsToOtherHosts().length, 0);
  assert.ok(stub.requests.every((q) => !['DELETE', 'PUT'].includes(q.method)));
  ok('no token appears in any page message, notification, log line, state or setting');

  console.log('\nAzure DevOps wiring checks passed.');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
