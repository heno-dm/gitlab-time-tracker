# Timelogs Extension

A GNOME Shell extension for tracking time spent on GitLab issues from the top bar.

## Fork Notice

This repository was forked from [`Gecka-Apps/gitlab-time-tracker:main`](https://github.com/Gecka-Apps/gitlab-time-tracker/tree/main).

This fork is for personal use only and will not be maintained. Changes in this personal fork were developed primarily through AI-assisted "vibe programming" as an experiment in exploring the capabilities and limitations of AI-assisted software development. Expect rough edges, limited support, and changes tailored to one person's workflow.

For the maintained project, releases, support, and contributions, use the [upstream repository](https://github.com/Gecka-Apps/gitlab-time-tracker).

## Features

- Timer controls in the GNOME top bar
- One-click switching between independently saved issue timers
- Your Doing queue in manual board order
- A keyboard-friendly search window for other issues in your project
- Server-side issue search and filtering by state, assignee, and labels
- Start, pause, resume, cancel, and submit tracked time
- Configurable keyboard shortcuts
- Monthly reports grouped by project and label
- Markdown and CSV report exports
- Links to open selected projects and issues in a browser
- English, French, Spanish, and German translations

## Requirements

- GNOME Shell 46, 47, 48, or 49
- A GitLab instance exposing API v4
- A GitLab personal access token with the `api` scope
- Linux with GNOME Shell

This extension is not affiliated with, funded by, or associated with GitLab.

## Installation

This personal fork is intended to be installed from source:

```bash
git clone <this-repository-url> gitlab-time-tracker
cd gitlab-time-tracker
make install
gnome-extensions enable timelogs-extension@heno-dm.github.io
```

On Wayland, log out and back in if GNOME Shell does not detect the newly installed extension. On X11, restart GNOME Shell with `Alt+F2`, enter `r`, and press Enter.

The maintained upstream release is also available from [extensions.gnome.org](https://extensions.gnome.org/extension/9029/gitlab-time-tracking/).

## Configuration

1. Open the extension menu from the timer icon in the top bar.
2. Select **Settings**.
3. Enter the complete URL of your GitLab instance, including the protocol, such as `https://gitlab.com`. HTTPS is recommended.
4. Enter a personal access token with the `api` scope.
5. Optionally configure report labels and keyboard shortcuts.

Create a token from your GitLab user preferences under **Access Tokens**. The token needs API access to read projects and issues and to submit spent time.

## Usage

1. Open **Find another issue…** (or press `<Super><Alt>i`). Choose your project on first use; subsequent searches open directly in that project.
2. Search by title/description or exact issue number (`#142`). Use arrow keys and Enter, double-click a result, or click **Switch and start**. **Open in GitLab** lets you inspect details without switching.
3. The selected issue starts tracking immediately. Switching issues pauses and preserves the previous timer; selecting paused work resumes its accumulated time. Only one issue runs at once.
4. The top-bar menu shows **Working on**, **Paused work**, and **My Doing — board order**. Click an issue in your Doing queue to start it directly.
5. Click **Submit** beside an active or paused duration to edit the duration, add a comment, and send it to GitLab. Use **Pause/Resume** for the current timer; **Cancel** discards only the current timer, not other paused work.

Submitting the current issue pauses it and stops its timer on success. Submitting a paused issue leaves the active timer running. Cancelling the dialog or a failed submission preserves all unsubmitted time. Switching is blocked only while a time-entry dialog or submission is in progress.

Timers persist across restarts even when an issue leaves Doing. Explicitly paused timers stay paused; the automatic-resume preferences apply only to the previously running timer. Existing single-timer state is migrated automatically.

### Your Doing queue

The queue refreshes whenever the top-bar menu opens. It uses the default project, the authenticated GitLab user as assignee, and the exact **Doing column labels** configured in preferences (default: `doing`). For scoped labels, enter the full name, for example `workflow::Doing`. Leave the labels empty to show all your open issues. Up to 20 untracked issues from the first 100 results are shown; **Find more issues…** opens the searchable full list.

GitLab remains the place for reading user stories, checking Definition of Done, commenting, and moving work to Verify. The extension never changes issue labels or board state.

GitLab accepts submitted durations in forms such as `30m`, `2h`, or `2h30m`. The minimum submitted duration is one minute.

### Issue Filters

Filtering is performed by GitLab's API, which avoids loading every issue in large projects.

- **Search** searches issue titles and descriptions.
- **State** selects open, closed, or all issues.
- **Assignee** accepts a username, `me`, `None`, or `unassigned`.
- **Labels** accepts comma-separated GitLab labels, such as `bug,frontend`.
- **Load more issues** retrieves another page when more than 100 results match.

Search includes all issues in your project by default, so interruptions outside Doing are easy to find. Enable **Use saved filters** to apply the state, assignee, and label filters; these filter values persist between sessions. The search text starts empty each time.

Issues follow GitLab's manual board order (relative position, top to bottom), rather than issue number or creation date. Filtering and loading more results preserve that order. Boards sorted by other fields, such as due date, may display a different order.

### Default Shortcuts

- `<Super><Alt>t`: Start, pause, or resume; open issue selection when none is selected
- `<Super><Alt>s`: Stop and submit tracked time
- `<Super><Alt>c`: Cancel the timer
- `<Super><Alt>i`: Find or switch issue
- `<Super><Alt>r`: Open the monthly report

Shortcuts can be changed or disabled in the preferences.

## Reports

The monthly report view retrieves GitLab time entries for a selected project and groups them by label. It provides total time, issue and category counts, month navigation, a bar chart, and Markdown or CSV export to the Downloads directory.

Report labels can be filtered in the preferences with exact names or regular expressions. Examples include:

```text
Bug,Hotfix
^Feature.*$
Corrective maintenance,^.+ maintenance$
```

Entries without a matching label are grouped under **Other**.

## Technical Overview

This is a GNOME Shell extension written in JavaScript and loaded directly by GNOME Shell. It is not a Node.js application and has no package manifest or external test framework.

- `extension.js`: runtime entry point and top-bar integration
- `prefs.js`: preferences entry point
- `selectorWindow.js`: standalone GTK issue search and switching
- `reportWindow.js`: standalone GTK monthly reports
- `state.js`: shared serialization, default project, and work-session snapshots
- `timeEntryDialog.js`: Shell duration/comment submission dialog
- `schemas/`: GSettings schema and persistent configuration
- `po/`: gettext translation sources
- `metadata.json`: extension identity and supported GNOME Shell versions

GitLab requests use API v4 (and GraphQL for reports) with the `PRIVATE-TOKEN` header. Version 2 of the GSettings `timer-state` JSON stores the current timer, selected issue, and an array of paused sessions keyed by project ID and issue IID. Existing single-timer fields are retained for migration.

The extension UUID is `timelogs-extension@heno-dm.github.io`. Its GSettings schema is separate from upstream, so both extensions can coexist without sharing configuration.

## Development

Required build tools include `make`, `gnome-extensions`, `glib-compile-schemas`, and gettext utilities such as `msgfmt` and `xgettext`.

```bash
# Compile schemas and translations, then create the extension archive
make build

# Run headless regression checks (requires gjs, no GNOME session needed)
make test-regressions

# Smoke-test the GTK search window with mock data (requires a display)
make test-selector-ui

# Build and install into the current user's GNOME extensions directory
make install

# Install and start a nested Wayland GNOME Shell
make test-shell

# Install and open the preferences window
make test-prefs

# Update the gettext template and translation catalogs
make pot

# Remove generated files
make clean
```

The packaged extension is written to:

```text
build/timelogs-extension@heno-dm.github.io.shell-extension.zip
```

The `build/`, `locale/`, compiled GSettings schema, and compiled translation files are generated artifacts and should not be committed.

For manual runtime testing, disable the installed extension before replacing it, then install and enable the new build:

```bash
gnome-extensions disable timelogs-extension@heno-dm.github.io
make install
gnome-extensions enable timelogs-extension@heno-dm.github.io
```

Run GNOME integration commands on the GNOME host rather than inside a development container.

## Troubleshooting

Check whether the extension is enabled:

```bash
gnome-extensions list --enabled | grep gitlab-time-tracker
```

Follow GNOME Shell logs while reproducing a problem:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

If projects or issues cannot be loaded, verify the GitLab URL, token scope, network connection, and API access. If time cannot be submitted, verify that the account can add time to the selected issue and inspect the notification and GNOME Shell logs for the API error.

## Support And Contributions

No support, maintenance, or contribution process is offered for this personal fork. Issues and pull requests may not receive a response. Use the [upstream project](https://github.com/Gecka-Apps/gitlab-time-tracker) for the maintained version.

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE) or later.
