'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { scan, defaultUserDirs, summarize, toCsv, diagnoseText } = require('./lib/scanner');
const { buildHtml } = require('./lib/html');
const crypto = require('crypto');
const Stories = require('./lib/stories');
const Core = require('./media/story-core.js');
const Ado = require('./lib/ado');
const { createService } = require('./lib/adoservice');

const panels = new Set(); // every open dashboard tab
let mainPanel; // the tab that "Open Dashboard" reuses
let stories = Core.emptyStore();
let storyCtx = { sessions: new Map() };
let lastData = null;
let scanning = null;
let statusItem;
let output;
let knownPaths = new Set();
let knownFiles = new Set();
let adoService = null;       // built in activate()
let installId = '';          // random ID for this VS Code installation: who contributed a session to a synced report (not a person)
let adoUserName = '';        // who Azure DevOps said is signed in, for display; only sent to Azure DevOps if the person opted in
const MS_SCOPES = ['499b84ac-1321-427f-aa17-267ca6975798/.default', 'offline_access']; // Azure DevOps through the Microsoft sign-in
const PAT_KEY = 'aiDeliveryInsights.ado.pat';

function cfg() { return vscode.workspace.getConfiguration('aiDeliveryInsights'); }

/** Every VS Code "User" data folder we should look in. */
function userDirs(context) {
  const dirs = [];
  // globalStorage is <User>/globalStorage/<publisher.name>, so two levels up is this edition's User folder
  // (works for stable, Insiders, VSCodium and portable installs).
  dirs.push(path.resolve(context.globalStorageUri.fsPath, '..', '..'));
  // Under the test harness (LENS_FIXTURE set) a fixture tree stands in for the "User" folder, so the real
  // per-edition folders on this machine must not also be scanned, or a real Copilot history leaks into the fixture.
  if (!process.env.LENS_FIXTURE) { dirs.push(...defaultUserDirs()); }
  const extra = userSetting('extraDataDirs', []);   // your own settings only: a repository's .vscode/settings.json must not choose which folders are read
  dirs.push(...(Array.isArray(extra) ? extra.filter((d) => typeof d === 'string' && d.trim() !== '') : []));
  const seen = new Set();
  return dirs.filter((d) => {
    const k = path.resolve(d).toLowerCase();
    if (seen.has(k) || !fs.existsSync(d)) { return false; }
    seen.add(k);
    return true;
  });
}

function cachePath(context) { return path.join(context.globalStorageUri.fsPath, 'scan-cache.json'); }

function loadCache(context) {
  try { return JSON.parse(fs.readFileSync(cachePath(context), 'utf8')); } catch { return { version: 0, entries: {} }; }
}

function saveCache(context, cache) {
  try {
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    // Write then rename, so a window that scans while another one is saving never leaves half a file.
    const tmp = `${cachePath(context)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, cachePath(context));
  } catch (e) { output.appendLine('Could not save cache: ' + e.message); }
}

/**
 * What this window has open. `uris`/`paths` are its folders; `file` is its .code-workspace (multi-root windows only).
 * An untitled workspace has no file on disk, so it is reported as no file and cannot be matched.
 */
function currentWorkspace() {
  const folders = vscode.workspace.workspaceFolders || [];
  const wf = vscode.workspace.workspaceFile;
  const real = wf && wf.scheme !== 'untitled';
  return {
    uris: folders.map((f) => f.uri.toString()),
    paths: folders.map((f) => f.uri.fsPath),
    file: real ? wf.toString() : null,
    filePath: real ? wf.fsPath : null,
  };
}

/** Send to every open dashboard tab. */
function post(msg) { for (const p of panels) { p.webview.postMessage(msg); } }

const storyDir = (context) => context.globalStorageUri.fsPath;
const storiesMessage = (result) => ({ type: 'stories', store: Core.toPlain(stories), result });

let storiesStamp = null; // fingerprint of stories.json as this window last saw it
let storiesDamaged = false;

function loadStories(context) {
  const r = Stories.load(storyDir(context));
  stories = r.store;
  storiesStamp = Stories.stampOf(storyDir(context));
  storiesDamaged = false;
  if (r.recovered) {
    vscode.window.showWarningMessage('AI Delivery Insights could not read your saved stories and started empty. The damaged file was kept next to it as stories.json.damaged-*.');
  }
}

/**
 * Every VS Code window shares the one stories file but keeps its own copy in memory.
 * Call this before reading or editing so a change made in another window is never overwritten.
 * Returns true when this window picked up a change.
 */
function syncStories(context) {
  const r = Stories.refresh(storyDir(context), storiesStamp);
  storiesStamp = r.stamp;
  if (r.damaged) { storiesDamaged = true; output.appendLine('stories.json could not be read; keeping the stories in memory.'); }
  if (!r.changed) { return false; }
  storiesDamaged = false;
  stories = r.store;
  return true;
}

/** Apply an edit, save it and tell every tab. Returns the result the person should see. */
function commitStories(context, op) {
  syncStories(context); // start from the newest saved copy, which may have been written by another window
  const res = Stories.applyOp(stories, op, storyCtx);
  if (!res.ok) { return { ok: false, error: res.error }; }
  try {
    if (storiesDamaged) { Stories.keepAside(Stories.storePath(storyDir(context))); storiesDamaged = false; }
    storiesStamp = Stories.save(storyDir(context), res.store);
  } catch (e) {
    output.appendLine('Could not save stories: ' + e.message);
    return { ok: false, error: 'Could not save your stories to disk.' };
  }
  stories = res.store;
  checkBudgets(context);
  return { ok: true, message: res.message };
}

/** One warning per story each time it goes over its credit budget (remembered, so rescans do not repeat it). */
function checkBudgets(context) {
  if (!lastData || !cfg().get('notifyOnBudget', true)) { return; }
  const { rows } = Core.buildRows(lastData);
  const g = Core.groupByStory(rows, stories);
  const told = new Map(context.globalState.get('aiDeliveryInsights.budgetNotified', []));
  // With several windows open, only the one you are looking at speaks; the others stay quiet and say it when focused.
  const focused = !vscode.window.state || vscode.window.state.focused !== false;
  const next = [];
  for (const [id, rs] of g.byStory) {
    const st = stories.stories[id];
    if (!st || !st.budget) { continue; }
    const credits = Core.totals(rs).credits;
    if (credits <= st.budget) { continue; }
    if (told.get(id) !== st.budget && !focused) { continue; } // not told yet: leave it unrecorded so it is announced later
    next.push([id, st.budget]);
    if (told.get(id) !== st.budget) {
      Promise.resolve(vscode.window.showWarningMessage(`Story ${id} has used ${credits.toFixed(1)} credits, over its budget of ${st.budget}.`, 'Open story'))
        .then((c) => { if (c === 'Open story') { openPanel(context, { name: 'story', id }); } });
    }
  }
  context.globalState.update('aiDeliveryInsights.budgetNotified', next);
}

const mdEscape = (t) => String(t).replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');

/** Status bar: the all-workspaces total by default (or this window's, by setting), with both in the tooltip. */
function updateStatus() {
  if (!statusItem) { return; }
  if (!cfg().get('showStatusBar', true) || !lastData) { statusItem.hide(); return; }
  const weekFrom = Date.now() - 7 * 86400000;
  const dayFrom = new Date().setHours(0, 0, 0, 0);
  const all = { week: summarize(lastData, weekFrom), today: summarize(lastData, dayFrom) };
  const key = Core.currentWorkspaceKey(lastData.workspaces, currentWorkspace());
  const win = key ? { week: summarize(lastData, weekFrom, key), today: summarize(lastData, dayFrom, key) } : null;
  const line = (t) => `Today: ${t.today.credits.toFixed(1)} credits, ${t.today.prompts} prompts. Last 7 days: ${t.week.credits.toFixed(1)} credits (about $${(t.week.credits / 100).toFixed(2)}), ${t.week.prompts} prompts.`;
  const scope = cfg().get('statusBarScope', 'allWorkspaces') === 'thisWindow' ? 'thisWindow' : 'allWorkspaces';
  const shown = scope === 'thisWindow' ? (win || { week: { credits: 0 } }) : all;
  statusItem.text = `$(graph) ${Math.round(shown.week.credits).toLocaleString()} cr`;
  const winName = key ? mdEscape((lastData.workspaces[key] || {}).name || 'this workspace') : null;
  statusItem.tooltip = new vscode.MarkdownString(
    `**AI Delivery Insights**\n\n**All workspaces on this machine**\n\n${line(all)}\n\n`
    + (win ? `**This window (${winName})**\n\n${line(win)}\n\n`
      : Core.hasWorkspace(currentWorkspace()) ? '**This window**\n\nNo saved Copilot chats for this window\'s workspace yet.\n\n' : '**This window**\n\nNo folder is open in this window.\n\n')
    + `The number in the status bar is ${scope === 'thisWindow' ? 'this window\'s' : 'for all workspaces'} (setting: aiDeliveryInsights.statusBarScope). Click to open the dashboard.`);
  statusItem.show();
}

async function runScan(context) {
  if (scanning) { return scanning; }
  scanning = (async () => {
    const cache = loadCache(context);
    try {
      const data = await scan({
        userDirs: userDirs(context),
        pricing: (() => { const p = userSetting('pricing', {}); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; })(),
        cache,
        onProgress: (done, total) => post({ type: 'progress', done, total }),
      });
      saveCache(context, cache);
      lastData = data;
      knownPaths = new Set(Object.values(data.workspaces).filter((w) => w.local).map((w) => w.path));
      knownFiles = new Set(data.sessions.map((s) => s.file).filter(Boolean));
      storyCtx = Stories.contextFor(data);
      updateStatus();
      post({ type: 'data', payload: data, current: currentWorkspace(), allowance: cfg().get('monthlyAllowanceCredits') || 0 });
      checkBudgets(context);
      return data;
    } catch (e) {
      output.appendLine('Scan failed: ' + (e && e.stack || e));
      vscode.window.showErrorMessage('AI Delivery Insights could not read your Copilot history. See the "AI Delivery Insights" output for details.');
      return null;
    } finally { scanning = null; }
  })();
  return scanning;
}

/** Show the dashboard, optionally on a given page. Reuses the main tab. */
function openPanel(context, route) {
  const r = route ? Core.normalizeRoute(route) : null;
  if (mainPanel) { mainPanel.reveal(); if (r) { mainPanel.webview.postMessage({ type: 'route', route: r }); } return; }
  mainPanel = createPanel(context, r);
}

/** Create one dashboard tab. `route` is the page it should open on (already validated). */
function createPanel(context, route) {
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  const p = vscode.window.createWebviewPanel('aiDeliveryInsights', 'AI Delivery Insights', vscode.ViewColumn.Active, {
    enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media],
  });
  panels.add(p);
  p.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
  const w = p.webview;
  const asUri = (f) => w.asWebviewUri(vscode.Uri.joinPath(media, f));
  w.html = buildHtml(w.cspSource, asUri('dashboard.css'), asUri('story-core.js'), asUri('dashboard.js'));
  p.onDidDispose(() => { panels.delete(p); if (mainPanel === p) { mainPanel = undefined; } }, null, context.subscriptions);
  // Coming back to a tab: show any stories another window saved while it was in the background.
  p.onDidChangeViewState((e) => { if (e.webviewPanel.visible && syncStories(context)) { post(storiesMessage()); } }, null, context.subscriptions);
  let pendingRoute = route || null;

  w.onDidReceiveMessage(async (m) => {
    if (!m || typeof m !== 'object') { return; }
    switch (m.type) {
      case 'ready':
        syncStories(context); // another window may have saved since this one last looked
        if (lastData) { w.postMessage({ type: 'data', payload: lastData, current: currentWorkspace(), allowance: cfg().get('monthlyAllowanceCredits') || 0 }); }
        else { runScan(context); }
        w.postMessage(storiesMessage());
        if (pendingRoute) { w.postMessage({ type: 'route', route: pendingRoute }); pendingRoute = null; }
        break;
      case 'rescan': runScan(context); break;
      case 'export': exportCsv({ from: m.from, to: m.to, storyId: m.storyId }).catch((e) => { output.appendLine('Export failed: ' + cleanError(e)); vscode.window.showWarningMessage('The export could not be made. See the "AI Delivery Insights" output for details.'); }); break;
      case 'openFolder':
        if (knownPaths.has(m.path) && fs.existsSync(m.path)) {
          vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(m.path), { forceNewWindow: true });
        } else { vscode.window.showWarningMessage('That folder is not available on this machine.'); }
        break;
      case 'reveal':
        if (knownFiles.has(m.path)) { vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.path)); }
        break;
      case 'command': {
        // Backup and restore are commands so they get the same file dialogs and confirmations as the palette.
        if (PAGE_COMMANDS.includes(m.name)) { vscode.commands.executeCommand('aiDeliveryInsights.' + m.name); }
        break;
      }
      case 'newTab': {
        const r = Core.normalizeRoute(m.route);
        if (r) { createPanel(context, r); }
        break;
      }
      case 'story': {
        // Only these edits may come from the page. Import is a command, so a page can never replace your data.
        const allowed = ['saveStory', 'deleteStory', 'tagSessions', 'tagPrompt', 'tagPhase', 'saveEffort', 'clearEffort'];
        const rid = typeof m.rid === 'number' ? m.rid : 0;
        const result = m.op && typeof m.op === 'object' && allowed.includes(m.op.type) ? commitStories(context, m.op) : { ok: false, error: 'Unknown request.' };
        post(storiesMessage({ rid, ...result }));
        break;
      }
      case 'ado': {
        // Azure DevOps and effort requests. The reply goes to the tab that asked (a sync preview can be large and is nobody else's business).
        const rid = typeof m.rid === 'number' ? m.rid : 0;
        const reply = await handleAdo(context, m);
        w.postMessage({ type: 'ado', rid, ...reply });
        break;
      }
      default: break;
    }
  }, null, context.subscriptions);
  return p;
}

async function exportCsv(range) {
  if (!lastData) { vscode.window.showInformationMessage('Open the dashboard first so AI Delivery Insights can read your history.'); return; }
  const r = range && typeof range === 'object' ? range : {};
  const inRange = (t) => Number.isFinite(t) && Math.abs(t) <= 8.64e15;   // the range a Date can hold; anything else is not a date
  const from = inRange(r.from) ? r.from : null;
  const to = inRange(r.to) ? r.to : null;
  const storyId = typeof r.storyId === 'string' && Core.hasOwn(stories.stories, r.storyId) ? r.storyId : null;
  if (typeof r.storyId === 'string' && !storyId) { vscode.window.showWarningMessage('That story no longer exists.'); return; }
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const suffix = (storyId ? `_story-${storyId.replace(/[^\w.-]/g, '_')}` : '') + (from != null || to != null ? `_${from != null ? day(from) : 'start'}_to_${to != null ? day(to) : 'today'}` : '');
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(require('os').homedir(), `copilot-usage${suffix}.csv`)),
    filters: { CSV: ['csv'] },
  });
  if (!target) { return; }
  const csv = toCsv(lastData, { from, to, store: stories, storyId });
  fs.writeFileSync(target.fsPath, csv, 'utf8');
  const count = Math.max(0, csv.split('\n').length - 1);
  vscode.window.showInformationMessage(`Exported ${count} ${storyId ? 'rows' : 'prompts'} to ${path.basename(target.fsPath)}.`);
}

const storyPick = async (placeHolder) => {
  const items = Object.values(stories.stories).sort((a, b) => (a.id < b.id ? -1 : 1)).map((st) => ({ label: st.id, description: st.title, detail: st.group || undefined }));
  if (!items.length) { vscode.window.showInformationMessage('No stories yet. Open the dashboard, choose Stories, and create one.'); return null; }
  const picked = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
  return picked ? picked.label : null;
};

async function exportTags() {
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(require('os').homedir(), 'ai-delivery-insights-stories.json')), filters: { JSON: ['json'] },
  });
  if (!target) { return; }
  fs.writeFileSync(target.fsPath, Stories.exportText(stories), 'utf8');
  vscode.window.showInformationMessage(`Saved ${Object.keys(stories.stories).length} stories and their tags to ${path.basename(target.fsPath)}. The file has no prompt text.`);
}

async function importTags(context) {
  const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] }, openLabel: 'Import' });
  if (!picked || !picked[0]) { return; }
  const parsed = Stories.readImportFile(picked[0].fsPath);
  if (!parsed.ok) { vscode.window.showErrorMessage(parsed.error); return; }
  const mode = await vscode.window.showQuickPick([
    { label: 'Merge', description: 'Keep my current stories and tags; add the ones from the file', mode: 'merge' },
    { label: 'Replace', description: 'Replace all my stories and tags with the file', mode: 'replace' },
  ], { placeHolder: 'How should the backup be combined with your current stories?' });
  if (!mode) { return; }
  if (mode.mode === 'replace') {
    const sure = await vscode.window.showWarningMessage('Replace all your stories and tags with this backup?', { modal: true }, 'Replace');
    if (sure !== 'Replace') { return; }
  }
  const result = commitStories(context, { type: 'import', data: parsed.data, mode: mode.mode });
  if (result.ok) { post(storiesMessage()); vscode.window.showInformationMessage(result.message); } else { vscode.window.showErrorMessage(result.error); }
}

/* ------------------------------------------------------------------ */
/* Azure DevOps                                                        */
/* ------------------------------------------------------------------ */

// Commands a page may ask for: backup and restore, and the connection dialogs. They are VS Code's own prompts, so the page never handles a token.
const PAGE_COMMANDS = ['exportTags', 'importTags', 'adoConnect', 'adoSetToken', 'adoClearToken', 'adoDisconnect'];
const trusted = () => !vscode.workspace || vscode.workspace.isTrusted !== false;
const cleanError = (e) => String(e && e.message || e).replace(/[\u0000-\u001f]/g, ' ').slice(0, 200);

/** A setting read from the person's own user settings only, so a workspace's .vscode/settings.json can never change where data goes. */
function userSetting(key, fallback) {
  const c = cfg();
  const i = typeof c.inspect === 'function' ? c.inspect(key) : null;
  if (!i) { const v = c.get(key, fallback); return v === undefined ? fallback : v; }
  const v = i.globalValue !== undefined ? i.globalValue : i.defaultValue;
  return v === undefined ? fallback : v;
}

function adoSettings() {
  const c = cfg();
  const text = (k) => { const v = userSetting(k, ''); return typeof v === 'string' ? v.trim().slice(0, 200) : ''; };
  const types = userSetting('ado.storyTypes', Ado.DEFAULT_STORY_TYPES);
  const num = (k) => { const v = userSetting(k, undefined); return typeof v === 'number' ? v : undefined; };
  return {
    enabled: userSetting('ado.enabled', false) === true,
    organization: text('ado.organization'),
    project: text('ado.project'),
    authMethod: userSetting('ado.authMethod', 'microsoft') === 'pat' ? 'pat' : 'microsoft',
    storyTypes: Array.isArray(types) ? types.filter((t) => typeof t === 'string' && Ado.validTypeName(t)).slice(0, 10) : Ado.DEFAULT_STORY_TYPES,
    shareName: userSetting('ado.shareName', false) === true,
    effort: { prodLinesPerDay: num('effort.prodLinesPerDay'), testLinesPerDay: num('effort.testLinesPerDay'), hoursPerDay: num('effort.hoursPerDay'), overheadPercent: num('effort.overheadPercent'), hoursPerPoint: num('effort.hoursPerPoint') },
  };
}

/** A token for ONE request. Nothing is kept in a variable: a personal access token comes from secret storage, a Microsoft token from the sign-in VS Code holds. */
async function adoAuth(context) {
  if (adoSettings().authMethod === 'pat') {
    const token = await context.secrets.get(PAT_KEY);
    if (!token) { throw new Ado.AdoError('auth', 'No personal access token is stored. Run "AI Delivery Insights: Azure DevOps: Set Personal Access Token".'); }
    return { scheme: 'Basic', token };
  }
  const session = await vscode.authentication.getSession('microsoft', MS_SCOPES, { createIfNone: false, silent: true });
  if (!session) { throw new Ado.AdoError('auth', 'You are not signed in to Azure DevOps. Run "AI Delivery Insights: Azure DevOps: Connect".'); }
  return { scheme: 'Bearer', token: session.accessToken };
}

/** Whether a sign-in exists. Only asked when Azure DevOps is turned on, so a switched-off extension never talks to the sign-in provider. */
async function hasCredential(context) {
  try {
    if (adoSettings().authMethod === 'pat') { return !!(await context.secrets.get(PAT_KEY)); }
    return !!(await vscode.authentication.getSession('microsoft', MS_SCOPES, { createIfNone: false, silent: true }));
  } catch { return false; }
}

function currentRepoFolders() {
  return currentWorkspace().paths.filter((p) => fs.existsSync(path.join(p, '.git'))).map((p) => ({ path: p, label: path.basename(p) }));
}

function makeAdoService(context) {
  return createService({
    settings: adoSettings,
    trusted,
    client: async () => Ado.createClient({ org: adoSettings().organization, auth: () => adoAuth(context), log: (l) => output.appendLine('[azure devops] ' + l) }),
    data: async () => lastData || runScan(context),
    store: () => { syncStories(context); return stories; },
    commit: (op) => { const r = commitStories(context, op); if (r.ok) { post(storiesMessage()); } return r; },
    contributor: () => ({ id: installId, displayName: adoUserName }),
    currentRepos: currentRepoFolders,
    log: (l) => output.appendLine(l),
    // Asked of the person by the extension itself (not the page) before a Task is created, or when the target of a sync is new or has changed.
    confirmWrite: async (t) => {
      const what = t.creating ? `create one new Task under work item #${t.adoId}` : `replace the description of Task #${t.taskId} (under work item #${t.adoId})`;
      const label = 'Write to Azure DevOps';
      const pick = await vscode.window.showWarningMessage('Write AI Delivery Insights usage to Azure DevOps?', {
        modal: true,
        detail: `Organisation: ${t.org}\nProject: ${t.project}\nWork item #${t.adoId}: ${t.title}\n\nAI Delivery Insights will ${what}. The report holds counts, credits, tokens and effort only: no prompt text, session titles, file names or paths. Nothing else in Azure DevOps is changed. You are asked again only if the target changes.`,
      }, label);
      return pick === label;
    },
  });
}

/** One request from a page. Returns plain data; never a token, a header or a stack. */
async function handleAdo(context, m) {
  const s = adoService;
  try {
    switch (m.op) {
      case 'status': {
        const st = s.status();
        const on = st.enabled && st.trusted;
        return { ok: true, ...st, authMethod: adoSettings().authMethod, signedIn: on ? await hasCredential(context) : false, user: adoUserName ? { name: adoUserName } : null };
      }
      case 'test': { const r = await s.test(); if (r.ok && r.user) { adoUserName = r.user.name; } return r; }
      case 'boards': return await s.listBoards({ project: m.project });
      case 'backlog': return await s.listBacklog({ project: m.project, board: m.board });
      case 'import': return await s.importStories({ ids: m.ids });
      case 'refresh': return await s.refreshStory({ storyId: m.storyId });
      case 'effortFind': return await s.effortFind({ storyId: m.storyId });
      case 'effortCompute': return await s.effortCompute({ storyId: m.storyId, cacheId: m.cacheId, selected: m.selected });
      case 'effortSave': return await s.effortSave({ storyId: m.storyId, cacheId: m.cacheId, selected: m.selected });
      case 'syncPreview': return await s.syncPreview({ storyId: m.storyId });
      case 'syncApply': return await s.syncApply({ storyId: m.storyId, planId: m.planId });
      case 'open': {
        const url = s.urlFor({ storyId: m.storyId, kind: m.kind === 'task' ? 'task' : 'story' });
        if (!url || !url.startsWith('https://dev.azure.com/')) { return { ok: false, error: 'There is nothing to open for this story yet.' }; }
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return { ok: true };
      }
      default: return { ok: false, error: 'Unknown request.' };
    }
  } catch (e) {
    output.appendLine('Azure DevOps request failed: ' + (e && e.stack || e));
    return { ok: false, error: 'Something unexpected went wrong. See the "AI Delivery Insights" output for details.' };
  }
}

/** Ask for a personal access token in a password box and keep it in VS Code's secret storage. Returns false if the person cancelled. */
async function promptToken(context) {
  const t = await vscode.window.showInputBox({
    title: 'Azure DevOps personal access token', password: true, ignoreFocusOut: true,
    prompt: 'Paste a token with the "Work Items: Read & write" scope (add "Project and Team: Read" only if you want AI Delivery Insights to list your projects; without it you type the project name). It is kept in VS Code\'s secret storage on this computer and is never shown again.',
    validateInput: (v) => (!v || !v.trim() ? 'Paste the token.' : /\s/.test(v.trim()) ? 'A token has no spaces.' : v.trim().length > 4096 ? 'That is too long to be a token.' : null),
  });
  if (t === undefined) { return false; }
  await context.secrets.store(PAT_KEY, t.trim());
  return true;
}

/** The connection wizard: organisation, how to sign in, an explicit "turn on", a test, and a default project. */
async function adoConnect(context) {
  if (!trusted()) { vscode.window.showWarningMessage('Azure DevOps is not available in Restricted Mode. Trust this workspace first.'); return; }
  const cur = adoSettings();
  const typed = await vscode.window.showInputBox({
    title: 'Connect to Azure DevOps', prompt: 'Your Azure DevOps organisation, for example contoso or https://dev.azure.com/contoso', value: cur.organization, ignoreFocusOut: true,
    validateInput: (v) => { const r = Ado.parseOrganization(v); return r.ok ? null : r.error; },
  });
  if (typed === undefined) { return; }
  const org = Ado.parseOrganization(typed);
  if (!org.ok) { return; }
  const method = await vscode.window.showQuickPick([
    { label: 'Sign in with Microsoft', description: 'Recommended. VS Code holds the sign-in; AI Delivery Insights never sees your password.', method: 'microsoft' },
    { label: 'Use a personal access token', description: 'Fallback. The token is kept in VS Code\'s secret storage on this computer.', method: 'pat' },
  ], { placeHolder: 'How do you want to sign in?', ignoreFocusOut: true });
  if (!method) { return; }
  const agree = await vscode.window.showInformationMessage(
    `AI Delivery Insights will contact https://dev.azure.com/${org.org} when you use its Azure DevOps pages. It reads work items, and it creates or updates one Task per story that holds usage totals and effort. It never sends prompts, responses, session titles, file names or paths.`,
    { modal: true }, 'Turn on');
  if (agree !== 'Turn on') { return; }
  if (method.method === 'pat') {
    if (!(await promptToken(context))) { return; }
  } else {
    try {
      const session = await vscode.authentication.getSession('microsoft', MS_SCOPES, { createIfNone: true });
      if (!session) { return; }
    } catch (e) { vscode.window.showErrorMessage('The Microsoft sign-in did not complete: ' + cleanError(e)); return; }
  }
  const G = vscode.ConfigurationTarget.Global;
  await cfg().update('ado.organization', org.org, G);
  await cfg().update('ado.authMethod', method.method, G);
  await cfg().update('ado.enabled', true, G);
  let r = await adoService.test();
  if (!r.ok && r.needsProject) {
    // The sign-in cannot list projects (a personal access token without "Project and Team: Read"). Ask for the project by name instead.
    const named = await vscode.window.showInputBox({
      title: 'Which project holds your stories?',
      prompt: 'Azure DevOps would not list your projects with this sign-in. Type the name of the project that holds your stories, exactly as it appears in Azure DevOps.',
      value: cur.project, ignoreFocusOut: true,
      validateInput: (v) => (Ado.validProject(String(v || '').trim()) ? null : 'That is not a valid project name.'),
    });
    if (named !== undefined && Ado.validProject(named.trim())) {
      await cfg().update('ado.project', named.trim(), G);
      r = await adoService.test();
    }
  }
  post({ type: 'adoChanged' });
  if (!r.ok) {
    vscode.window.showErrorMessage(`Connected settings were saved, but the test failed: ${r.error}`);
    return;
  }
  if (r.user) { adoUserName = r.user.name; }
  if (r.projectsListed === false) {
    vscode.window.showInformationMessage(`Connected to ${org.org}${r.user ? ' as ' + r.user.name : ''}, using the project "${r.projects[0]}". This sign-in cannot list projects (a personal access token needs "Project and Team: Read" for that), which is fine for working with one project.`);
    return;
  }
  if (r.projects.length) {
    const pick = await vscode.window.showQuickPick(r.projects.map((n) => ({ label: n, picked: n === cur.project })), { placeHolder: 'Which project holds your stories? (you can change this later in settings)', ignoreFocusOut: true });
    if (pick) { await cfg().update('ado.project', pick.label, G); post({ type: 'adoChanged' }); }
  }
  vscode.window.showInformationMessage(`Connected to ${org.org}${r.user ? ' as ' + r.user.name : ''}. Open AI Delivery Insights > Stories to import stories.`);
}

async function adoSetToken(context) {
  if (!(await promptToken(context))) { return; }
  vscode.window.showInformationMessage('The token was saved in VS Code\'s secret storage. It is used only when "aiDeliveryInsights.ado.authMethod" is "pat".');
  post({ type: 'adoChanged' });
}

async function adoClearToken(context) {
  const label = 'Remove the token';
  if (await vscode.window.showWarningMessage('Remove the stored Azure DevOps token from this computer? Azure DevOps will still accept it until you revoke it there (User settings, Personal access tokens).', { modal: true }, label) !== label) { return; }
  await context.secrets.delete(PAT_KEY);
  vscode.window.showInformationMessage('The stored Azure DevOps token was removed.');
  post({ type: 'adoChanged' });
}

async function adoDisconnect(context) {
  const label = 'Turn off and remove the token';
  if (await vscode.window.showWarningMessage('Turn off Azure DevOps and remove any stored token? Your stories, tags and effort figures stay. Nothing in Azure DevOps is changed.', { modal: true }, label) !== label) { return; }
  await context.secrets.delete(PAT_KEY);
  await cfg().update('ado.enabled', false, vscode.ConfigurationTarget.Global);
  adoUserName = '';
  post({ type: 'adoChanged' });
  vscode.window.showInformationMessage('Azure DevOps is turned off and the stored token was removed. Nothing in Azure DevOps was changed. If you signed in with Microsoft, you can sign out from the Accounts menu in VS Code.');
}

function activate(context) {
  output = vscode.window.createOutputChannel('AI Delivery Insights');
  loadStories(context);
  installId = String(context.globalState.get('aiDeliveryInsights.installId') || '');
  if (!/^inst-[0-9a-f]{20}$/.test(installId)) { installId = 'inst-' + crypto.randomBytes(10).toString('hex'); context.globalState.update('aiDeliveryInsights.installId', installId); }
  adoService = makeAdoService(context);
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.command = 'aiDeliveryInsights.open';
  context.subscriptions.push(output, statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('aiDeliveryInsights.open', () => openPanel(context)),
    vscode.commands.registerCommand('aiDeliveryInsights.rescan', async () => {
      await runScan(context);
      vscode.window.setStatusBarMessage('AI Delivery Insights: scan complete', 3000);
    }),
    vscode.commands.registerCommand('aiDeliveryInsights.exportCsv', () => exportCsv()),
    vscode.commands.registerCommand('aiDeliveryInsights.openStories', () => openPanel(context, { name: 'stories' })),
    vscode.commands.registerCommand('aiDeliveryInsights.openStory', async () => {
      const id = await storyPick('Open which story?');
      if (id) { openPanel(context, { name: 'story', id }); }
    }),
    vscode.commands.registerCommand('aiDeliveryInsights.exportStoryCsv', async () => {
      if (!lastData) { await runScan(context); }
      const id = await storyPick('Export which story as CSV?');
      if (id) { await exportCsv({ storyId: id }); }
    }),
    vscode.commands.registerCommand('aiDeliveryInsights.adoConnect', () => adoConnect(context)),
    vscode.commands.registerCommand('aiDeliveryInsights.adoSetToken', () => adoSetToken(context)),
    vscode.commands.registerCommand('aiDeliveryInsights.adoClearToken', () => adoClearToken(context)),
    vscode.commands.registerCommand('aiDeliveryInsights.adoDisconnect', () => adoDisconnect(context)),
    vscode.commands.registerCommand('aiDeliveryInsights.adoImport', () => openPanel(context, { name: 'import' })),
    vscode.commands.registerCommand('aiDeliveryInsights.exportTags', () => exportTags()),
    vscode.commands.registerCommand('aiDeliveryInsights.importTags', () => importTags(context)),
    vscode.commands.registerCommand('aiDeliveryInsights.diagnose', async () => {
      const data = await runScan(context);
      if (!data) { return; }
      output.clear();
      output.appendLine(diagnoseText(data));
      output.show(true);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiDeliveryInsights')) { updateStatus(); }
      if (e.affectsConfiguration('aiDeliveryInsights.ado') || e.affectsConfiguration('aiDeliveryInsights.effort')) { post({ type: 'adoChanged' }); }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => updateStatus()),
    // Switching to this window: pick up stories saved by another window, then say anything that was held back.
    vscode.window.onDidChangeWindowState((e) => {
      if (!e.focused) { return; }
      if (syncStories(context)) { post(storiesMessage()); }
      checkBudgets(context);
    }),
  );

  if (typeof vscode.workspace.onDidGrantWorkspaceTrust === 'function') { context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => post({ type: 'adoChanged' }))); }

  // Fill the status bar shortly after startup without slowing it down.
  if (cfg().get('showStatusBar', true)) { setTimeout(() => runScan(context), 4000); }
}

function deactivate() {}

module.exports = { activate, deactivate };
