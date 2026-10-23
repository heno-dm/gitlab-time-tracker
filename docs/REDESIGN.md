# Timelogs Extension — Redesign Specification

Target repo: `heno-dm/gitlab-time-tracker` (UUID `timelogs-extension@heno-dm.github.io`)
Audience: the implementing agent.
Goal: same feature set, fewer clicks, no needless navigation, GNOME defaults everywhere. Visual design is **not** a goal: use stock Shell `PopupMenu`/`ModalDialog` widgets, stock libadwaita widgets, stock symbolic icons. No custom CSS beyond what is strictly needed for layout.

---

## 0. Design principles (apply to every decision)

1. **Zero-click information.** Anything the user checks often (is a timer running, how long) is visible without opening anything.
2. **One surface for tracking.** Starting, switching, pausing, submitting, discarding and searching all happen inside the top-bar menu. No separate window for picking an issue.
3. **No modal choices that can be inferred.** No "choose project" step during tracking; no "use saved filters" toggle; no confirmation dialogs where an undo is possible.
4. **Stable layout.** The menu never jumps while the user is aiming (cached data rendered first, refreshed in place).
5. **Keyboard parity.** Every action reachable by keyboard; the search entry is focused when the menu is opened by shortcut.
6. **GNOME defaults.** `PopupMenu.PopupMenuItem`, `PopupMenu.PopupSubMenuMenuItem`, `St.Entry`, `St.Button` with `button`/icon styles, `ModalDialog`, `MessageTray` notifications; libadwaita `Adw.PreferencesPage/Group`, `Adw.EntryRow`, `Adw.PasswordEntryRow`, `Adw.ComboRow`, `Adw.SwitchRow`, `Adw.ActionRow`, `Adw.ToastOverlay`, `Adw.SplitButton`, `Adw.ViewStack`, `Adw.WindowTitle`.

---

## 1. Analysis of the current code (what exists today)

### 1.1 Files

| File | Lines | Role today | Verdict |
|---|---|---|---|
| `extension.js` | 863 | Indicator, menu, timer, sessions, Doing queue, HTTP, submit, persistence, keybindings — all in one class | **Split** into core + UI modules |
| `selectorWindow.js` | 673 | Separate GTK4 process (`gjs -m`) for project + issue search; returns result via GSettings key `selection-state` | **Delete** (replaced by in-menu search) |
| `timeEntryDialog.js` | 91 | Shell `ModalDialog` for duration + comment | **Keep, adjust** |
| `state.js` | 121 | Serialization helpers, default project, projects cache, recent issues | **Replace** by `core/` modules |
| `reportWindow.js` | 1022 | Separate GTK4 process, monthly report, GraphQL timelogs, export | **Rewrite UI** with libadwaita, keep data logic |
| `prefs.js` | 218 | Adw preferences | **Rework** |
| `issueSelector.js` | 933 | Old in-Shell selector | **Dead code** — not imported by anything except `po` extraction. Delete |
| `reportDialog.js` | 968 | Old in-Shell report | **Dead code**. Delete |
| `avatarLoader.js` | 156 | Only used by the two dead files | **Dead code**. Delete |
| `tests/regressions.js` | 572 | Loads class bodies by slicing source text and `Function()` | **Replace** with tests that import pure core modules |
| `tests/selector-ui.js` | 78 | Smoke test for selector window | **Delete** with selector |

### 1.2 Current top-bar menu (top → bottom), click/visual problems

```
No active timer | Working on | Paused          (non-reactive heading)
Find another issue…                            (spawns GTK process)
Project: group/app                             (non-reactive)
Issue: #142 - Fix login redi...                (non-reactive, truncated at 40 chars)
Open project in browser
Open issue in browser
─────
00:12:34                         [Submit]
─────
Start | Pause/Resume
Cancel                                         (discards time, no confirm, no undo)
─────
Paused work                                    (heading always shown, even when empty)
  [#98 — title]  00:42:00  [Submit]
─────
My Doing — board order                         (heading)
  Loading…  → replaced after network → list   (layout jumps under the cursor)
  #150 — …
  Find more issues…                            (spawns GTK process)
─────
Monthly Report
Settings
```

Problems:
- ~8 non-actionable rows (headings, "Project:", "Issue:", "No paused work") push actionable items down.
- The active issue is described in three separate places (heading, project label, issue label) and its time in a fourth.
- Elapsed time is invisible without opening the menu (panel shows only an icon).
- "Cancel" destroys tracked time in one click with no undo.
- Doing queue clears to "Loading…" on every menu open → content shifts while the user is aiming. `/user` is re-fetched on every open.
- Searching any other issue spawns a whole GTK process (`gjs`), which (a) costs startup latency, (b) needs a GSettings-based IPC hack (`selection-state` + nonce), (c) moves focus to a different window.
- Changing project requires: menu → *Find another issue…* → *Change project* → search → click.
- After cancelling the submit dialog, the current timer stays **paused** (it was paused before showing the dialog) → user must open the menu again and press *Resume*.

### 1.3 Current selector window problems

- Two panes, a "Change project" toggle, a "Use saved filters" checkbox revealing a filter bar (state dropdown, assignee free text, labels free text), a "Load more issues" button, and three footer buttons (*Open in GitLab*, *Cancel*, *Switch and start*).
- Saved filters (`issue-filter-state/assignee/labels`) are a second, independent definition of "my work" next to `doing-labels` — two concepts for the same thing.
- `issue-filter-search` is written to GSettings on every keystroke but intentionally never restored → useless dconf writes.

### 1.4 Current report window problems

- Loads **all instance users** (`/users?humans=true&active=true`, paginated until the end). On gitlab.com this is effectively unbounded. Users should be derived from the timelog authors already fetched.
- Writes a debug log file to `~/.cache/timelogs-extension-report.log` on every load.
- Non-GNOME controls: `<` / `>` text buttons, bare label month, two export buttons in their own row, a status label used for totals, errors and export paths alike.
- Category filter is editable in both Preferences and the report window (two places for one setting).

### 1.5 Current preferences problems

- URL and token are saved on every keystroke; there is no connection check — the user only learns about a wrong token when something fails later.
- Token setup instructions are a static text block instead of a link that opens the token page.
- Default project can only be **cleared**, not chosen; it is set implicitly by the first issue ever picked.
- Lock behaviour is two interdependent switches (`resume-on-unlock`, `count-time-when-locked`, second disabled unless first on) that encode one three-way choice.
- Shortcut rows accept free text and silently ignore invalid input.
- Token is stored in cleartext GSettings.

### 1.6 Current runtime/logic problems worth fixing during the rewrite

- Elapsed time is computed by `this._elapsedSeconds++` every second → drifts, and is written to dconf every 5 s.
- No HTTP timeout on the Soup session.
- Three near-identical `_apiGet` implementations (extension, selector, report).
- `recent-issues` is written on every submit but never read by live code.

---

## 2. New interaction design

### 2.1 Top bar indicator

`PanelMenu.Button` containing an `St.BoxLayout`:
- `St.Icon` — existing three symbolic icons (idle / running / paused). Keep them.
- `St.Label` — elapsed time of the **active** session in `H:MM` (e.g. `1:23`). Hidden when idle. Uses the panel's default font; no custom styling.

Setting `show-panel-time` (default `true`) hides the label for users who want icon-only.

No click on the indicator other than opening the menu (GNOME default). No middle-click tricks.

### 2.2 Menu layout

```
┌───────────────────────────────────────────────┐
│ [ Search issues or #number…               ]   │ ① SearchSection
├───────────────────────────────────────────────┤
│ #142 Fix login redirect            1:23:45    │ ② ActiveSection (only if a session is active)
│ group/app                                     │
│ [⏸ Pause] [✓ Submit…] [↗] [🗑]                │
├───────────────────────────────────────────────┤
│ Paused                                        │ ③ PausedSection (only if non-empty)
│ #98  Update docs                  0:42   [✓]  │
│ #77  Review MR                    0:05   [✓]  │
├───────────────────────────────────────────────┤
│ Doing                                         │ ④ QueueSection
│ #150 API pagination                           │
│ #151 Rate limit errors                        │
├───────────────────────────────────────────────┤
│ Monthly Report                                │ ⑤ Footer
│ Settings                                      │
└───────────────────────────────────────────────┘
```

When the search entry contains text, sections ②③④ are **hidden** and replaced by:

```
├───────────────────────────────────────────────┤
│ #98  Update docs                  0:42  (paused)  ← local matches first (instant)
│ #150 API pagination                    (doing)
│ #203 Login redirect loop        group/app      ← remote matches (debounced)
│ #204 …                                        
│ Searching… / No results / Error: 401          ← single status row
└───────────────────────────────────────────────┘
```

Rules:
- Section headings are only rendered when the section has items. No "No paused work" placeholder rows.
- Project path is shown as a secondary line **only** when more than one project is tracked (§2.6), otherwise omitted.
- Titles are ellipsized by the label (`clutter_text.ellipsize = END`) at a menu max-width, not truncated in JS at 40 chars.
- Elapsed for paused rows: `H:MM`. Active row: `H:MM:SS`.
- The ⑤ footer has exactly two items. "Settings" calls `extension.openPreferences()`.

### 2.3 Row behaviour (one click = one intent)

| Row | Primary click (row) | Suffix buttons |
|---|---|---|
| Active session | Toggle pause/resume | Pause/Resume (`media-playback-pause-symbolic`/`media-playback-start-symbolic`), Submit (`document-send-symbolic`), Open in browser (`web-browser-symbolic`), Discard (`user-trash-symbolic`) |
| Paused session | **Switch to it** (pause active, resume this) | Submit (`document-send-symbolic`) |
| Doing issue | **Start it** (pause active) | — |
| Search result | Start / switch to it | — (Open in browser via `Ctrl+Enter`, see §2.4) |
| Monthly Report | Open report window | — |
| Settings | Open prefs | — |

All suffix buttons are `St.Button` with `style_class: 'icon-button'` (Shell stock) and `accessible_name` set. All rows close the menu on activation, except Pause/Resume on the active row (keeps the menu open so the user sees the state change).

"Open project in browser" is removed. The issue page links to the project; nobody needs a dedicated row for it.

### 2.4 Keyboard

Global shortcuts (GSettings, unchanged keys and defaults):

| Key | Default | New behaviour |
|---|---|---|
| `toggle-timer-shortcut` | `<Super><Alt>t` | Active session → pause/resume. No active session but paused ones → resume most recent. Nothing → open menu with search focused |
| `stop-send-shortcut` | `<Super><Alt>s` | Open submit dialog for active session |
| `cancel-timer-shortcut` | `<Super><Alt>c` | Discard active session (with undo notification) |
| `select-issue-shortcut` | `<Super><Alt>i` | Open menu, focus search entry |
| `monthly-report-shortcut` | `<Super><Alt>r` | Open report window |

Inside the menu (search entry focused):
- Typing filters immediately.
- `Down`/`Up` moves into the results/menu items (default PopupMenu navigation; make the entry pass `Down` to the first result).
- `Enter` in the entry = activate the first result (start/switch).
- `Ctrl+Enter` on a result row = open that issue in the browser without starting it.
- `Esc` with text = clear text; `Esc` empty = close menu (default).
- `#123` or `123` = exact IID lookup in each tracked project (any state).

Focus handling: on `open-state-changed(open=true)` when opened via the select-issue shortcut **or** by a mouse click, put key focus on the entry with `global.stage.set_key_focus(entry)` (deferred with `GLib.idle_add` so the menu grab is established). Clear the entry text on menu close.

### 2.5 Submit dialog (Shell `ModalDialog`)

```
Submit time
#142 Fix login redirect · group/app

Time spent   [ 1h 23m              ]
Comment      [ What did you do?    ]

                     [Cancel]  [Submit]
```

- Duration prefilled from the session (`formatGitLabDuration`), text fully **selected** so typing replaces it.
- Focus starts in **Comment** (the field the user almost always types into); `Shift+Tab` reaches duration. Enter submits from either field (`default: true` on Submit; also connect `activate` on both `St.Entry.clutter_text`).
- Inline validation under duration (existing regex). Submit disabled while invalid.
- The active timer **keeps running** while the dialog is open. On *Cancel* nothing changes (removes today's "cancel leaves timer paused" extra click).
- On *Submit*: dialog closes immediately; request runs in background; the session row shows a spinner-free "Sending…" subtitle and its buttons are insensitive.
  - Success → session removed. Transient notification "Sent 1h 23m to #142".
  - Failure → session kept untouched. Notification "Couldn't send time to #142: <reason>" with action **Retry** (re-opens dialog prefilled with the same duration/comment) and, for 401/403, **Open Settings**.
- Submitting the active session ends it (same as today). Submitting a paused session leaves the active one alone (same as today).

### 2.6 Projects and the Doing queue

Replace the implicit single "default project" with an explicit list **Tracked projects** (`tracked-projects`, JSON array of serialized projects), set in Preferences (§2.8).

- Doing queue = for each tracked project: `GET /projects/:id/issues?state=opened&assignee_id=<me>&labels=<doing-labels>&order_by=relative_position&sort=asc&per_page=50`. Results concatenated in tracked-project order, each project's issues in board order. Issues that already have a session are excluded (as today). Show at most 15 rows; if more exist, the search entry is the way to get to them (no "Find more…" row).
- Search = for each tracked project in parallel: text → `search=<q>&in=title,description&state=opened&per_page=10`; numeric → `iids[]=<n>` (any state). Merge, local matches first.
- Migration: if `tracked-projects` is empty and old `default-project` is set, seed with it. If still empty, the first issue the user starts via search is impossible (no project) → see first-run (§2.9).

Caching / stability:
- `/user` fetched once per (url, token) and cached in memory (and in `cached-user` GSettings for offline start).
- Queue results cached in memory **and** in `queue-cache` (JSON). On menu open: render cache immediately, refresh in background, then replace rows **in place** only if the list changed. Never show a "Loading…" row when a cache exists.
- If refresh fails and a cache exists: keep cached rows, add one dim status row "Offline — showing last known queue".

### 2.7 Discard with undo (no confirmation dialog)

Discard (button or shortcut):
1. Session removed from state immediately, saved.
2. Notification "Discarded 1:23 on #142" with action **Undo**, transient.
3. Undo restores the exact session object (including running/paused state and accumulated time; if it was running, the gap counts as running time).
4. Undo buffer holds the last discarded session only; cleared after 30 s or next discard.

### 2.8 Preferences (single `Adw.PreferencesPage`)

```
GitLab
  Server URL              [https://gitlab.example.com     (✓ apply)]   Adw.EntryRow, show_apply_button
  Access token            [••••••••••                     (✓ apply)]   Adw.PasswordEntryRow, show_apply_button
  Connection              Connected as Jane Doe (@jane)        [↻]     Adw.ActionRow, status subtitle
  Create access token…    opens browser                         ↗      Adw.ActionRow, activatable

Work
  Tracked projects        group/app, group/lib                   ›     Adw.ActionRow → subpage
  Doing labels            [doing                                 ]     Adw.EntryRow (apply)

Timer
  Show time in top bar    [switch]                                     Adw.SwitchRow
  When the screen locks   [Pause timer ▾]                              Adw.ComboRow
                          Pause timer / Keep counting / Pause and resume on unlock

Keyboard shortcuts                                                ›    Adw.ActionRow → subpage
```

Details:
- URL/token are only written on **apply** (not every keystroke). Apply triggers a `GET /user` check; the Connection row shows `Connected as …` or the error (`Invalid token`, `Server not reachable`, `URL must start with https://`). The refresh button re-runs the check.
- "Create access token…" opens `<url>/-/user_settings/personal_access_tokens?name=Timelogs%20Extension&scopes=api` (GitLab prefills name and scope from query params; for GitLab < 16 fall back to `/-/profile/personal_access_tokens?…`). Disabled until URL is valid.
- Tracked projects subpage (`window.push_subpage(new Adw.NavigationPage(...))`): `Gtk.SearchEntry` on top + list of member projects (`Adw.SwitchRow` per project, title = name, subtitle = `path_with_namespace`, sorted by last activity). Toggle = immediate save. Uses the projects cache, refreshed on open.
- Lock behaviour is one `Adw.ComboRow` stored in a new enum-like string key `lock-behaviour` ∈ `pause` | `keep-counting` | `resume-on-unlock`. Migration from old booleans:
  - `resume-on-unlock=false` → `pause`
  - `resume-on-unlock=true, count-time-when-locked=false` → `resume-on-unlock`
  - `resume-on-unlock=true, count-time-when-locked=true` → `keep-counting`
- Shortcuts subpage: one `Adw.EntryRow` per shortcut with apply button. Invalid input → `add_css_class('error')` on the row and do not save; empty → disable shortcut. (Keep it simple; a key-capture dialog is out of scope.)
- Report category filter is **not** in preferences (it lives in the report window, §2.10).
- Remove the static "Information" text block.

### 2.9 First run / not configured

If URL or token is missing, or the connection check failed with 401/403:
- The menu shows exactly one actionable item **Set up GitLab…** (opens preferences) above the footer. Search, sessions (if any) are still shown so restored time is never hidden.
- If configured but `tracked-projects` is empty: QueueSection shows one row **Choose projects…** that opens preferences on the Tracked projects subpage.

### 2.10 Monthly report window (separate GTK4 + libadwaita process)

Stays a separate process (`gjs -m report/main.js <projectId?>`), because Shell cannot host GTK windows. Rebuild with libadwaita:

```
┌ Adw.HeaderBar ────────────────────────────────────────────────────────────┐
│ [◀] [▶]   Adw.WindowTitle: "October 2026" / "group/app"   [Categories|Calendar]  [Export CSV|▾] [≡] │
└───────────────────────────────────────────────────────────────────────────┘
 Toolbar row (inside content, Gtk.Box):  [Project ▾ (searchable)]  [User ▾]  [Categories filter…]
 ─────────────────────────────────────────
 Summary: Total 86.5 h · 14 issues · 6 categories        (Adw.ActionRow-like labels or a plain Gtk.Label with .title-4)
 Adw.ViewStack
   Categories page: bar list (Gtk.LevelBar or Gtk.ProgressBar rows) + table
   Calendar page:  month grid + table
 Adw.ToastOverlay wraps everything
```

- Month navigation: two header buttons `go-previous-symbolic` / `go-next-symbolic`; next disabled for future months. Also `Alt+Left` / `Alt+Right`.
- View switch: `Adw.ViewSwitcher` (or `Adw.InlineViewSwitcher` if libadwaita ≥ 1.7 is available, otherwise `Adw.ViewSwitcher`) bound to an `Adw.ViewStack` with the two pages. Remember last page in GSettings `report-view`.
- Project: `Gtk.DropDown` with `enable_search: true`. Default order of preference: argv project id (the active session's project) → first tracked project → first membership project.
- User: `Gtk.DropDown` with "Everyone" + the distinct timelog authors of the loaded month (derived from data; **no** `/users` call). Remember last choice by username in `report-user`.
- Categories filter: a `Gtk.MenuButton` (`funnel-symbolic` or `view-more-symbolic` if missing) opening a popover with an `Gtk.Entry` (same comma/regex syntax as today) bound to `report-tags-filter`. Shown in the toolbar as text "Categories: All" / "Categories: 3 filters".
- Columns chooser for the user × category table: keep as is (popover with checkboxes, *Select all* / *Clear*).
- Export: `Adw.SplitButton`. Main click = last-used format (default CSV); dropdown menu contains "Export as CSV" and "Export as Markdown". Files go to Downloads (same names as today). After saving: `Adw.Toast` "Saved gitlab-report-…csv" with button **Open** (`Gio.AppInfo.launch_default_for_uri`). Errors also as toasts.
- Loading: `Adw.Spinner` (libadwaita ≥ 1.6) or `Gtk.Spinner` centered while loading; errors as `Adw.StatusPage` with a **Retry** button.
- Remove the debug log file.
- Keep a small `CALENDAR_CSS` provider for the calendar heat map (day cells tinted with `@accent_bg_color` by share of the busiest day, accent border on today); use `.card` as the base style for day cells and `.dim-label` for empty days.

---

## 3. Click comparison (current → new)

Counting a click as any mouse click or explicit keypress that is not text input. "Menu" = click on the indicator.

| Task | Current | New | Why |
|---|---|---|---|
| See how long I've been working | 1 (menu) | **0** | Time in panel |
| Start an issue from Doing | 2 | 2 | Same, but rows no longer jump while loading |
| Start an issue *not* in Doing | 2 + type + Enter, plus a window launch | **1 + type + Enter**, no window | In-menu search |
| Start an issue in another project | menu → Find… → Change project → type → click project → type → Enter (5+) | **1 + type + Enter** | Search spans tracked projects |
| Switch to paused work | 2 | 2 | Same |
| Pause / resume | 2 | 2 (or **1** shortcut, unchanged) | Row click toggles |
| Submit current time | 3 (menu, Submit, Send) | 3 | Same, but focus lands in Comment and duration is pre-selected |
| Cancel the submit dialog, continue working | Cancel + menu + Resume = 3 | **1** | Timer no longer paused by the dialog |
| Recover from accidental discard | impossible | **1** (Undo) | Undo notification |
| Open current issue in browser | 2 | 2 | Same |
| First setup until first tracked issue | menu → Settings → URL → (browser, navigate to tokens page, fill name, tick `api`, create) → paste → close → menu → Find… → pick project → pick issue | menu → Set up → URL ✓ → Create token (prefilled) → paste ✓ → Tracked projects → toggle → back; then menu → click Doing issue | Prefilled token URL, explicit project choice, connection feedback |
| Export report | 1 | 1 | Split button keeps 1-click default |
| Change report month | 1 | 1 (or `Alt+←/→`) | — |

---

## 4. Architecture

### 4.1 Target file layout

```
extension.js                 enable/disable, keybindings, wiring only (<150 lines)
prefs.js                     preferences (Adw)
core/
  gitlabClient.js            single HTTP/GraphQL client (Soup 3), no UI imports
  config.js                  typed settings access, token storage, migrations
  sessionStore.js            pure timer/session state machine, no GI UI imports
  issueSource.js             Doing queue + search, caching, request supersession
  format.js                  duration formatting/parsing, H:MM formatting
  lockPolicy.js              restore logic per lock-behaviour
ui/
  indicator.js               PanelMenu.Button, icon + panel label
  menuSections.js            Search, Active, Paused, Queue, Results, Footer sections
  submitDialog.js            ModalDialog (from timeEntryDialog.js)
  notifications.js           notify(), notifyWithActions()
report/
  main.js                    Adw.Application entry (gjs -m)
  reportWindow.js            UI
  reportData.js              GraphQL fetch + aggregation (pure aggregation = testable)
  exporters.js               CSV / Markdown builders (pure)
schemas/…gschema.xml
tests/
  run.js                     tiny runner, imports core/*.js and report/{reportData,exporters}.js directly
```

Rule: everything in `core/` and the pure parts of `report/` must import only `GLib`, `Gio`, `Soup` (client only) — no `St`, `Clutter`, `Gtk`, `Adw`, no `resource:///org/gnome/shell/...`. That makes them loadable by plain `gjs -m` in tests and by both processes.

### 4.2 Interfaces

Write them as JSDoc-typed ES modules. Signatures below are the contract; names may be adapted but responsibilities may not be merged back into the UI.

#### `core/format.js`
```js
export function formatClock(seconds)            // "1:23:45"  (active row)
export function formatShort(seconds)            // "1:23"     (panel, paused rows)
export function toGitLabDuration(seconds)       // "1h23m", minimum "1m"
export function isValidGitLabDuration(text)     // existing regex: mo|w|d|h|m|s tokens
```

#### `core/gitlabClient.js`
Purpose: the only place that builds URLs, sets `PRIVATE-TOKEN`, paginates, maps errors.
```js
export class GitLabError extends Error { kind /* 'auth'|'not-found'|'network'|'http'|'config' */; status; }

export class GitLabClient {
  constructor({url, token, timeoutSeconds = 15})
  setCredentials({url, token})          // aborts in-flight requests
  get(path, {cancellable}) : Promise<any>
  getAllPages(path, {maxPages = 20, cancellable}) : Promise<any[]>  // follows X-Next-Page
  post(path, params, {cancellable}) : Promise<any>                  // form/query params
  graphql(query, variables, {cancellable}) : Promise<any>           // throws on errors[]
  abort()
}
```
- Use `Soup.Session({timeout})`, `send_and_read_async` wrapped in Promises.
- Normalise URL: trim, strip trailing `/`, require `^https?://`.
- 401/403 → `kind: 'auth'`; 404 → `'not-found'`; transport errors → `'network'`.
- Endpoints used (complete list):
  - `GET /user`
  - `GET /projects?membership=true&simple=true&order_by=last_activity_at&per_page=100` (paged, capped)
  - `GET /projects/:id/issues?...` (queue, search, iid lookup)
  - `POST /projects/:id/issues/:iid/add_spent_time` with `duration`, optional `summary`
  - `POST /api/graphql` — `timelogs(projectId, startDate, endDate, first:100, after)` with `user { username name }` added to the existing query.
  - **Removed:** `GET /users?humans=true&active=true` (instance-wide user enumeration).

#### `core/config.js`
Purpose: typed access to GSettings, secret storage, migrations. Used by Shell, prefs and report.
```js
export class Config {
  constructor(gioSettings)
  get url(); get trackedProjects(); set trackedProjects(list)
  get doingLabels(); get lockBehaviour(); get showPanelTime()
  getToken() : Promise<string>; setToken(token) : Promise<void>
  connectChanged(keys[], callback) : id; disconnect(id)
  migrate()   // idempotent; see §5
}
```
Token storage: preferred `gi://Secret` (libsecret) with schema `org.gnome.shell.extensions.timelogs-extension.Token`, attribute `server=<url>`. If the Secret typelib cannot be imported, fall back to the `gitlab-token` GSettings key and show a warning subtitle on the token row ("Stored unencrypted — libsecret not available"). On first successful libsecret store, clear the GSettings key.

#### `core/sessionStore.js` (the heart; pure logic)
Purpose: own all timer state. UI only renders snapshots and calls methods.

Data model:
```js
// key = `${project.id}#${issue.iid}`
Session = {
  key, project /* {id, path_with_namespace, name, web_url} */,
  issue    /* {id, iid, title, web_url, project_id} */,
  accumulatedSeconds,       // time banked while not running
  runningSince,             // epoch seconds or null
  sending: false,           // true while a submit request is in flight
  updatedAt,                // epoch seconds
}
State = { version: 3, activeKey: string|null, sessions: Session[] /* most recent first */, lastSeenAt }
```
Invariants:
- At most one session has `runningSince !== null`, and if so it is `activeKey`.
- `activeKey` may point to a session that is paused (`runningSince === null`) → "active but paused".
- Elapsed = `accumulatedSeconds + (runningSince ? now - runningSince : 0)`. Never increment counters.

API (all methods take `now` injected via constructor `clock()` for tests):
```js
export class SessionStore {
  constructor({load: () => string, save: (json) => void, clock = () => Math.floor(Date.now()/1000)})
  snapshot() : {active: SessionView|null, paused: SessionView[]}   // views include elapsedSeconds
  has(project, issue) : boolean
  start(project, issue)      // if exists → switchTo; else create running; previous active → paused (stays in list)
  switchTo(key)              // pause active, make key active & running
  toggle()                   // active: pause↔resume; none: resume most recent paused; returns false if nothing
  pause(); resume()
  discard(key) : Session     // returns removed session for undo
  restoreDiscarded(session)
  beginSubmit(key) : {project, issue, elapsedSeconds}   // sets sending=true; timer keeps running
  completeSubmit(key, ok)    // ok → remove session; !ok → sending=false
  isBusy() : boolean         // any session sending
  heartbeat()                // updates lastSeenAt, saves (called every 60 s while something runs)
  applyLockPolicy(policy)    // called once after restore, see lockPolicy.js
  connect('changed', cb)     // simple signal emitter; UI re-renders on change
}
```
Rules that differ from today:
- Switching/starting is **not** blocked while a submit is in flight; only the session being sent is locked (its buttons insensitive, cannot be discarded/switched to until `completeSubmit`).
- Save on every state transition plus heartbeat every 60 s (not every 5 s).
- Persisted to the existing `timer-state` key (JSON).

#### `core/lockPolicy.js`
Purpose: what happens to a session that was running when the extension was disabled (lock, logout, crash, shutdown). GNOME disables extensions on the lock screen, so `enable()` after unlock == restore.
```js
export function restoreRunning(session, {policy, lastSeenAt, now})
// 'pause'            → accumulated += lastSeenAt - runningSince; runningSince = null
// 'resume-on-unlock' → accumulated += lastSeenAt - runningSince; runningSince = now
// 'keep-counting'    → unchanged (runningSince kept; downtime counts)
```
Use `lastSeenAt` (heartbeat / save on `disable()`) as the moment tracking stopped; this is what `savedAt` does today.

#### `core/issueSource.js`
Purpose: everything that lists issues; hides HTTP, caching and stale-response handling from UI.
```js
export class IssueSource {
  constructor({client, config, cacheLoad, cacheSave})
  getCachedQueue() : IssueItem[]
  refreshQueue() : Promise<IssueItem[]>        // supersedes previous call; resolves only for latest
  search(text) : Promise<IssueItem[]>          // debounced by caller (300 ms); supersedes previous
  currentUser() : Promise<{id, username, name}> // cached per (url, token)
  listMemberProjects({refresh}) : Promise<Project[]>   // projects cache, used by prefs & report
}
IssueItem = {project, issue, source: 'queue'|'search'}
```
Supersession: keep a request counter; drop results that aren't the latest; pass a `Gio.Cancellable` and cancel the previous one.

#### `ui/indicator.js`
Purpose: panel button; owns the menu; re-renders from `sessionStore.snapshot()` on `changed` and every second while something runs (one `GLib.timeout_add_seconds` that only updates labels, never state).
```js
export const Indicator = GObject.registerClass(class Indicator extends PanelMenu.Button {
  _init({store, issues, config, openPrefs, openReport})
  openWithSearch()     // used by select-issue shortcut
  destroy()            // removes timeouts, disconnects signals, aborts requests
});
```

#### `ui/menuSections.js`
One class per section, each with `update(data)` that reuses existing child items where possible (keyed by session/issue key) so focus and hover are not lost on refresh.
- `SearchSection` — `PopupMenu.PopupBaseMenuItem({reactive:false})` containing an `St.Entry` with `primary_icon` = `edit-find-symbolic`, `hint_text` "Search issues or #number…". Emits `changed(text)` and `activate-first`.
- `ActiveSection` — title/subtitle labels, elapsed label, 4 icon buttons.
- `PausedSection` — heading + rows (`PopupMenu.PopupBaseMenuItem` with title label, elapsed label, submit icon button).
- `QueueSection` — heading + `PopupMenu.PopupMenuItem` rows + optional status row.
- `ResultsSection` — merged results + status row; visible only while searching.
- `Footer` — "Monthly Report", "Settings".

Max menu content height: wrap Paused/Queue/Results in a `PopupMenu.PopupMenuSection` whose actor is placed in an `St.ScrollView` (`vscrollbar_policy: AUTOMATIC`, max-height ≈ 60% of monitor). Use stock classes only.

#### `ui/submitDialog.js`
```js
export const SubmitDialog = GObject.registerClass(class SubmitDialog extends ModalDialog.ModalDialog {
  _init({project, issue, duration, comment = '', onSubmit /* (duration, comment) => void */})
});
```
Use `ModalDialog` + `Dialog.MessageDialogContent` (title/description) from `resource:///org/gnome/shell/ui/dialog.js` for the stock header look, then two `St.Entry`s. No inline `style:` strings except none at all; error label uses the Shell's stock error color via class if available, otherwise one CSS class in `stylesheet.css`.

#### `ui/notifications.js`
```js
export function notify(title, body)                         // transient
export function notifyWithActions(title, body, actions /* [{label, callback}] */)
```
Implement with `MessageTray.Notification` + `addAction` on `MessageTray.getSystemNotificationSource()` (GNOME 46+ API; verify on each supported version). Fall back to `Main.notify` if actions aren't supported.

#### `extension.js`
```js
export default class TimelogsExtension extends Extension {
  enable()  // config.migrate(); client; store (restore + lock policy); issues; indicator; keybindings
  disable() // store.heartbeat() (records lastSeenAt), Gio.Settings.sync(), destroy indicator, abort client, remove keybindings
}
```
Report launch: `Gio.Subprocess.new(['gjs', '-m', `${path}/report/main.js`, String(activeProjectId ?? '')], NONE)`.

#### `report/reportData.js` (pure parts testable)
```js
export async function fetchTimelogs(client, projectId, year, month) : Promise<Entry[]>
export function aggregate(entries, {author, tagFilters}) : ReportData   // existing _processReportData logic
export function parseTagFilters(text) : Filter[]                         // existing logic
export function authorsOf(entries) : {username, name}[]
```
#### `report/exporters.js`
```js
export function toCsv(reportData, {projectPath, monthLabel}) : string
export function toMarkdown(reportData, {projectPath, monthLabel}) : string
export function exportFileName(projectPath, year, month, ext) : string
```
Keep today's output formats byte-compatible.

---

## 5. GSettings schema changes

| Key | Action | Notes |
|---|---|---|
| `gitlab-url` | keep | |
| `gitlab-token` | keep as fallback | Emptied once token is in libsecret |
| `timer-state` | keep, new JSON v3 | Migrate v1 (single timer) and v2 (`pausedSessions`) → v3 |
| `tracked-projects` | **new** `s` (JSON array), default `'[]'` | Seeded from `default-project` |
| `doing-labels` | keep | |
| `lock-behaviour` | **new** `s`, default `'pause'` | Migrated from the two booleans |
| `show-panel-time` | **new** `b`, default `true` | |
| `projects-cache` | keep | |
| `queue-cache` | **new** `s`, default `'{}'` | `{url, user_id, items}` |
| `cached-user` | **new** `s`, default `'{}'` | `{url, id, username, name}` |
| `report-tags-filter` | keep | Edited only in report window |
| `report-view` | **new** `s`, default `'categories'` | |
| `report-user` | **new** `s`, default `''` | `''` = Everyone |
| `report-export-format` | **new** `s`, default `'csv'` | Split button default |
| 5 × `*-shortcut` | keep | |
| `default-project` | **remove after migration** | Keep key in schema one release so migration can read it, then drop |
| `resume-on-unlock`, `count-time-when-locked` | **remove after migration** | Same |
| `selection-state` | **remove** | IPC no longer needed |
| `recent-issues` | **remove** | Never read |
| `issue-filter-search/state/assignee/labels` | **remove** | Saved filters dropped |

`Config.migrate()` must be idempotent and run in `enable()` and in prefs before reading values. Store `settings-version` (new `i` key, default `0`) and bump to `3` after migration.

Timer state v2 → v3 mapping:
- v2 current timer (`project`, `issue`, `elapsedSeconds`, `running`, `paused`, `savedAt`) → one session; `activeKey` = its key; if `running && !paused` → `runningSince = savedAt` and `lastSeenAt = savedAt`, then lock policy applies; else `accumulatedSeconds = elapsedSeconds`.
- each `pausedSessions[i]` → session with `accumulatedSeconds = elapsedSeconds`, `runningSince = null`.
- v1 (no `version`) → same as v2 current timer with no paused sessions.
- Invalid entries dropped; duplicates by key de-duplicated (first wins) — same rules as today's `_restoreTimerState`.

---

## 6. Behaviour spec (edge cases the implementation must satisfy)

1. Starting an issue that already has a session resumes that session's time (never creates a duplicate).
2. Same IID in two projects = two independent sessions.
3. Only one running session at any time.
4. Starting/switching pauses the previous active session and keeps it in Paused (current behaviour, kept).
5. Submit failure never loses time; retry is one click from the notification.
6. A session with `sending=true` cannot be discarded, switched to, or submitted again.
7. Submitting while another session runs does not touch the running one.
8. Discard is undoable (§2.7).
9. Restore after lock/logout/crash follows `lock-behaviour` using `lastSeenAt`; paused sessions are never altered by restore.
10. Changing URL or token: abort in-flight requests, clear in-memory user/queue caches, keep sessions (they carry project/issue ids; submission will fail cleanly if the server changed).
11. Queue/search responses that arrive after a newer request, after menu close (search only), or after `disable()` are ignored.
12. Elapsed values stay correct across suspend/resume (timestamp-based).
13. Duration rounding: floor to minutes, minimum `1m` (current behaviour). The user can edit before sending.
14. Menu with no network and no cache: Queue shows one status row with the error; search shows the error in its status row; tracking still works offline.

---

## 7. Testing

- `make test` → `gjs -m tests/run.js`. Import modules directly (no source slicing). Inject `clock`, a fake client (`{get, post, graphql}` returning canned Promises) and in-memory `load/save`.
- Port every scenario in today's `tests/regressions.js` to the new API (they are good behavioural specs): failed sends retain time; dialog does not lose time; switching preserves time; same-issue switch doesn't duplicate; cross-project IID independence; busy-session locking; paused submit leaves active alone; restart survival; v1/v2 migration; invalid/duplicate restore; queue query params (labels, assignee, relative_position); stale queue responses ignored.
- Add: lock policy (3 modes), discard + undo, settings migration (all old key combos), `toGitLabDuration`, CSV/Markdown exporters byte-equal to current output for a fixture, `aggregate` with literal and regex tag filters, `authorsOf`.
- Manual: `make test-shell` (nested Shell) and `make test-prefs`; checklist = every row of §3.

## 8. Build / housekeeping

- Delete: `issueSelector.js`, `reportDialog.js`, `avatarLoader.js`, `selectorWindow.js`, `state.js`, `timeEntryDialog.js` (moved), `tests/selector-ui.js`.
- Makefile: update `pot` source list to the new files (`extension.js prefs.js core/*.js ui/*.js report/*.js`); make sure `gnome-extensions pack` includes subdirectories (`--extra-source=core --extra-source=ui --extra-source=report --extra-source=icons`). Replace `test-regressions`/`test-selector-ui` targets with `test`.
- Strip unused CSS classes from `stylesheet.css` (selector/report dialog classes are dead).
- Update `README.md` (usage section to match §2), `AGENTS.md` (new layout), translations via `make pot` (new/removed strings).
- `metadata.json`: keep `shell-version` 46–49; add newer versions only after testing in a nested shell. Bump `version`.

## 9. Implementation order (each step leaves the extension working)

1. `core/format.js`, `core/gitlabClient.js` + tests. Switch existing `extension.js` to use the client.
2. `core/config.js` with migrations + schema changes + tests.
3. `core/sessionStore.js`, `core/lockPolicy.js` + port all regression tests. Replace timer logic in `extension.js`.
4. `ui/` split: indicator with panel label, sections, new menu layout, undo discard, submit dialog changes, notifications with actions.
5. `core/issueSource.js` with cache + in-menu search. Delete `selectorWindow.js` and the `selection-state` IPC.
6. Preferences rework (apply + connection check, token link, tracked projects subpage, lock combo, shortcut subpage, libsecret).
7. Report: extract `reportData.js`/`exporters.js` with tests, then rebuild UI with libadwaita; drop `/users` call and log file.
8. Delete dead files, update Makefile, README, AGENTS.md, translations.

## 10. Explicitly out of scope

- Visual theming, custom colours, avatars.
- Editing issue labels/board state (the extension stays read-only on issues apart from spent time — same as today).
- Saved issue filters UI. If needed later, add inline search tokens (`label:bug`, `@user`, `is:closed`) parsed in `IssueSource.search` — zero extra UI.
- "Submit all paused" batch flow and "submit but keep tracking" — candidates for a later iteration.
