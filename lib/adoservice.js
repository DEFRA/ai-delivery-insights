'use strict';
/**
 * What the Azure DevOps pages do, without VS Code: test the connection, list the backlog, import stories, find a story's
 * commits and estimate its traditional effort, and preview and apply a sync.
 *
 * Everything the outside world supplies comes in through `deps`, so this file can be tested end to end against a stand-in
 * Azure DevOps and real git repositories. The extension (extension.js) supplies the sign-in, settings, trust state and the
 * store; the pages only ever send small requests (a story ID, a project name, a list of numbers) and get plain data back.
 *
 * Two rules matter most:
 *   - A sync is confirmed against a plan the extension itself holds. The page confirms with a plan ID and cannot supply,
 *     alter or add to what is sent; what the person previewed is exactly what is written (or the sync stops and says so).
 *   - Nothing here reads a token. The client gets its token from `deps.client()` for each request and this file never sees it.
 */

const crypto = require('crypto');
const Core = require('../media/story-core.js');
const Ado = require('./ado.js');
const U = require('./usage.js');
const E = require('./effort.js');
const Git = require('./gitlog.js');
const { cleanText } = require('./text.js');

const LIMITS = { plans: 20, planMs: 15 * 60 * 1000, caches: 10, cacheMs: 30 * 60 * 1000, previewChars: 300000, attempts: 3, backlog: 200, ids: 200 };
const SESSION_WINDOW = { before: 10 * 60 * 1000, after: 60 * 60 * 1000 }; // time around a session in which your commits count as "made during it"
const fail = (error, extra) => ({ ok: false, error, ...(extra || {}) });
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

class Conflict extends Error {}

/**
 * @param {object} deps
 * @param {() => object} deps.settings        { enabled, organization, project, storyTypes, shareName, effort }
 * @param {() => boolean} deps.trusted        false in a workspace the person has not trusted
 * @param {() => Promise<object>} deps.client the Azure DevOps client (lib/ado.js createClient)
 * @param {() => Promise<object|null>} deps.data   the scan result (sessions, workspaces), scanning first if needed
 * @param {() => object} deps.store           the current story store
 * @param {(op:object) => {ok:boolean, error?:string, message?:string}} deps.commit   apply and save an edit to the store
 * @param {() => {id:string, displayName:string}} deps.contributor
 * @param {() => Array<{path:string,label:string}>} [deps.currentRepos]
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.random]
 * @param {Function} [deps.collect]           for tests
 * @param {(line:string) => void} [deps.log]
 */
function createService(deps) {
  const now = deps.now || (() => Date.now());
  const random = deps.random || (() => crypto.randomUUID());
  const collect = deps.collect || Git.collect;
  const log = deps.log || (() => {});
  const plans = new Map();
  const caches = new Map();
  const syncing = new Set();          // stories with a write in progress, so two plans for one story cannot both create a Task
  let backlog = new Map();
  let backlogOrg = '';
  const rowCache = new WeakMap();

  /* ------------------------------ helpers ------------------------------ */

  const trustGate = () => (deps.trusted() ? null : fail('This is not available in Restricted Mode. Trust this workspace first (Manage Workspace Trust).'));
  function adoGate() {
    const s = deps.settings();
    if (!s.enabled) { return fail('Azure DevOps is turned off. Use "AI Delivery Insights: Azure DevOps: Connect" first.'); }
    const t = trustGate();
    if (t) { return t; }
    if (!Ado.parseOrganization(s.organization).ok) { return fail('No Azure DevOps organisation is set. Use "AI Delivery Insights: Azure DevOps: Connect".'); }
    return null;
  }
  /** The organisation requests go to right now, in the form it is compared in (lower case). */
  const orgNow = () => { const o = Ado.parseOrganization(deps.settings().organization); return o.ok ? String(o.org).toLowerCase() : ''; };
  async function guard(fn) {
    try { return await fn(); } catch (e) {
      if (e instanceof Ado.AdoError) { log(`${e.kind}: ${e.message}`); return fail(e.message, { kind: e.kind }); }
      log('Unexpected error: ' + (e && e.stack || e));
      return fail('Something unexpected went wrong. See the "AI Delivery Insights" output for details.');
    }
  }
  function storyOf(id) {
    const store = deps.store();
    return typeof id === 'string' && Core.hasOwn(store.stories, id) ? store.stories[id] : null;
  }
  function linkOf(storyId) { const store = deps.store(); return Core.hasOwn(store.ado, storyId) ? store.ado[storyId] : null; }
  function rowsFor(data, store, storyId) {
    let all = rowCache.get(data);
    if (!all) { all = Core.buildRows(data).rows; rowCache.set(data, all); }
    const g = Core.groupByStory(all, store);
    return g.byStory.get(storyId) || [];
  }
  function keep(map, key, value, max, ttl) {
    const t = now();
    for (const [k, v] of map) { if (t - v.createdAt > ttl) { map.delete(k); } }
    while (map.size >= max) { map.delete(map.keys().next().value); }
    map.set(key, { ...value, createdAt: t });
  }
  const live = (map, key, ttl) => { const v = typeof key === 'string' ? map.get(key) : null; return v && now() - v.createdAt <= ttl ? v : null; };

  /* ------------------------------ connection ------------------------------ */

  const service = {
    status() {
      const s = deps.settings();
      return {
        enabled: !!s.enabled, trusted: deps.trusted(), organization: s.organization || '', project: s.project || '', storyTypes: s.storyTypes || Ado.DEFAULT_STORY_TYPES,
        shareName: !!s.shareName, effort: E.normalizeSettings(s.effort),
      };
    },

    /**
     * Try the connection: list the projects the signed-in person can see.
     * A personal access token that was created with only the Work Items permissions cannot list projects (that needs
     * "Project and Team: Read"), and the refusal looks the same as a bad token. So when the list is refused and a default project
     * is set, one story is read from that project instead: if that works, the token is good and the project is used as typed.
     */
    test() {
      return guard(async () => {
        const g = adoGate(); if (g) { return g; }
        const client = await deps.client();
        let projects = null;
        let refused = null;
        try { projects = (await client.listProjects()).map((p) => p.name); } catch (e) {
          if (!(e instanceof Ado.AdoError) || !['auth', 'forbidden', 'notfound'].includes(e.kind)) { throw e; }
          refused = e;
        }
        if (refused) {
          const project = deps.settings().project;
          if (!Ado.validProject(project)) {
            return fail(`${refused.message} If you use a personal access token, it may be missing the "Project and Team: Read" permission: add it, or set "aiDeliveryInsights.ado.project" to the name of your project and test again.`, { kind: refused.kind, needsProject: true });
          }
          await client.listStories({ project, top: 1 });   // a refusal here is the real answer and is reported as it is
          const who = await client.whoAmI();
          return { ok: true, organization: client.org, projects: [project], projectsListed: false, user: who ? { name: who.name } : null };
        }
        const who = await client.whoAmI();
        return { ok: true, organization: client.org, projects, projectsListed: true, user: who ? { name: who.name } : null };
      });
    },

    /** The boards (one per team) of a project, for the filter on the import page. Failing here never blocks the import page. */
    listBoards(a) {
      return guard(async () => {
        const g = adoGate(); if (g) { return g; }
        const project = a && a.project;
        if (!Ado.validProject(project)) { return fail('Choose a project first.'); }
        const client = await deps.client();
        const teams = await client.listTeams(project);
        return { ok: true, project, boards: teams.map((t) => ({ id: t.id, name: t.name })) };
      });
    },

    /** Stories on a project's backlog, for the import page. With a board (a team's ID), only the stories in that board's area paths. */
    listBacklog(a) {
      return guard(async () => {
        const g = adoGate(); if (g) { return g; }
        const project = a && a.project;
        if (!Ado.validProject(project)) { return fail('Choose a project first.'); }
        const board = a && a.board ? a.board : '';
        if (board && !Ado.validTeamId(board)) { return fail('That is not a board.'); }
        const client = await deps.client();
        const types = (deps.settings().storyTypes || []).filter(Ado.validTypeName);
        const areaPaths = board ? await client.getTeamAreaPaths(project, board) : undefined;
        const items = await client.listStories({ project, types: types.length ? types : undefined, top: LIMITS.backlog, areaPaths });
        const have = new Set(Object.values(deps.store().stories).map((x) => Core.adoIdOf(x)).filter((x) => x != null));
        backlog = new Map(items.map((it) => [it.id, it]));
        backlogOrg = orgNow();
        return {
          ok: true, project, board, truncated: items.length >= LIMITS.backlog,
          items: items.map((it) => ({ id: it.id, title: it.title, type: it.type, state: it.state, points: it.points, iteration: it.iteration, imported: have.has(it.id) })),
        };
      });
    },

    /** Import stories chosen on the import page (only ones this extension listed in the last backlog call). */
    importStories(a) {
      return guard(async () => {
        const g = adoGate(); if (g) { return g; }
        if (backlogOrg !== orgNow()) { return fail('The list was read from another organisation. Open the Import page again.'); }
        const ids = (a && Array.isArray(a.ids) ? a.ids : []).filter((x) => Number.isInteger(x) && backlog.has(x)).slice(0, LIMITS.ids);
        if (!ids.length) { return fail('Choose at least one story from the list.'); }
        const items = ids.map((id) => { const it = backlog.get(id); return { id: it.id, title: it.title, points: it.points, project: it.project, type: it.type, state: it.state, iteration: it.iteration }; });
        const r = deps.commit({ type: 'adoImport', items, org: backlogOrg });
        return r.ok ? { ok: true, message: r.message } : fail(r.error);
      });
    },

    /** Read a story again from Azure DevOps and remember its state. */
    refreshStory(a) {
      return guard(async () => {
        const g = adoGate(); if (g) { return g; }
        const story = storyOf(a && a.storyId);
        if (!story) { return fail('That story does not exist.'); }
        const adoId = Core.adoIdOf(story);
        if (adoId == null) { return fail('This story has no Azure DevOps ID yet. Edit the story and enter it.'); }
        const client = await deps.client();
        const item = await client.getStory(adoId);
        if (!item) { return fail(`Azure DevOps has no work item ${adoId} in ${client.org}, or you cannot see it.`); }
        const old = linkOf(story.id);
        const moved = old && old.org && old.org !== orgNow();   // the story was linked in another organisation: what was synced there says nothing about this one
        deps.commit({
          type: 'adoRecord', storyId: story.id,
          link: { org: orgNow(), adoId, project: item.project, type: item.type, state: item.state, iteration: item.iteration, fetchedAt: now(), ...(moved || (old && old.adoId && old.adoId !== adoId) ? { taskId: null, hash: '', syncedAt: 0, sessions: [] } : {}) },
        });
        return { ok: true, item: { id: item.id, title: item.title, type: item.type, state: item.state, project: item.project, iteration: item.iteration, points: item.points } };
      });
    },

    /* ------------------------------ effort ------------------------------ */

    /** Find the commits that belong to a story and show how the estimate would count them. Reads git only; nothing is sent anywhere. */
    effortFind(a) {
      return guard(async () => {
        const t = trustGate(); if (t) { return t; }
        const story = storyOf(a && a.storyId);
        if (!story) { return fail('That story does not exist.'); }
        const data = await deps.data();
        if (!data) { return fail('Copilot history has not been read yet. Wait for the scan to finish and try again.'); }
        const store = deps.store();
        const rows = rowsFor(data, store, story.id);

        // repositories of the workspaces the story's sessions belong to, with the times you were working in each
        const byRepo = new Map();
        const sessionSpans = new Map();
        for (const r of rows) {
          if (r.ov || !r.ts) { continue; }
          const sp = sessionSpans.get(r.s.id) || { ws: r.s.wsKey, from: Infinity, to: -Infinity };
          sp.from = Math.min(sp.from, r.ts); sp.to = Math.max(sp.to, r.ts);
          sessionSpans.set(r.s.id, sp);
        }
        for (const sp of sessionSpans.values()) {
          const ws = data.workspaces && Core.hasOwn(data.workspaces, sp.ws) ? data.workspaces[sp.ws] : null;
          if (!ws || !ws.local) { continue; }
          for (const repo of ws.repos || []) {
            if (!repo || typeof repo.path !== 'string') { continue; }
            const e = byRepo.get(repo.path) || { path: repo.path, label: repo.name || repo.path, windows: [] };
            e.windows.push({ from: sp.from - SESSION_WINDOW.before, to: sp.to + SESSION_WINDOW.after });
            byRepo.set(repo.path, e);
          }
        }
        if (!byRepo.size && deps.currentRepos) { for (const r of deps.currentRepos()) { byRepo.set(r.path, { path: r.path, label: r.label, windows: [] }); } }
        if (!byRepo.size) { return fail('No local git repository was found for this story. Its sessions belong to workspaces that are remote or have no repository here. Enter the hours by hand.'); }

        const found = await collect({ repos: [...byRepo.values()], ids: { adoId: Core.adoIdOf(story), localId: story.id } });
        const cacheId = random();
        keep(caches, cacheId, { storyId: story.id, commits: found.commits }, LIMITS.caches, LIMITS.cacheMs);
        const settings = deps.settings().effort;
        const labels = found.repos.map((r) => r.label);
        const est = E.estimate({ commits: found.commits, settings, points: story.points });
        return {
          ok: true, cacheId, notes: found.notes, repos: found.repos.map((r) => ({ label: r.label, ok: r.ok, error: r.error })),
          commits: found.commits.map((c) => ({ key: c.key, short: c.short, date: c.date, subject: c.subject, match: c.match, repo: labels[c.repo] || '', added: c.added, deleted: c.deleted, ...E.summarizeCommit(c) })),
          selected: found.commits.map((c) => c.key), estimate: est, current: Core.hasOwn(store.efforts, story.id) ? store.efforts[story.id] : null,
        };
      });
    },

    /** Recalculate for the commits that are ticked. */
    effortCompute(a) {
      return guard(async () => {
        const t = trustGate(); if (t) { return t; }
        const story = storyOf(a && a.storyId);
        if (!story) { return fail('That story does not exist.'); }
        const cache = live(caches, a && a.cacheId, LIMITS.cacheMs);
        if (!cache || cache.storyId !== story.id) { return fail('That list of commits has expired. Open the effort page again.'); }
        const keys = new Set(cache.commits.map((c) => c.key));
        const selected = (Array.isArray(a.selected) ? a.selected : []).filter((k) => typeof k === 'string' && keys.has(k));
        return { ok: true, estimate: E.estimate({ commits: cache.commits, selected, settings: deps.settings().effort, points: story.points }) };
      });
    },

    /** Store the estimate for the ticked commits as the story's effort. */
    effortSave(a) {
      return guard(async () => {
        const t = trustGate(); if (t) { return t; }
        const story = storyOf(a && a.storyId);
        if (!story) { return fail('That story does not exist.'); }
        const cache = live(caches, a && a.cacheId, LIMITS.cacheMs);
        if (!cache || cache.storyId !== story.id) { return fail('That list of commits has expired. Open the effort page again.'); }
        const keys = new Set(cache.commits.map((c) => c.key));
        const selected = (Array.isArray(a.selected) ? a.selected : []).filter((k) => typeof k === 'string' && keys.has(k));
        const est = E.estimate({ commits: cache.commits, selected, settings: deps.settings().effort, points: story.points });
        if (!est.ok) { return fail(est.reason); }
        const rec = E.toEffortRecord(est, now(), `Estimated from ${est.inputs.commits} ${est.inputs.commits === 1 ? 'commit' : 'commits'}.`);
        const r = deps.commit({ type: 'setEffortEstimate', storyId: story.id, effort: rec });
        return r.ok ? { ok: true, message: r.message, estimate: est } : fail(r.error);
      });
    },

    /* ------------------------------ sync ------------------------------ */

    /** Work out what a sync would write and hold it as a plan. Writes nothing to Azure DevOps. */
    syncPreview(a) {
      return guard(async () => {
        const g = adoGate(); if (g) { return g; }
        const story = storyOf(a && a.storyId);
        if (!story) { return fail('That story does not exist.'); }
        const built = await build(story);
        if (built.error) { return fail(built.error); }
        if (built.nothing) { return { ok: true, nothing: true, message: 'This story has no sessions tagged to it and no effort recorded, so there is nothing to sync yet.' }; }
        const planId = random();
        keep(plans, planId, { storyId: story.id, ...built }, LIMITS.plans, LIMITS.planMs);
        const rep = built.merge.report;
        const text = U.stringify(rep);
        const cap = LIMITS.previewChars;
        return {
          ok: true, planId, changed: built.merge.changed, creating: !built.task, replacesUnreadable: built.replacesUnreadable,
          target: { adoId: built.adoId, title: built.adoStory.title, type: built.adoStory.type, state: built.adoStory.state, project: built.adoStory.project, taskId: built.task ? built.task.id : null, duplicates: built.duplicates },
          changes: built.merge.changes, effortChange: built.merge.effort, totals: rep.totals, effort: rep.traditional_effort,
          contributors: rep.contributors.map((c) => ({ id: c.contributor_id.slice(0, 12), sessions: c.sessions.length, mine: c.contributor_id === deps.contributor().id })),
          json: text.length > cap ? text.slice(0, cap) : text, jsonTruncated: text.length > cap, htmlLength: built.html.length,
        };
      });
    },

    /** Write the planned report: create the tracking Task, or replace its description. */
    syncApply(a) {
      return guard(async () => {
        const g = adoGate(); if (g) { return g; }
        const story = storyOf(a && a.storyId);
        if (!story) { return fail('That story does not exist.'); }
        const plan = live(plans, a && a.planId, LIMITS.planMs);
        if (!plan || plan.storyId !== story.id) { return fail('This preview has expired. Open the sync page again.', { expired: true }); }
        if (plan.org !== orgNow()) { return fail('You are connected to a different Azure DevOps organisation now. Nothing was written. Open the sync page to review it again.', { expired: true }); }
        if (plan.applying || syncing.has(story.id)) { return fail('This sync is already running.'); }
        plan.applying = true; syncing.add(story.id);
        try {
          let cur = plan;
          let result = null;
          if (!cur.merge.changed) { result = { taskId: cur.task ? cur.task.id : null, created: false, noop: true, merge: cur.merge }; }
          // A Task is created, or a description replaced, in the work item this story points at. The person's own click on the page is
          // not proof enough when the target is new or has changed since the last confirmed sync (a page could have changed the story's
          // number), so the extension asks itself, in a window of its own, naming where the report will go.
          if (!result && deps.confirmWrite) {
            const l = linkOf(story.id);
            const known = !!(l && plan.task && l.org === plan.org && l.adoId === plan.adoId && l.taskId === plan.task.id);
            if (!known) {
              const ok = await deps.confirmWrite({ org: plan.org, project: plan.adoStory.project, adoId: plan.adoId, title: plan.adoStory.title, creating: !plan.task, taskId: plan.task ? plan.task.id : null });
              if (!ok) { return fail('Cancelled. Nothing was written.', { cancelled: true }); }
            }
          }
          const client = await deps.client();
          for (let attempt = 0; !result && attempt < LIMITS.attempts; attempt++) {
            try {
              let written, created = false;
              if (!cur.task) {
                const fresh = await client.getStory(plan.adoId);
                if (!fresh) { return fail(`Azure DevOps has no work item ${plan.adoId} any more.`); }
                const again = await client.findTrackingTask(fresh);
                if (again.task) { throw new Conflict('created meanwhile'); }
                written = await client.createTrackingTask({ story: fresh, descriptionHtml: cur.html });
                created = true;
              } else {
                written = await client.updateTrackingTask({ task: { id: cur.task.id, rev: cur.task.rev }, descriptionHtml: cur.html });
              }
              result = { taskId: written.id, created, noop: false, merge: cur.merge };
            } catch (e) {
              const conflict = e instanceof Conflict || (e instanceof Ado.AdoError && (e.kind === 'conflict' || (e.kind === 'invalid' && cur.task)));
              if (!conflict) { throw e; }
              if (cur.task && !(e instanceof Conflict) && e.kind !== 'conflict') {
                // an unspecific refusal: only treat it as a conflict if the task really has a newer revision
                const [now1] = await client.getItems([cur.task.id], {});
                if (!now1 || now1.rev === cur.task.rev) { throw e; }
              }
              // somebody else changed the task: read it again and merge again, but only carry on if what THIS machine contributes is what was confirmed
              // The story is read from the store again: its Azure DevOps number may have been changed since the preview was made.
              const current = storyOf(story.id);
              if (!current) { return fail('That story no longer exists. Nothing was written.'); }
              const next = await build(current);
              if (next.error) { return fail(next.error); }
              if (next.nothing) { return fail('There is nothing to sync any more.'); }
              if (next.org !== plan.org || next.adoId !== plan.adoId) { return fail('The story points at a different work item now. Nothing was written. Open the sync page to review it again.', { replan: true }); }
              // a description that has become unreadable since the preview would be replaced, and with it other people's sessions, so it needs a fresh look
              if (next.replacesUnreadable && !plan.replacesUnreadable) { return fail('Someone changed the task description into something AI Delivery Insights cannot read. Nothing was written. Open the sync page to review it again.', { replan: true }); }
              if (next.contribHash !== plan.contribHash) { return fail('Something changed while you were reviewing (the task in Azure DevOps and your own sessions or tags). Nothing was written. Open the sync page to review it again.', { replan: true }); }
              cur = { ...plan, ...next };
              if (!cur.merge.changed) { result = { taskId: cur.task ? cur.task.id : null, created: false, noop: true, merge: cur.merge }; }
            }
          }
          if (!result) { return fail('Azure DevOps kept changing the task while AI Delivery Insights tried to update it. Nothing was lost; try again in a moment.'); }
          const m = result.merge;
          const rec = deps.commit({
            type: 'adoRecord', storyId: story.id,
            link: { org: plan.org, adoId: plan.adoId, project: cur.adoStory.project, type: cur.adoStory.type, state: cur.adoStory.state, iteration: cur.adoStory.iteration, fetchedAt: now(), taskId: result.taskId, hash: m.hashAfter, syncedAt: now(), sessions: cur.syncedIds },
          });
          if (!rec.ok) { log('Could not record the sync locally: ' + rec.error); }
          plans.delete(a.planId);
          const c = m.changes;
          const message = result.noop
            ? 'Azure DevOps already has the latest numbers. Nothing was changed.'
            : `${result.created ? 'Created the AI Delivery Insights task' : 'Updated the AI Delivery Insights task'} #${result.taskId}: ${c.added} new, ${c.updated} updated, ${c.unchanged} unchanged${c.removed ? `, ${c.removed} removed` : ''}.`;
          return { ok: true, message, taskId: result.taskId, created: result.created, noop: result.noop, totals: m.report.totals };
        } finally { plan.applying = false; syncing.delete(story.id); }
      });
    },

    /** The address to open a story's work item (or its tracking task) in the browser. The extension builds it; the page never supplies one. */
    urlFor(a) {
      const s = deps.settings();
      if (!s.enabled || !deps.trusted()) { return null; }
      const org = Ado.parseOrganization(s.organization);
      const story = storyOf(a && a.storyId);
      if (!org.ok || !story) { return null; }
      let id = Core.adoIdOf(story);
      if (a.kind === 'task') {
        // A Task number only means something in the organisation it was made in.
        const l = linkOf(story.id);
        id = l && l.org === org.org.toLowerCase() ? l.taskId : null;
      }
      return Number.isInteger(id) && id > 0 ? `https://dev.azure.com/${encodeURIComponent(org.org)}/_workitems/edit/${id}` : null;
    },
  };

  /** The sessions the store counts for a story (a session tag, or a prompt of the session moved to it), whether or not the scan still has them. */
  function taggedTo(store, storyId) {
    const ids = new Set();
    for (const [sid, st] of Object.entries(store.sessionTags)) { if (st === storyId) { ids.add(sid); } }
    for (const [sid, m] of Object.entries(store.promptTags)) { for (const v of Object.values(m)) { if (v === storyId) { ids.add(sid); break; } } }
    return ids;
  }

  /** Read Azure DevOps and this machine's data and work out the merged report. */
  async function build(story) {
    const adoId = Core.adoIdOf(story);
    if (adoId == null) { return { error: 'This story has no Azure DevOps ID yet. Edit the story and enter it.' }; }
    const data = await deps.data();
    if (!data) { return { error: 'Copilot history has not been read yet. Wait for the scan to finish and try again.' }; }
    const org = orgNow();
    const link = linkOf(story.id);
    if (link && link.org && link.org !== org) {
      return { error: `This story was linked to Azure DevOps in the organisation "${link.org}", but you are connected to "${org}". Check the Azure DevOps number, then press Refresh on the story page to link it to "${org}".` };
    }
    const client = await deps.client();
    const adoStory = await client.getStory(adoId);
    if (!adoStory) { return { error: `Azure DevOps has no work item ${adoId} in ${client.org}, or you cannot see it.` }; }
    const { task, duplicates } = await client.findTrackingTask(adoStory);
    const parsed = task ? U.parseDescription(task.description) : { state: 'none' };
    if (parsed.state === 'refuse') { return { error: parsed.reason }; }
    const remote = parsed.state === 'ok' ? parsed.report : null;
    const store = deps.store();
    const sessions = U.sessionsFromRows(rowsFor(data, store, story.id), store);
    // Sessions this machine wrote earlier are only removed if they are known to have left the story: still in the scan but no longer
    // counted for it, or no longer tagged to it. A session that is simply missing from the scan (history cleared, another profile, a
    // scan that failed) is not evidence that anyone untagged it, so it stays in the report as it was.
    const sameTarget = link && (!link.adoId || link.adoId === adoId);
    const synced = sameTarget ? link.sessions : [];
    const inScan = new Set((data.sessions || []).map((x) => x && x.id));
    const tagged = taggedTo(store, story.id);
    const previouslySynced = synced.filter((id) => inScan.has(id) || !tagged.has(id));
    const retained = synced.filter((id) => !previouslySynced.includes(id));
    const effort = Core.hasOwn(store.efforts, story.id) ? store.efforts[story.id] : null;
    const who = deps.contributor();
    const shareName = !!deps.settings().shareName;
    const merge = U.mergeReport({
      remote, contributorId: who.id, displayName: shareName ? who.displayName : '', sessions, previouslySynced, effort, now: now(),
      adoId, points: adoStory.points != null ? adoStory.points : (story.points != null ? story.points : null),
    });
    if (merge.error) { return { error: merge.error }; }
    if (merge.empty && !remote) { return { nothing: true }; }
    const rendered = U.renderDescription(merge.report);
    if (!rendered.ok) { return { error: rendered.error }; }
    const contribHash = sha(JSON.stringify({ sessions, effort, previouslySynced: previouslySynced.slice().sort() }));
    const syncedIds = [...new Set([...merge.syncedIds, ...retained])].sort();
    return {
      org, adoId, adoStory, task, duplicates, merge, syncedIds, html: rendered.html, contribHash, planHash: U.planHash(rendered.html, task),
      replacesUnreadable: !!task && parsed.state === 'unreadable' && String(task.description || '').trim() !== '',
    };
  }

  return service;
}

module.exports = { createService, LIMITS, SESSION_WINDOW };
