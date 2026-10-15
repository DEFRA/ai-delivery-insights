# Changelog

All notable changes to this extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- **Renamed from Copilot Lens to AI Delivery Insights**, and moved to its own repository. The package name is now `ai-delivery-insights`, commands read **AI Delivery Insights: ...**, and settings use the prefix `aiDeliveryInsights.*` (was `copilotLens.*`). This is a separate extension to VS Code, so an installed Copilot Lens is not upgraded: uninstall it, set your settings again (for example the Azure DevOps organisation), and move your stories with **Back Up Stories and Tags** and **Restore Stories and Tags from Backup**. Backups made by Copilot Lens still restore.
- **Left as they were, for now:** the Azure DevOps Task title ("Copilot Lens usage for #<story>"), its `copilot-lens` tag and the wording inside its description, and the report schema ID (`copilot-lens/story-usage`). Existing Tasks keep being found and updated, and existing reports keep being read. Earlier entries below are kept as they were written, under the old name.

## [0.5.3] - 2026-10-14

### Added
- **Board filter on the Azure DevOps Import page.** A project often has several boards, one per team, and a developer only works on some of them. Choose a **Board** next to the project to list only that team's stories. A board is matched to stories by the area paths of its team, following the team's "include sub-areas" setting. The board you used last for a project is remembered. If the token cannot list teams (it lacks **Project and Team: Read**), the filter is hidden and the whole backlog is listed as before.

### Fixed
- A slow reply for a project or board you had already moved away from could overwrite the list on the Import page. Late replies are now ignored.

## [0.5.2] - 2026-10-14

This is a pre-release version (odd minor). (0.5.1 was not released; its changes are included here.)

### Fixed
- **Credits now match what Copilot billed, for any model and any reasoning effort.** Copilot records the cost of every chat request in the chat log (`copilotCredits`). Copilot Lens ignored it and priced token counts from a flat rate table, which cannot know the model's real rates or the reasoning effort, so totals could be far off. The recorded cost is now used and labelled **billed**; the rate table is only a fallback for a request with no recorded cost. On a real machine this took a 30-day total from 63% of the account figure to within 0.2% of it, with no settings change. The `copilotLens.pricing` setting is no longer needed for this.
- **A long-running chat session could be silently dropped entirely, losing every prompt and credit in it.** VS Code trims old lines from a session's mutation log once it grows large, which could remove the log's opening snapshot. The scanner required that snapshot before it would read anything else in the file, so the whole session vanished rather than being partially read. It now rebuilds whatever the remaining lines still carry instead of discarding the session.
- **Editing `copilotLens.pricing` had no effect until the scan cache was cleared by hand.** The cache keyed each session only by file signature, so a changed price table never invalidated already-cached credits. The cache key now includes the effective pricing table, so **Rescan** picks up a pricing change immediately.

### Changed
- **Custom date range now has an explicit "Show data" step.** Picking a From or To date no longer refilters the dashboard on every change; a "Show data" button (or Enter) commits both dates at once. **Clear** resets the draft and the filter together.
- **The activity heatmap now shows the year** on its first month label and again whenever the grid crosses into a new year, instead of only ever showing a bare month name.

## [0.5.0] - 2026-10-14

This is a pre-release version (odd minor). (0.4.0 was not released; the version moved from 0.3.1 straight to 0.5.0.)

### Added
- **Azure DevOps integration, optional and off by default.** Run **Copilot Lens: Azure DevOps: Connect...** to turn it on for one organisation, after a consent that names the host and what is sent. Sign in with your Microsoft account (nothing is kept) or, as a fallback, a personal access token kept only in VS Code's secret storage. With it off, in an untrusted workspace, or with no organisation set, the extension makes no network request.
- **Import stories** from a project's backlog (number, title, points) into the Stories list. Stories already imported are flagged and not imported twice. A story can carry an **Azure DevOps number**.
- **Many sessions per story, with the story list showing each story's credits and tokens**, plus new columns for effort without AI and Azure DevOps state.
- **Effort without AI** per story. One transparent method (`size-v1`): commits for the story are found in your workspace's git repository by story number, branch name or time; size is lines added plus half the lines deleted (code and tests separately; documentation, lock files, generated and binary files ignored); hours come from rates you can change; the result has a range and a confidence level and the page shows every step and lets you untick commits. If it cannot calculate, or you know better, **type the hours**: a number you type always wins and is replaced only after you confirm.
- **Sync a story to Azure DevOps.** A preview, then your confirmation, creates **one Task under the story** whose description holds a JSON report in the style of GitHub's Copilot usage metrics (credits, tokens and prompt counts by model, agent, lifecycle phase and day, one record per session, and the effort). Syncing again updates that Task in place: sessions are matched by ID so none is counted twice, a sync with nothing new writes nothing, a session is removed only when it is known to have left the story (never just because the scan did not show it), and other developers' sessions are kept. The report holds no prompt text, session titles, file names, paths or repository names. The JSON Schema is published in the repository.
- Four new pages with a Back button and breadcrumb: Azure DevOps (connect), Import, Effort and Sync. Commands: Connect, Import Stories from the Backlog, Set Personal Access Token (fallback), Remove Stored Token, Disconnect.
- Settings `copilotLens.ado.*` and `copilotLens.effort.*`. These, `copilotLens.extraDataDirs` and `copilotLens.pricing` are only read from your own settings, never from a workspace.
- A personal access token that cannot list projects (it has no **Project and Team: Read** permission) still works: the wizard asks for the project name and tests by reading a story from it.

### Security
An independent review of the new code was done before release. Fixed as a result:
- **`git` could be made to run a program named by a cloned repository** through a partial clone's on-demand fetch (`core.sshCommand`). All transports and lazy fetch are now switched off, and `git` is found by an absolute path, never in the repository folder.
- **Megabytes of `<` in a work item or Task description could freeze the extension.** Tags are now removed and the report is found by scans that cost time in proportion to the length of the text.
- **A repository's `.vscode/settings.json` could change which folders are read, the price table and the effort rates.** `extraDataDirs`, `pricing` and the effort rates are now user-level only, and bad price entries are ignored.
- **A session missing from the scan could be removed from a report.** Removal now needs evidence that the session left the story.
- **A write could go to a different organisation or work item than the one reviewed.** Plans and links now carry both, a retry after a conflict re-reads the story, and the extension asks for itself, in a modal window, before writing to a new or changed target.
- A chat session file could write or delete through `__proto__`; a token cut by the 300-character limit before it was scrubbed, or hidden by entities or invisible characters, could remain visible; a restored window could start reading git by itself; removing a token and disconnecting now ask first; export dates are checked and a failed export is reported; the page policy gains `base-uri 'none'` and `form-action 'none'`; and the 51st contributor can no longer be written.
- Not changed, and described in the documentation: the report in Azure DevOps is not signed; a Microsoft sign-in token reaches as far as you do in Azure DevOps; the package check is a tripwire and not a boundary; development tools are a supply-chain surface. The review was done on Linux against a stand-in for the VS Code API.

### Changed
- The extension's privacy statement now reads "no network requests unless you turn on Azure DevOps". `lib/ado.js` is the only code that uses the network, and `lib/gitlog.js` the only code that starts a process (`git`, read-only, no shell). The package check fails the build if either appears anywhere else.
- Untrusted workspaces: the extension now declares `limited` support. The dashboard, stories and tags work as before; Azure DevOps and reading git history are refused.

### Notes
- **Not yet run against a real Azure DevOps organisation or in a real VS Code window.** Everything was tested against a stand-in for the service that follows Microsoft's published REST pages, and against real temporary git repositories. Try the first sync in a throwaway project. Items to confirm are listed in the repository's human checklist (the Microsoft sign-in scope, the connection data call, the parent link, the status Azure DevOps returns when the revision check fails, what a missing field does, and the largest description it accepts).
- The effort figures are assumptions made visible. Use them to compare stories, not to bill.
- A personal access token is stored in VS Code's secret storage. That protects it on disk; it does not stop other software running as you, or other extensions, from asking for it, and on Linux without a keyring the protection is minimal. Prefer Microsoft sign-in. See `docs/copilot-lens/ado-integration.md`.
- Stories files written by 0.5.0 keep working in 0.3.1, which ignores the new fields and drops them the next time it saves. Back up first if you move between versions.

## [0.3.1] - 2026-10-09

This is a pre-release version (odd minor).

### Added
- **Lifecycle phase.** Every prompt gets a phase: Analysis, Plan & design, Build, Test, Bug fix, Review, Refactor, Docs, Release & ops or Other. It is a guess from the prompt (the Plan agent, planning or investigating words, then the work type) and is labelled as a guess. Set a whole session or a single prompt by hand and your choice always wins; set it back to Automatic to return to the guess. A phase is independent of a story, so one story can show how its credits split across plan, build and test.
- Lifecycle panels on the dashboard, a story and a session; a phase filter for the whole dashboard; a phase picker on session and prompt pages; "By lifecycle phase" in the efficiency tables.
- CSV exports gain `phase` and `phase_source` columns (guess, your choice, or background).
- Backups of stories and tags now carry the phases you set by hand. Old backups still restore.
- New setting `copilotLens.statusBarScope`: show the total for all workspaces (default) or for this window's workspace only. The status bar tooltip now names the window and shows both figures.
- A guide for installing from a `.vsix` file without Node.js: `docs/copilot-lens/team-install.md`, and a section in this README.

### Fixed
- **"This workspace" could show the wrong workspace.** A window opened on a `.code-workspace` file could be matched to one of its member folders depending on scan order, so two windows could show the same numbers. A window now matches only its own workspace file or folder, a remote window only its exact remote address, and a window with no chats yet gets a disabled button that says so instead of someone else's numbers. The button names the workspace it applies to.
- **Two windows could overwrite each other's stories.** All windows share one stories file, and the last window to save won. Each window now reloads the file before it writes, and refreshes when you switch to it, when a Copilot Lens tab becomes visible, and when a tab opens. A damaged or missing file never wipes what a window already holds; a damaged file is copied aside first.
- Budget notifications could appear once per open window; only the focused window shows them now.
- The scan cache was written in place, so two windows scanning at once could leave a torn file. It is now written by temporary file and rename.
- Importing a backup into a store that is already full could leave tags that pointed at a story that did not fit.

### Notes
- The first scan after updating is a full one, because the cache format changed.
- Tags live on this machine and are not shared between machines. With two windows open there is still a small chance that two saves in the same few milliseconds lose one edit (no lock is used; see ADR 0011).
- Opening a stories file written by 0.3.1 in 0.3.0 ignores the phases, and saving from 0.3.0 drops them. Back up first if you move between versions.
- Not yet checked against a real VS Code window: that prompts sent to the Plan agent are recognised, and the focus and tab-visibility refresh. Both are covered by tests with stand-ins only. Run **Diagnose** and send the output if the Plan agent shows as Other.

## [0.3.0] - 2026-10-09

This is a pre-release version (odd minor).

### Added
- **User stories.** Create stories (ID, title, optional points, credit budget and group), tag whole sessions or single prompts, and see credits, tokens, prompts and sessions per story. A prompt follows its own tag, otherwise its session's.
- **Drill-down pages**: Dashboard, Stories, Story, Session and Prompt, with a breadcrumb, Back, Esc and Alt+Left, Previous and Next between prompts, and a page you return to after a reload. Any page can be opened in a new tab.
- Bulk tagging of sessions that have no story, with suggestions from story numbers found in prompts (`AB#1234`, `#1234`, `US 1234`). Nothing is tagged without a click.
- Roll-up by group, credits per point, tables of what works cheaply by model, agent and work type, and signs of possible waste (cancelled prompts, likely retries, low cache use, background calls).
- Credit budgets per story with a meter and one notification when a story goes over. New setting `copilotLens.notifyOnBudget`.
- Per-story CSV export that adds up to the story total; all exports gain `story_id`, `story_title` and `story_group` columns.
- Back up and restore stories and tags (no prompt text). New commands: Open Stories, Open a Story, Export a Story as CSV, Back Up Stories and Tags, Restore Stories and Tags from Backup.
- A Stories panel on the dashboard with the top stories.

### Fixed
- **CSV files could run formulas.** A prompt, session title or workspace name that began with `=`, `+`, `-`, `@`, a tab or a carriage return would be treated as a formula when the file was opened in a spreadsheet. Such cells now start with an apostrophe.

### Notes
- Stories are stored on this machine (`stories.json` in the extension's storage). They are never sent anywhere and nothing is read from a work-tracking system.

## [0.2.0] - 2026-10-08

### Added
- Custom date range: pick a **From** and an optional **To** date. Leave **To** empty to include everything up to today.
- CSV export now covers the selected date range, and the suggested file name includes it.
- The Activity heading shows the resolved date window.

### Fixed
- Chart and heatmap day labels could be off by one day around daylight-saving clock changes.
- When From is moved past To (or the reverse), the other date now follows instead of the pair swapping.
- Session-title calls are shown as background calls instead of being added to the first prompt's cost, matching VS Code's own debug panel.

## [0.1.0] - 2026-10-07

### Added
- Dashboard with credits, tokens and prompts by session, workspace, repo, model and prompt type.
- Exact credits from Copilot debug logs where available, with token-priced and estimated fallbacks clearly labelled.
- Status bar total, monthly allowance meter, CSV export, and a Diagnose command.
