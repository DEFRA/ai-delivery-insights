# AI Delivery Insights

See what your GitHub Copilot chat history cost, by session, prompt, workspace and repo. Everything is read from files already on your machine. Nothing is uploaded and nothing is sent anywhere, unless you turn on the optional Azure DevOps feature, and then only counts and totals go to your own organisation.

## What you get

- **Totals** for credits (with a dollar estimate), prompts, sessions and tokens.
- **Activity over time**, stacked by workspace, plus a calendar heatmap.
- **Date range**: quick ranges (7, 30, 90 days, all time) or a custom **From** and **To**. **To** is optional and defaults to today.
- **Where the work happened**: each workspace with its repo and branch, and prompts grouped by type (bug fix, tests, refactor and so on).
- **Sessions and prompts**: expand a session to see every prompt, the files involved, the model, and what it cost.
- **Costliest prompts**, filters for workspace, model and type, free-text search, CSV export of the selected date range, and a status bar total.
- **User stories**: tag a whole session, or a single prompt, with the story it was for, and see credits and tokens per story. See [User stories](#user-stories).
- **Lifecycle phase**: every prompt is marked as plan, analysis, build, test, bug fix and so on, so you can see where the credits went across the life of the work. See [Lifecycle phase](#lifecycle-phase).
- **Azure DevOps (optional, off by default)**: import stories from your backlog, capture the **effort without AI** for a story, and sync its AI usage and effort to a Task under it, without duplicates. See [Azure DevOps](#azure-devops-optional).
- **Pages you can go into and come back from**: Dashboard, Stories, a Story, a Session, a Prompt, with a breadcrumb, a Back button and keyboard shortcuts. Open any page in a new tab.

## Install from a .vsix (no Node.js needed)

Until the extension is published you install it from a file. **You do not need Node.js, npm or Git**: the `.vsix` is a ready-made package of plain JavaScript, and VS Code runs it with its own built-in runtime. Node.js is only needed by whoever builds the file.

1. Get `ai-delivery-insights-X.Y.Z.vsix` from the repository's Releases page (or a CI run's artifact, or whoever built it), and check its SHA-256 against `SHA256SUMS`.
2. In VS Code (1.90 or newer) open the Extensions view, choose the `...` menu, then **Install from VSIX...**, and pick the file. Or run `code --install-extension ai-delivery-insights-X.Y.Z.vsix`.
3. Run **AI Delivery Insights: Open Dashboard**.

The full guide, including checksums, updating, where your tags are stored and what to do when it is published, is in `docs/ai-delivery-insights/team-install.md` in the repository.

## Getting started

1. Run **AI Delivery Insights: Open Dashboard** from the Command Palette, or click the credits figure in the status bar.
2. Pick a date range, then click a workspace, model or prompt type to filter.
3. If numbers look empty or wrong, run **AI Delivery Insights: Diagnose**. It lists the folders scanned and the field names found, without any prompt text.

## User stories

Copilot does not record which work item a chat was for, so you tell the extension, and it adds up the cost. Stories stay on your machine. You type the story ID (for example `1234` or `AB#1234`) and a title, or import stories from Azure DevOps if you have turned that on.

1. Run **AI Delivery Insights: Open Stories (cost per user story)** and choose **New story**. Add an optional number of **story points**, a **credit budget** and a **group** (a sprint, feature or epic, as free text).
2. Tag work: on the Stories page, tick sessions under **Sessions without a story** and choose a story; or open a session and pick its story; or open a single prompt and move just that prompt to a different story. A prompt follows its own tag if it has one, otherwise its session's.
3. Read the result: credits, tokens, prompts and sessions per story, credits per prompt and per story point, a roll-up by group, which models and agents were cheapest for the same kind of work, and a few signs of possible waste (cancelled prompts, likely retries, low cache use). These are rules of thumb, not verdicts.

Good to know:

- **Suggestions.** If a session's prompts mention `AB#1234`, `#1234`, `US 1234` and similar, the extension offers a one-click tag or to create that story. It never tags on its own.
- **Budgets.** A story with a credit budget shows a meter and you get one notification when it goes over (turn it off with `aiDeliveryInsights.notifyOnBudget`). Budgets always count all time.
- **Date range.** Story pages show all time by default; one switch makes them follow the dashboard's date range.
- **Export.** Open a story and choose **Export CSV**; the file adds up to the story's total. Every CSV now has story columns.
- **Back up.** **Back Up Stories and Tags (JSON)** saves your stories and tags to a file (no prompt text, no paths); **Restore Stories and Tags from Backup** merges them or replaces what you have. Tags are stored per machine, so use a backup to move them.
- **Keyboard.** Esc or Alt+Left goes back one page. The breadcrumb jumps back several.

## Lifecycle phase

Each prompt is also marked with the kind of work it was in the life of a piece of software: **Analysis**, **Plan & design**, **Build**, **Test**, **Bug fix**, **Review**, **Refactor**, **Docs**, **Release & ops** or **Other**. This is separate from the story: one story can show how its credits split between planning, building and testing.

- **It is a guess, and says so.** It decides from the prompt, in this order: the prompt was sent to the Plan agent; it uses planning words (plan, design, roadmap, trade-offs, acceptance criteria and similar); it uses investigating words (analyse, investigate, root cause, estimate, compare and similar); otherwise the work type it already detects (bug fix, tests, refactor, docs and so on) is mapped to a phase. Anything else is **Other**. Background calls, such as session titles, have no phase.
- **Your choice always wins.** On a session page, set the phase for every prompt in that session at once; on a prompt page or in the prompt list, set one prompt. A phase you set is marked with a dot. Choose **Automatic** to go back to the guess.
- **Where to see it.** A Lifecycle panel on the dashboard, on each story and on each session; a phase filter that narrows the whole dashboard; and "By lifecycle phase" in the efficiency tables. CSV exports have `phase` and `phase_source` columns (guess, your choice, or background).
- Phases you set are stored with your stories and tags, per machine, and included in a backup.

## Azure DevOps (optional)

Off by default. Turn it on only if you want stories from your backlog and your AI usage written back to Azure DevOps. With it off, AI Delivery Insights makes no network request at all.

**What it does**

1. **Import stories** from a project's backlog into the Stories list (number, title, points). If the project has several boards (one per team), choose a **Board** to see only that team's stories; the last board you used for a project is remembered. Nothing is changed in Azure DevOps.
2. **Capture the effort without AI** for a story. It is estimated from the commits for that story in your repository, with every step of the working shown and commits you can untick, or you type the hours yourself. A number you type always wins.
3. **Sync a story.** AI Delivery Insights shows a preview, you confirm, and it creates **one Task under the story** whose description holds a JSON report: credits, tokens and prompt counts by model, agent, lifecycle phase and day, one record per session, and the effort. Sync again and it updates that Task in place: sessions are matched by their ID, so nothing is counted twice, and a sync with nothing new writes nothing. Several developers can sync the same story; each one's sessions are kept and none is removed by someone else.

**What is sent, and what never is.** Counts, credits, tokens, model and agent names, lifecycle phases, dates, session IDs (random IDs with no meaning outside your machine), the effort figures and a random ID for your VS Code installation. Your name only if you turn on `aiDeliveryInsights.ado.shareName`. **Never** prompt text, responses, session titles, file names, paths, repository names or commit messages. It never edits the story, writes comments, sets hour fields or deletes anything, and it only ever contacts `https://dev.azure.com/<your organisation>`.

**Set up**

1. Run **AI Delivery Insights: Azure DevOps: Connect...** and enter your organisation. Read the consent, choose **Turn on**, and pick a project. Cancel at any point and nothing is saved.
2. Sign in with your **Microsoft account** (recommended; AI Delivery Insights keeps nothing, VS Code supplies a short-lived token each time), or use a **personal access token** if your organisation blocks that.
3. Open **Azure DevOps** from the dashboard to test the connection and import stories. The first time, try a throwaway project.

The Azure DevOps settings are read only from your own (user) settings: a repository's `.vscode/settings.json` cannot turn the feature on or point it elsewhere. In a workspace you have not trusted, Azure DevOps and git reading are off.

**How the personal access token is stored (fallback only)**

- It is typed into a password box and stored in **VS Code's secret storage** only. It is never written to your settings, the stories file, a backup, a CSV, the cache or a log, and the dashboard never receives it. It is read from secret storage only at the moment a request is made.
- VS Code encrypts secret storage with your operating system's credential store (macOS Keychain, Windows DPAPI, or on Linux GNOME Keyring or KWallet). That protects the saved value on disk. It does **not** stop other software running as you from asking for it, and **other installed extensions are not sandboxed**. On Linux without a keyring the protection is close to none: use Microsoft sign-in there.
- Create the token for **one organisation**, with only the **Work Items: Read & write** scope and a short expiry. Adding **Project and Team: Read** is optional: without it AI Delivery Insights cannot list your projects, so it asks you to type the project name instead, and the Board filter on the Import page is hidden. Microsoft recommends Entra sign-in over personal access tokens and is retiring tokens that cover all organisations; check Microsoft's current notice.
- **Azure DevOps: Remove Stored Token** deletes it from this computer. **Azure DevOps: Disconnect (turn off)** deletes it and turns the feature off. To stop a token that may have leaked from working anywhere, **revoke** it in Azure DevOps (User settings, Personal access tokens); removing it here does not revoke it.

Full details, the report format, the sync rules and the effort method are in `docs/ai-delivery-insights/ado-integration.md` in the repository.

**The effort estimate** is a rule of thumb, not a measurement. It finds commits by story number, by branch name, or (weakest) by time; counts lines added plus half the lines deleted, code and tests separately, ignoring documentation, lock files and generated files; turns them into hours using rates you can change (150 code lines and 250 test lines a day, 8-hour days, 25% overhead, and 0.25 hours for each file touched); and shows a range of 70% to 150% with a confidence level. Use it to compare stories with each other, not to bill anyone.

## Several windows

Each VS Code window runs its own copy of the extension, but they share one scan cache and one stories file on the machine.

- **This workspace** means the workspace of the window you are in: a folder, or a `.code-workspace` file. A window opened on a `.code-workspace` file does not show a member folder's numbers. A window with no Copilot history yet gets a disabled button saying so, rather than another window's numbers. Remote windows (WSL, SSH, containers) are matched by their exact address.
- **Edits are not lost.** Before every change, a window re-reads the shared stories file, and it refreshes when you switch to it or to an AI Delivery Insights tab. A story or tag made in one window shows up in the other without a rescan. If the file is damaged, the window keeps what it has, copies the damaged file aside and rewrites it on your next change.
- **The status bar** is one figure for the machine by default, with a tooltip that names the window and shows both the all-workspaces and this-window figures. Set `aiDeliveryInsights.statusBarScope` to `thisWindow` to show this window's workspace in the bar.
- **Budget notifications** appear only in the window you are looking at.
- Two saves in the same few milliseconds can still lose one edit; the extension does not use a lock.

## How accurate are the numbers?

Each prompt carries a label:

| Label | Meaning |
| --- | --- |
| **billed** | Cost taken from Copilot's own record for that request (`copilotCredits` in the chat log, or the per-call figure in the debug log). It is already worked out for the model and reasoning effort used. Trust this one. |
| **tokens** | Real token counts, priced from model rates you can edit in settings. |
| **~ est.** | Guessed from text length. A rough what-if figure. |

Copilot billed premium requests rather than credits before 1 June 2026, so older history can only be estimated.

## Where the data comes from

| File | Used for |
| --- | --- |
| `workspaceStorage/<id>/chatSessions/*.json`, `*.jsonl` | Prompts, models, timestamps, files, tool calls |
| `workspaceStorage/<id>/workspace.json` | Which folder or `.code-workspace` a session belongs to |
| `workspaceStorage/<id>/GitHub.copilot-chat/debug-logs/` | Tokens and billed credits per model call (when Copilot kept them) |
| `globalStorage/emptyWindowChatSessions` | Chats from windows with no folder open |
| `.git/HEAD` and `.git/config` in your workspace folders | Branch and remote name (credentials removed) |
| Your repositories' git history, through read-only `git` commands (only for the effort estimate, only if you ask) | Which commits belong to a story and how many lines they changed. Commit text is shown to you and not saved or sent |

These are Copilot's internal files. Their format is not a public API and changes between releases, so the extension reads several layouts and says so when it falls back to an estimate.

## Settings

| Setting | Purpose |
| --- | --- |
| `aiDeliveryInsights.monthlyAllowanceCredits` | Credits included in your plan (1 credit = $0.01) to show a monthly meter. |
| `aiDeliveryInsights.pricing` | Fallback USD per 1M tokens, by model name. |
| `aiDeliveryInsights.extraDataDirs` | More VS Code `User` folders to scan, such as a backup or another profile. |
| `aiDeliveryInsights.showStatusBar` | Show or hide the status bar figure. |
| `aiDeliveryInsights.notifyOnBudget` | Notify once when a story goes over its credit budget (default on). |
| `aiDeliveryInsights.statusBarScope` | Status bar figure: `allWorkspaces` (default) or `thisWindow` (this window's workspace only). |
| `aiDeliveryInsights.ado.enabled` | The Azure DevOps switch. Off by default. Your own settings only. |
| `aiDeliveryInsights.ado.organization`, `ado.project`, `ado.authMethod` | Which organisation and default project, and `microsoft` or `pat` sign-in. Your own settings only. |
| `aiDeliveryInsights.ado.storyTypes` | Work item types listed as stories (default User Story, Product Backlog Item, Requirement, Issue). |
| `aiDeliveryInsights.ado.shareName` | Put your name in the report next to your sessions (default off). |
| `aiDeliveryInsights.effort.prodLinesPerDay`, `testLinesPerDay`, `hoursPerDay`, `overheadPercent`, `hoursPerPoint` | The assumptions behind the effort estimate. |

## Commands

| Command | What it does |
| --- | --- |
| AI Delivery Insights: Open Dashboard | Opens the dashboard. |
| AI Delivery Insights: Open Stories (cost per user story) | Opens the Stories page. |
| AI Delivery Insights: Open a Story... | Pick a story and open it. |
| AI Delivery Insights: Export a Story as CSV... | Pick a story and save its CSV. |
| AI Delivery Insights: Back Up Stories and Tags (JSON) | Save stories and tags to a file. |
| AI Delivery Insights: Restore Stories and Tags from Backup... | Merge or replace from a backup file. |
| AI Delivery Insights: Rescan Copilot History, Export Usage as CSV, Diagnose | Re-read history; export the selected range; show what was found. |
| AI Delivery Insights: Azure DevOps: Connect... | The opt-in wizard (organisation, sign-in, consent). |
| AI Delivery Insights: Azure DevOps: Import Stories from the Backlog... | Opens the Import page. |
| AI Delivery Insights: Azure DevOps: Set Personal Access Token (fallback)... | Store or replace a token in secret storage. |
| AI Delivery Insights: Azure DevOps: Remove Stored Token | Delete the stored token. |
| AI Delivery Insights: Azure DevOps: Disconnect (turn off) | Turn the feature off and delete the stored token. Your stories stay. |

## Privacy

The extension collects no telemetry. By default it makes no network requests. If you turn on Azure DevOps it contacts `https://dev.azure.com/<your organisation>` and nowhere else, when you ask it to, with the data described above and never prompt text. If you use the effort estimate it runs `git` on your repositories, read-only, and sends nothing from it except line and file counts. It keeps a local cache in VS Code's extension storage, which includes short excerpts of your prompts, and a second file with the stories, tags and phases you create. CSV exports also contain prompt excerpts, so treat them like the chat history they came from. A story backup file contains no prompt text. Spreadsheet formulas in prompts or titles are neutralised in CSV files.

## Limits

- Chats from remote windows (WSL, SSH, containers) may live on the remote machine. Point `aiDeliveryInsights.extraDataDirs` at that folder to include them.
- Prompt types and lifecycle phases are keyword guesses from the prompt text; set a phase by hand when the guess is wrong. Whether prompts sent to the Plan agent are recognised has not yet been checked against real data: if they show as Other, run **Diagnose** and report it.
- The Azure DevOps feature has been tested against a stand-in for the service and has not yet been run against a real organisation: try it in a throwaway project first. The sensitive parts (git, network, secrets, settings) had an independent security review before this release, but that review ran on Linux against a mocked VS Code; Windows and macOS behaviour of the git reader has not been checked.
- The effort estimate is an assumption-based rule of thumb. It needs `git` on this machine and a local repository; otherwise type the hours.
- Stories and tags live on the machine where you made them. Waste signals and "what works cheaply" tables are hints: prompts differ in size, and a table row needs at least three prompts.
