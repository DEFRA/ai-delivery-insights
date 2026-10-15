// Loads extension.js against a minimal mock of the vscode API to catch wiring mistakes.
// Covers: commands, the webview shell (CSP), the page-to-extension message rules, story edits and
// persistence, new tabs, budget warnings, backup and restore, and CSV export per story.
// Every check asserts: a failure exits non-zero.
const Module = require('module'); const path = require('path'); const fs = require('fs'); const os = require('os');
const assert = require('assert');

const windowStateHandlers = []; const folderHandlers = []; const statusItems = []; const handlers = {}; const executed = []; const panels = []; const state = new Map();
const msgs = { info: [], warn: [], error: [] };
const dialogs = { save: null, open: null, pick: null, warnChoice: undefined, saveCalls: [], pickCalls: [] };
const settings = { monthlyAllowanceCredits: 1000, showStatusBar: true, extraDataDirs: [], pricing: {}, notifyOnBudget: true };

// emulate <User>/globalStorage/<ext> so that "two levels up" is the fixture User dir
const gs = (process.env.LENS_FIXTURE || '/tmp/lens-fixture') + '/Code/User/globalStorage/local.ai-delivery-insights'; fs.mkdirSync(gs, { recursive: true });
for (const f of fs.readdirSync(gs)) { if (f.startsWith('stories.json')) { fs.rmSync(path.join(gs, f), { force: true }); } }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-smoke-'));

const Uri = { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }), joinPath: (b, ...p) => Uri.file(path.join(b.fsPath, ...p)) };
const vscode = {
  Uri, ViewColumn: { Active: 1 }, StatusBarAlignment: { Right: 2 },
  MarkdownString: class { constructor(v) { this.value = v; } },
  workspace: { getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }), workspaceFolders: [], workspaceFile: undefined, onDidChangeConfiguration: () => ({ dispose() {} }), onDidChangeWorkspaceFolders: (fn) => { folderHandlers.push(fn); return { dispose() {} }; } },
  commands: { registerCommand: (id, fn) => { handlers[id] = fn; return { dispose() {} }; }, executeCommand: async (...a) => { executed.push(a); } },
  window: {
    state: { focused: true },
    onDidChangeWindowState: (fn) => { windowStateHandlers.push(fn); return { dispose() {} }; },
    createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => { const it = { show() { this.shown = true; }, hide() {}, dispose() {} }; statusItems.push(it); return it; },
    createWebviewPanel: () => {
      const p = {
        html: '', posted: [], handler: null, reveals: 0, disposeFn: null, iconPath: null,
        reveal() { this.reveals++; }, onDidDispose(fn) { this.disposeFn = fn; }, onDidChangeViewState(fn) { this.viewStateFn = fn; },
        webview: {
          cspSource: 'vscode-resource:', asWebviewUri: (u) => 'vscode-resource://' + u.fsPath,
          set html(v) { p.html = v; }, get html() { return p.html; },
          postMessage: (m) => { p.posted.push(JSON.parse(JSON.stringify(m))); return Promise.resolve(true); },
          onDidReceiveMessage: (fn) => { p.handler = fn; },
        },
      };
      panels.push(p); return p;
    },
    showErrorMessage: (m) => { msgs.error.push(m); return Promise.resolve(undefined); },
    showInformationMessage: (m) => { msgs.info.push(m); return Promise.resolve(undefined); },
    showWarningMessage: (m, ...rest) => { msgs.warn.push(m); return Promise.resolve(rest.some((x) => x === 'Replace') ? dialogs.warnChoice : dialogs.warnChoice); },
    setStatusBarMessage() {},
    showSaveDialog: async (o) => { dialogs.saveCalls.push(o); return dialogs.save ? Uri.file(dialogs.save) : null; },
    showOpenDialog: async () => (dialogs.open ? [Uri.file(dialogs.open)] : undefined),
    showQuickPick: async (items, o) => { dialogs.pickCalls.push({ items, o }); return dialogs.pick ? dialogs.pick(items) : undefined; },
  },
};
const orig = Module._load; Module._load = function (req, ...a) { return req === 'vscode' ? vscode : orig.call(this, req, ...a); };
const ext = require('../extension.js');
const mkctx = (dir) => ({ subscriptions: [], globalStorageUri: Uri.file(dir), extensionUri: Uri.file(path.resolve(__dirname, '..')), globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => { state.set(k, v); } } });
const ctx = mkctx(gs);
const ok = (msg, detail) => console.log('PASS', msg, detail === undefined ? '' : '-> ' + detail);
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));
const last = (arr) => arr[arr.length - 1];
// Wait for something asynchronous (a scan) by polling, not by guessing how long a cold scan takes on a slow machine.
const waitFor = async (cond, what, ms) => { const end = Date.now() + (ms || 60000); while (Date.now() < end) { if (cond()) { return; } await tick(25); } throw new Error('timed out waiting for ' + what); };
const storiesMsgs = (p) => p.posted.filter((m) => m.type === 'stories');
const has = (store, id) => store.stories.some((x) => x.id === id);
const diskStore = () => JSON.parse(fs.readFileSync(path.join(gs, 'stories.json'), 'utf8'));

(async () => {
  ext.activate(ctx);

  /* ---------------- commands ---------------- */
  const expected = ['aiDeliveryInsights.open', 'aiDeliveryInsights.rescan', 'aiDeliveryInsights.exportCsv', 'aiDeliveryInsights.diagnose', 'aiDeliveryInsights.openStories', 'aiDeliveryInsights.openStory', 'aiDeliveryInsights.exportStoryCsv', 'aiDeliveryInsights.exportTags', 'aiDeliveryInsights.importTags',
    'aiDeliveryInsights.adoConnect', 'aiDeliveryInsights.adoImport', 'aiDeliveryInsights.adoSetToken', 'aiDeliveryInsights.adoClearToken', 'aiDeliveryInsights.adoDisconnect'];
  assert.deepStrictEqual(Object.keys(handlers).sort(), expected.slice().sort(), 'registered commands');
  ok('commands registered', expected.length + ' commands');
  const manifest = require('../package.json');
  assert.deepStrictEqual(manifest.contributes.commands.map((c) => c.command).sort(), expected.slice().sort(), 'package.json commands match registered commands');
  assert.ok(Object.keys(manifest.contributes.configuration.properties).includes('aiDeliveryInsights.notifyOnBudget'), 'the budget setting is declared');
  assert.strictEqual(manifest.contributes.configuration.properties['aiDeliveryInsights.notifyOnBudget'].default, true);
  ok('manifest commands and settings match what the code reads');

  /* ---------------- webview shell ---------------- */
  handlers['aiDeliveryInsights.open']();
  assert.strictEqual(panels.length, 1);
  const main = panels[0];
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(main.html);
  assert.ok(csp, 'CSP meta tag present');
  assert.ok(/default-src 'none'/.test(csp[1]), "CSP starts from default-src 'none'");
  assert.ok(/base-uri 'none'/.test(csp[1]), 'a page cannot change where its relative addresses point');
  assert.ok(/form-action 'none'/.test(csp[1]), 'a page cannot submit a form anywhere');
  const scriptSrc = /script-src ([^;]+)/.exec(csp[1])[1];
  assert.ok(!/unsafe-inline|unsafe-eval|\*|https?:/.test(scriptSrc), 'scripts: only the nonce, no unsafe-inline, unsafe-eval, wildcard or remote host: ' + scriptSrc);
  assert.ok(!/\*|https?:/.test(csp[1]), 'no wildcard or remote host anywhere in the policy');
  assert.ok(!/connect-src|frame-src|object-src/.test(csp[1]) && /default-src 'none'/.test(csp[1]), 'everything not listed is blocked, including network connections from the page');
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp[1]);
  assert.ok(nonce, 'CSP has a script nonce');
  const scripts = [...main.html.matchAll(/<script nonce="([^"]+)" src="([^"]+)"><\/script>/g)];
  assert.strictEqual(scripts.length, 2, 'two scripts');
  assert.ok(scripts.every((s) => s[1] === nonce[1]), 'both script tags carry the nonce');
  assert.ok(/story-core\.js$/.test(scripts[0][2]) && /dashboard\.js$/.test(scripts[1][2]), 'shared logic loads before the dashboard');
  assert.strictEqual((main.html.match(/<script/g) || []).length, 2, 'no other script tags');
  assert.ok(!/\son[a-z]+=/i.test(main.html), 'no inline event handlers');
  assert.ok(!/https?:\/\//.test(main.html.replace(/<html[^>]*>/, '')), 'no remote URLs in the page shell');
  assert.ok(/role="status"/.test(main.html), 'live region present');
  ok('webview shell: CSP, nonce on both scripts in the right order, no inline handlers, no remote URLs');

  /* ---------------- scan ---------------- */
  await main.handler({ type: 'ready' });
  await waitFor(() => main.posted.some((m) => m.type === 'data'), 'the first scan');
  const data = main.posted.find((m) => m.type === 'data');
  assert.ok(data && data.payload.sessions.length > 0, 'scan produced sessions');
  assert.strictEqual(data.allowance, 1000, 'allowance passed to the view');
  assert.ok(storiesMsgs(main).length >= 1 && storiesMsgs(main)[0].store.stories.length === 0, 'an empty story list is sent to a new tab');
  ok('scan posted data and an empty story list', data.payload.sessions.length + ' sessions');
  assert.ok(fs.existsSync(path.join(gs, 'scan-cache.json')), 'cache file written');
  ok('cache file written');
  const sessions = data.payload.sessions;
  const credits = (s) => s.prompts.reduce((a, p) => a + p.credits, 0) + (s.overhead ? s.overhead.credits : 0);
  const [big, second] = sessions.slice().sort((a, b) => credits(b) - credits(a));
  assert.ok(credits(big) > 5 && credits(second) > 1, 'fixture has sessions big enough to cross a small budget');

  /* ---------------- untrusted messages ---------------- */
  const before = executed.length;
  await main.handler({ type: 'openFolder', path: '/etc' }); // not a known workspace
  await main.handler({ type: 'reveal', path: '/etc/passwd' }); // not a scanned file
  await main.handler({ type: 'no-such-message' });
  await main.handler(null); await main.handler('string'); await main.handler({ type: 'command', name: 'workbench.action.quit' });
  assert.strictEqual(executed.length, before, 'untrusted webview messages triggered no commands');
  ok('untrusted webview messages ignored');
  await main.handler({ type: 'command', name: 'exportTags' });
  assert.deepStrictEqual(last(executed), ['aiDeliveryInsights.exportTags'], 'the two backup commands are allowed');
  await main.handler({ type: 'command', name: 'importTags' });
  assert.deepStrictEqual(last(executed), ['aiDeliveryInsights.importTags']);
  ok('only the backup commands can be requested by the page');

  /* ---------------- story edits ---------------- */
  const edit = async (op, rid) => { const n = storiesMsgs(main).length; await main.handler({ type: 'story', rid, op }); await tick(); const all = storiesMsgs(main); assert.strictEqual(all.length, n + 1, 'one reply per request'); return last(all); };
  let r = await edit({ type: 'saveStory', mode: 'new', story: { id: 'S1', title: 'First story', budget: 1, points: 3, group: 'G' } }, 41);
  assert.strictEqual(r.result.rid, 41); assert.strictEqual(r.result.ok, true); assert.ok(has(r.store, 'S1'));
  assert.deepStrictEqual(diskStore().stories.map((s) => s.id), ['S1'], 'saved to disk');
  assert.deepStrictEqual(fs.readdirSync(gs).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left behind');
  ok('creating a story: reply carries the request id and the file is saved atomically');

  // the page may set lifecycle phases (it is a normal edit, not an import)
  const k0 = big.prompts[0].ts ? String(big.prompts[0].ts) : '#' + big.prompts[0].i;
  r = await edit({ type: 'tagPhase', sessionId: big.id, keys: [k0], phase: 'plan' }, 80);
  assert.strictEqual(r.result.ok, true, r.result.error); assert.strictEqual(r.store.phaseTags[big.id][k0], 'plan');
  assert.strictEqual(diskStore().phaseTags[big.id][k0], 'plan', 'saved to disk');
  r = await edit({ type: 'tagPhase', sessionId: big.id, keys: [k0], phase: 'not-a-phase' }, 81);
  assert.strictEqual(r.result.ok, false); assert.strictEqual(diskStore().phaseTags[big.id][k0], 'plan', 'a bad phase changed nothing');
  r = await edit({ type: 'tagPhase', sessionId: big.id, keys: [k0], phase: 'auto' }, 82);
  assert.strictEqual(r.result.ok, true); assert.ok(!diskStore().phaseTags || !diskStore().phaseTags[big.id], 'back to automatic');
  ok('lifecycle phase edits from the page are saved, validated and can be cleared');

  r = await edit({ type: 'tagSessions', ids: [big.id], storyId: 'S1' }, 42);
  assert.strictEqual(r.result.ok, true); assert.strictEqual(r.store.sessionTags[big.id], 'S1');
  assert.strictEqual(diskStore().sessionTags[big.id], 'S1');
  ok('tagging a session persists it');

  // The import operation must never be accepted from the page: it can replace all the person's data.
  const keepStories = JSON.stringify(diskStore());
  r = await edit({ type: 'import', mode: 'replace', data: { kind: 'copilot-lens-story-tags', version: 1, stories: [], sessionTags: {}, promptTags: {} } }, 43);
  assert.strictEqual(r.result.ok, false); assert.strictEqual(r.result.rid, 43);
  assert.strictEqual(JSON.stringify(diskStore()), keepStories, 'nothing changed on disk');
  r = await edit({ type: 'saveStory', mode: 'new', story: { id: '__proto__', title: 'x' } }, 44);
  assert.strictEqual(r.result.ok, false); assert.strictEqual({}.title, undefined);
  r = await edit({ type: 'tagSessions', ids: ['not-a-real-session'], storyId: 'S1' }, 'not-a-number');
  assert.strictEqual(r.result.rid, 0, 'a non-numeric request id is replaced by 0');
  r = await edit('not an object', 45); assert.strictEqual(r.result.ok, false);
  ok('the page cannot import, use unsafe IDs or tag sessions that do not exist');

  /* ---------------- budget warnings ---------------- */
  assert.strictEqual(msgs.warn.filter((m) => /Story S1/.test(m)).length, 1, 'one warning when S1 went over its budget');
  assert.ok(/over its budget of 1/.test(last(msgs.warn)), last(msgs.warn));
  await edit({ type: 'tagSessions', ids: [second.id], storyId: 'S1' }, 46);
  assert.strictEqual(msgs.warn.filter((m) => /Story S1/.test(m)).length, 1, 'still over, but not warned again');
  await edit({ type: 'saveStory', mode: 'edit', story: { id: 'S1', title: 'First story', budget: 2, points: 3, group: 'G' } }, 47);
  assert.strictEqual(msgs.warn.filter((m) => /Story S1/.test(m)).length, 2, 'a new budget that is also exceeded warns again');
  settings.notifyOnBudget = false;
  await edit({ type: 'saveStory', mode: 'edit', story: { id: 'S1', title: 'First story', budget: 3, points: 3, group: 'G' } }, 48);
  assert.strictEqual(msgs.warn.filter((m) => /Story S1/.test(m)).length, 2, 'the setting turns warnings off');
  settings.notifyOnBudget = true;
  ok('budget warning: once per story and budget, and the setting turns it off');

  /* ---------------- tabs ---------------- */
  await main.handler({ type: 'newTab', route: { name: 'story', id: 'S1' } });
  assert.strictEqual(panels.length, 2, 'a second tab opened');
  const second_tab = panels[1];
  assert.ok(second_tab.html.includes('Content-Security-Policy'), 'new tab has the same locked-down shell');
  await second_tab.handler({ type: 'ready' }); await tick();
  assert.ok(second_tab.posted.some((m) => m.type === 'data'), 'new tab gets the scan');
  assert.deepStrictEqual(last(second_tab.posted.filter((m) => m.type === 'route')).route, { name: 'story', id: 'S1' }, 'and opens on the requested page');
  assert.ok(has(last(storiesMsgs(second_tab)).store, 'S1'), 'and the current stories');
  await main.handler({ type: 'newTab', route: { name: 'nope' } }); await main.handler({ type: 'newTab', route: { name: 'story' } }); await main.handler({ type: 'newTab' });
  assert.strictEqual(panels.length, 2, 'invalid routes do not open tabs');
  const m1 = storiesMsgs(main).length, m2 = storiesMsgs(second_tab).length;
  await main.handler({ type: 'story', rid: 50, op: { type: 'saveStory', mode: 'new', story: { id: 'S2', title: 'Second' } } }); await tick();
  assert.strictEqual(storiesMsgs(main).length, m1 + 1); assert.strictEqual(storiesMsgs(second_tab).length, m2 + 1, 'every tab hears about an edit');
  assert.ok(has(last(storiesMsgs(second_tab)).store, 'S2'), 'other tab sees the new story');
  ok('new tab: opens on the right page, gets data, hears about edits; bad routes ignored');

  // Commands reuse the main tab and ask it to move
  const rev = main.reveals;
  handlers['aiDeliveryInsights.openStories']();
  assert.strictEqual(panels.length, 2, 'commands reuse the main tab'); assert.strictEqual(main.reveals, rev + 1);
  assert.deepStrictEqual(last(main.posted.filter((m) => m.type === 'route')).route, { name: 'stories' });
  dialogs.pick = (items) => items.find((i) => i.label === 'S2');
  await handlers['aiDeliveryInsights.openStory']();
  assert.deepStrictEqual(last(main.posted.filter((m) => m.type === 'route')).route, { name: 'story', id: 'S2' });
  assert.deepStrictEqual(last(dialogs.pickCalls).items.map((i) => i.label), ['S1', 'S2'], 'stories offered in ID order');
  dialogs.pick = null;
  const routes = main.posted.filter((m) => m.type === 'route').length;
  await handlers['aiDeliveryInsights.openStory'](); // pick cancelled
  assert.strictEqual(main.posted.filter((m) => m.type === 'route').length, routes, 'cancelling the picker does nothing');
  ok('commands: Stories and Story reuse the main tab; the picker lists stories and can be cancelled');
  main.disposeFn(); // closing the main tab...
  handlers['aiDeliveryInsights.open'](); assert.strictEqual(panels.length, 3, '...means the next open creates a new one');
  ok('closing the main tab lets the next "Open" make a new one');

  /* ---------------- CSV per story ---------------- */
  dialogs.pick = (items) => items.find((i) => i.label === 'S1');
  const csvPath = path.join(scratch, 'story.csv');
  dialogs.save = csvPath;
  await handlers['aiDeliveryInsights.exportStoryCsv'](); await tick();
  assert.ok(/_story-S1/.test(last(dialogs.saveCalls).defaultUri.fsPath), 'file name says which story');
  const csv = fs.readFileSync(csvPath, 'utf8').trimEnd().split('\n');
  assert.ok(/story_id,story_title,story_group$/.test(csv[0]));
  assert.ok(csv.length > 3 && csv.slice(1).every((l) => /,S1,First story,G$/.test(l)), 'every row belongs to S1');
  let sum = 0; for (const l of csv.slice(1)) { sum += Number(l.match(/,(\d+\.\d{4}),\d+\.\d{4},(exact|tokens|estimated),/)[1]); }
  assert.ok(Math.abs(sum - (credits(big) + credits(second))) < csv.length * 5e-5 + 1e-9, `rows add up to the two sessions: ${sum} vs ${credits(big) + credits(second)}`);
  ok('story CSV: only that story, adds up to the story total', csv.length - 1 + ' rows');
  const saves = dialogs.saveCalls.length;
  await main.handler({ type: 'export', storyId: 'NOPE' }); await panels[2].handler({ type: 'export', storyId: 'NOPE' }); await tick();
  assert.strictEqual(dialogs.saveCalls.length, saves, 'unknown story: no file dialog');
  assert.ok(msgs.warn.some((m) => /no longer exists/.test(m)));
  await panels[2].handler({ type: 'export', storyId: { $ne: 1 } }); await tick();
  assert.strictEqual(dialogs.saveCalls.length, saves + 1, 'a non-string story id is ignored and the whole history is exported');
  ok('export request for a missing story is refused');
  // a range that is not a date is ignored, and a file that cannot be written is reported instead of ending as an unhandled error
  for (const bad of [{ from: 1e300, to: -1e300 }, { from: 'x', to: NaN }, { from: Infinity }, { from: {}, to: [] }, null, 'x', 5]) {
    const n = dialogs.saveCalls.length;
    dialogs.save = path.join(scratch, 'bad-range.csv');
    await panels[2].handler({ type: 'export', ...(bad && typeof bad === 'object' ? bad : {}) }); await tick();
    assert.strictEqual(dialogs.saveCalls.length, n + 1, 'the dialog opened for ' + JSON.stringify(bad));
    assert.ok(!/NaN|Invalid|undefined|null/.test(last(dialogs.saveCalls).defaultUri.fsPath), 'file name for ' + JSON.stringify(bad) + ': ' + last(dialogs.saveCalls).defaultUri.fsPath);
  }
  const warned = msgs.warn.length;
  dialogs.save = path.join(scratch, 'no-such-folder', 'x.csv');
  await panels[2].handler({ type: 'export' }); await tick();
  assert.ok(msgs.warn.length > warned && /could not be made/.test(last(msgs.warn)), 'a failed export says so');
  ok('export: a range that is not a date is ignored and a failed write is reported');

  /* ---------------- backup and restore ---------------- */
  const backup = path.join(scratch, 'backup.json');
  dialogs.save = backup;
  await handlers['aiDeliveryInsights.exportTags'](); await tick();
  const bk = fs.readFileSync(backup, 'utf8');
  assert.strictEqual(JSON.parse(bk).kind, 'copilot-lens-story-tags');
  for (const s of sessions) { for (const p of s.prompts) { if (p.text && p.text.length >= 12) { assert.ok(!bk.includes(p.text), 'no prompt text in the backup'); } } }
  assert.ok(!/\/home\/|\/Users\/|[A-Za-z]:\\\\/.test(bk), 'no paths in the backup');
  // wipe, then restore in merge mode
  await main.handler({ type: 'story', rid: 60, op: { type: 'deleteStory', id: 'S1' } }); await panels[2].handler({ type: 'story', rid: 61, op: { type: 'deleteStory', id: 'S2' } }); await tick();
  assert.deepStrictEqual(diskStore().stories, []);
  dialogs.open = backup; dialogs.pick = (items) => items.find((i) => i.label === 'Merge');
  await handlers['aiDeliveryInsights.importTags'](); await tick();
  assert.deepStrictEqual(diskStore().stories.map((s) => s.id).sort(), ['S1', 'S2'], 'merge restored the stories');
  assert.strictEqual(diskStore().sessionTags[big.id], 'S1', 'and the tags');
  assert.ok(has(last(storiesMsgs(panels[2])).store, 'S1'), 'open tabs were told');
  // replace needs a confirmation: declined = nothing happens
  await panels[2].handler({ type: 'story', rid: 62, op: { type: 'deleteStory', id: 'S2' } }); await tick();
  dialogs.pick = (items) => items.find((i) => i.label === 'Replace'); dialogs.warnChoice = undefined;
  await handlers['aiDeliveryInsights.importTags'](); await tick();
  assert.deepStrictEqual(diskStore().stories.map((s) => s.id), ['S1'], 'declined replace changed nothing');
  dialogs.warnChoice = 'Replace';
  await handlers['aiDeliveryInsights.importTags'](); await tick();
  assert.deepStrictEqual(diskStore().stories.map((s) => s.id).sort(), ['S1', 'S2'], 'confirmed replace applied the file');
  dialogs.warnChoice = undefined;
  // junk files are refused with a message and change nothing
  const junk = path.join(scratch, 'junk.json'); fs.writeFileSync(junk, '{"kind":"something else"}'); dialogs.open = junk;
  const errs = msgs.error.length; const snapshot = JSON.stringify(diskStore());
  await handlers['aiDeliveryInsights.importTags'](); await tick();
  assert.strictEqual(msgs.error.length, errs + 1); assert.strictEqual(JSON.stringify(diskStore()), snapshot);
  fs.writeFileSync(junk, 'x'.repeat(6 * 1024 * 1024)); await handlers['aiDeliveryInsights.importTags'](); await tick();
  assert.strictEqual(msgs.error.length, errs + 2, 'an oversized file is refused'); assert.strictEqual(JSON.stringify(diskStore()), snapshot);
  ok('backup has no prompt text or paths; restore merges, replace asks first, junk and oversized files are refused');

  /* ---------------- two windows ---------------- */
  // Window A is `ext` (already running). Window B is a second copy of the extension with its own memory,
  // sharing A's storage folder, exactly like a second VS Code window.
  const winA = panels[2]; // the tab that is open in window A (the first tab was closed above)
  const fullstack = Object.entries(data.payload.workspaces).find(([, w]) => w.name === 'fullstack');
  assert.ok(fullstack, 'fixture has a multi-root workspace');
  const [fsKey, fsWs] = fullstack;
  const memberOf = Object.entries(data.payload.workspaces).find(([, w]) => w.name === 'shop-api');
  const asWindow = (folders, file) => { vscode.workspace.workspaceFolders = folders.map((f) => ({ uri: Uri.file(f) })); vscode.workspace.workspaceFile = file ? Uri.file(file) : undefined; };

  // (1) what the page is told about this window, and the status bar, for a multi-root window
  asWindow([memberOf[1].path], fsWs.path);
  await winA.handler({ type: 'ready' }); await tick();
  const cur = last(winA.posted.filter((m) => m.type === 'data')).current;
  assert.strictEqual(cur.file, fsKey, 'the workspace file is sent as the window\'s workspace'); assert.strictEqual(cur.filePath, fsWs.path);
  assert.deepStrictEqual(cur.uris, ['file://' + memberOf[1].path], 'folders are sent separately from the file');
  folderHandlers[0](); // the window's folders changed -> the status bar re-reads them
  const tip = statusItems[0].tooltip.value;
  assert.ok(/All workspaces on this machine/.test(tip) && /This window \(fullstack\)/.test(tip), tip);
  assert.ok(/for all workspaces/.test(tip) && /^\$\(graph\) [\d,]+ cr$/.test(statusItems[0].text), statusItems[0].text);
  const allText = statusItems[0].text;
  settings.statusBarScope = 'thisWindow'; folderHandlers[0]();
  assert.notStrictEqual(statusItems[0].text, allText, 'the setting switches the number to this window\'s'); assert.ok(/this window's/.test(statusItems[0].tooltip.value));
  const weekCredits = (key) => { const since = Date.now() - 7 * 86400000; let c = 0; for (const s of data.payload.sessions) { if (s.wsKey !== key) { continue; } for (const p of s.prompts) { if ((p.ts || s.created || 0) >= since) { c += p.credits; } } if (s.overhead && (s.last || 0) >= since) { c += s.overhead.credits; } } return c; };
  assert.strictEqual(statusItems[0].text, `$(graph) ${Math.round(weekCredits(fsKey)).toLocaleString()} cr`, 'it is the workspace file\'s total, not a member folder\'s');
  settings.statusBarScope = 'allWorkspaces';
  asWindow([], null); folderHandlers[0]();
  assert.ok(/No folder is open in this window/.test(statusItems[0].tooltip.value), 'an empty window says so');
  asWindow([memberOf[1].path], null); folderHandlers[0]();
  assert.ok(/This window \(shop\\-api\)/.test(statusItems[0].tooltip.value), 'a folder window is named, with markdown characters in the name escaped: ' + statusItems[0].tooltip.value);
  asWindow([], null);
  ok('window identity: the page gets the workspace file and folders separately; the status bar names this window and can show its own total');

  // (2) a second window with its own memory
  const handlersA = { ...handlers };
  delete require.cache[require.resolve('../extension.js')];
  const extB = require('../extension.js');
  assert.notStrictEqual(extB, ext, 'a second, separate copy of the extension');
  const ctxB = mkctx(gs); // same storage folder, same global state
  const handlerCountA = windowStateHandlers.length;
  extB.activate(ctxB);
  const handlersB = { ...handlers }; Object.assign(handlers, handlersA);
  const focusA = windowStateHandlers[0], focusB = windowStateHandlers[handlerCountA];
  assert.ok(focusA && focusB && focusA !== focusB, 'each window listens for focus');
  handlersB['aiDeliveryInsights.open'](); const winB = last(panels);
  await winB.handler({ type: 'ready' }); await waitFor(() => winB.posted.some((m) => m.type === 'data'), 'window B\'s scan');
  const idsOf = (m) => m.store.stories.map((x) => x.id).sort();
  assert.deepStrictEqual(idsOf(last(storiesMsgs(winB))), ['S1', 'S2'], 'window B starts from what is on disk');

  // each window creates a story; neither has looked at the file since the other saved
  const editIn = async (panel, rid, op) => { const n = storiesMsgs(panel).length; await panel.handler({ type: 'story', rid, op }); await tick(); assert.strictEqual(storiesMsgs(panel).length, n + 1); return last(storiesMsgs(panel)); };
  r = await editIn(winA, 70, { type: 'saveStory', mode: 'new', story: { id: 'WIN-A', title: 'Made in window A' } }); assert.strictEqual(r.result.ok, true);
  r = await editIn(winB, 71, { type: 'saveStory', mode: 'new', story: { id: 'WIN-B', title: 'Made in window B' } }); assert.strictEqual(r.result.ok, true);
  assert.deepStrictEqual(idsOf(r), ['S1', 'S2', 'WIN-A', 'WIN-B'], 'B\'s reply already contains A\'s story: it reloaded before saving');
  assert.deepStrictEqual(diskStore().stories.map((x) => x.id).sort(), ['S1', 'S2', 'WIN-A', 'WIN-B'], 'nothing was lost on disk');
  ok('two windows: each edit starts from the newest saved file, so one window never erases the other\'s stories');

  // (3) A learns about B's story when its tab is shown or its window is focused, and edits made there build on it
  const beforeFocus = storiesMsgs(winA).length;
  focusA({ focused: false }); await tick();
  assert.strictEqual(storiesMsgs(winA).length, beforeFocus, 'losing focus does nothing');
  focusA({ focused: true }); await tick();
  assert.strictEqual(storiesMsgs(winA).length, beforeFocus + 1, 'gaining focus refreshed the tabs');
  assert.ok(idsOf(last(storiesMsgs(winA))).includes('WIN-B'), 'and the tab now shows the other window\'s story');
  const again = storiesMsgs(winA).length; focusA({ focused: true }); await tick();
  assert.strictEqual(storiesMsgs(winA).length, again, 'focusing with nothing new sends nothing');
  await editIn(winB, 72, { type: 'saveStory', mode: 'new', story: { id: 'WIN-B2', title: 'Another' } });
  const shown = storiesMsgs(winA).length; winA.viewStateFn({ webviewPanel: { visible: false } }); await tick();
  assert.strictEqual(storiesMsgs(winA).length, shown, 'a hidden tab is not refreshed');
  winA.viewStateFn({ webviewPanel: { visible: true } }); await tick();
  assert.ok(idsOf(last(storiesMsgs(winA))).includes('WIN-B2'), 'showing the tab refreshes it');
  // a tab that (re)loads asks for everything: it must get B's newest story even if nothing else refreshed it
  await editIn(winB, 76, { type: 'saveStory', mode: 'new', story: { id: 'WIN-B3', title: 'Third' } });
  assert.ok(!idsOf(last(storiesMsgs(winA))).includes('WIN-B3'), 'sanity: A has not heard about it yet');
  await winA.handler({ type: 'ready' }); await tick();
  assert.ok(idsOf(last(storiesMsgs(winA))).includes('WIN-B3'), 'a tab that (re)loads gets the newest stories');
  ok('two windows: focusing a window or showing a tab picks up the other window\'s changes, and only when there are some');

  // (4) a damaged file: the window keeps what it has and heals the file on its next save, keeping a copy
  fs.writeFileSync(path.join(gs, 'stories.json'), '{ not json');
  const stillThere = await editIn(winB, 73, { type: 'saveStory', mode: 'new', story: { id: 'AFTER-DAMAGE', title: 'Saved after the file broke' } });
  assert.strictEqual(stillThere.result.ok, true); assert.ok(idsOf(stillThere).includes('WIN-A') && idsOf(stillThere).includes('AFTER-DAMAGE'), 'memory kept, new story added');
  assert.ok(diskStore().stories.some((x) => x.id === 'AFTER-DAMAGE'), 'the file is valid again');
  assert.ok(fs.readdirSync(gs).some((f) => f.startsWith('stories.json.damaged-')), 'a copy of the broken file was kept');
  for (const f of fs.readdirSync(gs)) { if (f.startsWith('stories.json.damaged-')) { fs.rmSync(path.join(gs, f), { force: true }); } }
  ok('two windows: an unreadable stories file is kept aside and replaced on the next save, never silently lost');

  // (5) budget warnings: only the focused window speaks, and it is not repeated by the other
  await editIn(winA, 74, { type: 'saveStory', mode: 'edit', story: { id: 'S1', title: 'First story', budget: 1, points: 3, group: 'G' } }); // over budget again (new budget value)
  const spoke = () => msgs.warn.filter((m) => /Story S1/.test(m)).length;
  const n0 = spoke();
  vscode.window.state.focused = false;
  await editIn(winB, 75, { type: 'saveStory', mode: 'edit', story: { id: 'S1', title: 'First story', budget: 1.5, points: 3, group: 'G' } }); // still over, new budget, but this window is in the background
  assert.strictEqual(spoke(), n0, 'a window that is not focused stays quiet');
  vscode.window.state.focused = true; focusB({ focused: true }); await tick();
  assert.strictEqual(spoke(), n0 + 1, 'and says it once when focused');
  focusA({ focused: true }); await tick();
  assert.strictEqual(spoke(), n0 + 1, 'the other window does not repeat it');
  ok('two windows: a budget warning is shown once, by the window you are looking at');

  /* ---------------- damaged file ---------------- */
  const gs2 = path.join(scratch, 'second-install'); fs.mkdirSync(gs2, { recursive: true });
  fs.writeFileSync(path.join(gs2, 'stories.json'), '{this is not json');
  const warnsBefore = msgs.warn.length;
  ext.activate(mkctx(gs2));
  assert.ok(msgs.warn.length === warnsBefore + 1 && /could not read your saved stories/.test(last(msgs.warn)), last(msgs.warn));
  assert.ok(fs.readdirSync(gs2).some((f) => f.startsWith('stories.json.damaged-')), 'the damaged file is kept');
  ok('a damaged story file is kept aside and the person is told');

  console.log('\nAll smoke checks passed.');
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('SMOKE FAIL', e); process.exit(1); });
