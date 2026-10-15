'use strict';
/**
 * A small stand-in for the parts of the VS Code API the extension uses, for the Azure DevOps wiring tests.
 * Everything the extension could do to the outside world is recorded so a test can say what did NOT happen.
 */
const Module = require('module');
const path = require('path');

function createMock() {
  const m = {
    handlers: {}, panels: [], executed: [], statusItems: [], windowStateHandlers: [],
    msgs: { info: [], warn: [], error: [] }, outputLines: [], opened: [], updates: [],
    dialogs: {
      input: [], pickChoice: null, infoChoice: undefined, inputCalls: [], pickCalls: [], infoCalls: [],
      // Warnings with buttons are the extension's own confirmation windows. By default the person closes them without choosing.
      // warnChoice: undefined (close it), 'first' (press the first button), a button label, or a function (message, buttons, options) => label.
      warnChoice: undefined, warnCalls: [],
    },
    auth: { session: null, calls: [], throwOnCreate: null },
    secrets: new Map(), secretCalls: [], state: new Map(),
    defaults: { 'ado.enabled': false, 'ado.organization': '', 'ado.project': '', 'ado.authMethod': 'microsoft', 'ado.storyTypes': ['User Story', 'Product Backlog Item', 'Requirement', 'Issue'], 'ado.shareName': false },
    globalSettings: {}, workspaceSettings: {}, other: { showStatusBar: true, extraDataDirs: [], pricing: {}, notifyOnBudget: true, monthlyAllowanceCredits: 0 },
    trusted: true,
  };
  // what a naive reader would see: a workspace value wins over the user's
  const effective = (k) => (k in m.workspaceSettings ? m.workspaceSettings[k] : k in m.globalSettings ? m.globalSettings[k] : k in m.defaults ? m.defaults[k] : m.other[k]);
  const Uri = {
    file: (p) => ({ fsPath: p, scheme: 'file', toString: () => 'file://' + p }),
    parse: (s) => ({ scheme: String(s).split(':')[0], fsPath: String(s), toString: () => String(s) }),
    joinPath: (b, ...p) => Uri.file(path.join(b.fsPath, ...p)),
  };
  const vscode = {
    Uri, ViewColumn: { Active: 1 }, StatusBarAlignment: { Right: 2 }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    MarkdownString: class { constructor(v) { this.value = v; } },
    workspace: {
      get isTrusted() { return m.trusted; },
      getConfiguration: () => ({
        get: (k, d) => { const v = effective(k); return v === undefined ? d : v; },
        inspect: (k) => ({ key: k, defaultValue: m.defaults[k], globalValue: m.globalSettings[k], workspaceValue: m.workspaceSettings[k] }),
        update: async (k, v, target) => { m.updates.push({ k, v, target }); m.globalSettings[k] = v; },
      }),
      workspaceFolders: [], workspaceFile: undefined,
      onDidChangeConfiguration: () => ({ dispose() {} }), onDidChangeWorkspaceFolders: () => ({ dispose() {} }), onDidGrantWorkspaceTrust: () => ({ dispose() {} }),
    },
    commands: { registerCommand: (id, fn) => { m.handlers[id] = fn; return { dispose() {} }; }, executeCommand: async (...a) => { m.executed.push(a); } },
    authentication: {
      getSession: async (provider, scopes, opts) => {
        m.auth.calls.push({ provider, scopes, opts });
        if (opts && opts.createIfNone && m.auth.throwOnCreate) { throw new Error(m.auth.throwOnCreate); }
        return m.auth.session;
      },
    },
    env: { openExternal: async (u) => { m.opened.push(u.toString()); return true; } },
    window: {
      state: { focused: true },
      onDidChangeWindowState: (fn) => { m.windowStateHandlers.push(fn); return { dispose() {} }; },
      createOutputChannel: () => ({ appendLine: (l) => m.outputLines.push(String(l)), clear() {}, show() {}, dispose() {} }),
      createStatusBarItem: () => { const it = { show() {}, hide() {}, dispose() {} }; m.statusItems.push(it); return it; },
      createWebviewPanel: () => {
        const p = {
          html: '', posted: [], handler: null, reveals: 0, disposeFn: null, iconPath: null,
          reveal() { this.reveals++; }, onDidDispose(fn) { this.disposeFn = fn; }, onDidChangeViewState() {},
          webview: {
            cspSource: 'vscode-resource:', asWebviewUri: (u) => 'vscode-resource://' + u.fsPath,
            set html(v) { p.html = v; }, get html() { return p.html; },
            postMessage: (msg) => { p.posted.push(JSON.parse(JSON.stringify(msg))); return Promise.resolve(true); },
            onDidReceiveMessage: (fn) => { p.handler = fn; },
          },
        };
        m.panels.push(p); return p;
      },
      showErrorMessage: (s) => { m.msgs.error.push(String(s)); return Promise.resolve(undefined); },
      showInformationMessage: (s, ...rest) => { m.msgs.info.push(String(s)); m.dialogs.infoCalls.push([s, ...rest]); return Promise.resolve(m.dialogs.infoChoice); },
      showWarningMessage: (s, ...rest) => {
        m.msgs.warn.push(String(s));
        const buttons = rest.filter((x) => typeof x === 'string');
        const options = rest.find((x) => x && typeof x === 'object') || null;
        m.dialogs.warnCalls.push({ message: String(s), buttons, options });
        const c = m.dialogs.warnChoice;
        const pick = typeof c === 'function' ? c(String(s), buttons, options) : c === 'first' ? buttons[0] : c;
        return Promise.resolve(buttons.includes(pick) ? pick : undefined);
      },
      setStatusBarMessage() {},
      showInputBox: async (o) => {
        m.dialogs.inputCalls.push(o);
        const next = m.dialogs.input.length ? m.dialogs.input.shift() : undefined;
        if (typeof next === 'string' && o && o.validateInput) { const bad = o.validateInput(next); if (bad) { m.dialogs.lastInvalid = bad; return undefined; } }
        return next;
      },
      showQuickPick: async (items, o) => { m.dialogs.pickCalls.push({ items, o }); return m.dialogs.pickChoice ? m.dialogs.pickChoice(items, o) : undefined; },
      showSaveDialog: async () => null, showOpenDialog: async () => undefined,
    },
  };
  const orig = Module._load;
  Module._load = function (req, ...a) { return req === 'vscode' ? vscode : orig.call(this, req, ...a); };
  m.vscode = vscode; m.Uri = Uri;
  m.makeContext = (dir) => ({
    subscriptions: [], globalStorageUri: Uri.file(dir), extensionUri: Uri.file(path.resolve(__dirname, '..')),
    globalState: { get: (k, d) => (m.state.has(k) ? m.state.get(k) : d), update: async (k, v) => { m.state.set(k, v); } },
    secrets: {
      get: async (k) => { m.secretCalls.push(['get', k]); return m.secrets.get(k); },
      store: async (k, v) => { m.secretCalls.push(['store', k]); m.secrets.set(k, v); },
      delete: async (k) => { m.secretCalls.push(['delete', k]); m.secrets.delete(k); },
    },
  });
  return m;
}

module.exports = { createMock };
