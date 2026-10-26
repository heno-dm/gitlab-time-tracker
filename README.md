# Timelogs Extension

A GNOME Shell extension for tracking time spent on GitLab issues from the top bar.

## Fork Notice

This repository was forked from [`Gecka-Apps/gitlab-time-tracker:main`](https://github.com/Gecka-Apps/gitlab-time-tracker/tree/main).

This fork is for personal use only and will not be maintained. Changes in this personal fork were developed primarily through AI-assisted "vibe programming" as an experiment in exploring the capabilities and limitations of AI-assisted software development. Expect rough edges, limited support, and changes tailored to one person's workflow.

For the maintained project, releases, support, and contributions, use the [upstream repository](https://github.com/Gecka-Apps/gitlab-time-tracker).

## Features

- Timer icon and elapsed time (or issue and time) in the GNOME top bar, with a warning dot when GitLab is unreachable or not set up
- One menu for everything: search, start, switch, pause, submit and discard
- Independent timers per issue; switching pauses the previous one and keeps its time
- Your Doing queue across all tracked projects, in board order, cached so the menu never jumps
- Search issues by text or `#number` across tracked projects without leaving the menu
- Submit time with an editable duration, rounding and ±step chips, and a comment; the timer keeps running until you submit
- Discard with one click and Undo from the notification
- Reminders for idle time, long timers, sessions paused by the lock screen, and stale paused sessions
- Keyboard shortcuts recorded by pressing them
- Monthly reports per project with a summary card, category drill-down, calendar day details, CSV or Markdown export and clipboard copy
- Access token stored in the system keyring (libsecret) when available
- English, French, Spanish, and German translations

## Requirements

- GNOME Shell 46, 47, 48, or 49
- A GitLab instance exposing API v4 and GraphQL
- A GitLab personal access token with the `api` scope
- `gjs` with GTK 4 and libadwaita 1.4 or newer for the report window

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

1. Open the extension menu from the timer icon in the top bar and choose **Set up GitLab…** (or **Settings**).
2. Enter the URL of your GitLab instance, including the protocol, and press the apply button.
3. Use **Create token…** to open GitLab with the token name and `api` scope prefilled, then paste the token and apply it. The page switches to the connected layout once GitLab accepts it, or explains the error under the token field.
4. Open **Tracked projects** and switch on the projects whose issues you work on. The Doing queue and search cover all of them.
5. Optionally change the **Doing labels**, what the top bar shows, what happens when the screen locks, the idle and long-timer reminders, the rounding step, and the keyboard shortcuts.

## Usage

The top bar shows the timer icon and, while a session exists, its elapsed time (`1:23`). **Top bar shows** in the preferences switches between the time, `#142 · 1:23`, or the icon only. A small warning dot on the icon means GitLab is not set up, rejected the token, or cannot be reached; the menu explains why in a banner with a one-click action.

The menu has one search entry at the top, then the active session block, paused sessions, your Doing queue, and the footer.

- **Start an issue**: click it in **Doing**, or type a title fragment or `#142` in the search entry and press Enter. Search results come from all tracked projects; sessions and queue items match instantly, remote matches follow. When nothing matches, the menu offers **Include closed issues** and **Search on GitLab**.
- **Switch**: click a paused session or another issue. The previous session is paused and keeps its time; the **Paused** heading shows the unsubmitted sum.
- **Pause / resume**: the labelled button in the active block, or `Space` while the block is focused. The menu stays open so you can see the state change.
- **Submit**: **Submit…** in the active block or the send button on a paused row. The duration is prefilled and selected, the cursor is in the comment field, and the button shows the amount (`Submit 1h 23m`). Chips round the duration to the configured step or adjust it in steps; the timer keeps running until you submit, and cancelling changes nothing.
- **Discard**: the trash button. A notification offers **Undo** for 30 seconds.
- **Open in browser**: the globe button in the active block, or `Ctrl+Enter` on any row.
- **Report** in the footer shows what you submitted today; **Settings** opens the preferences.
- `Esc` clears the search text; a second `Esc` closes the menu.

Only one issue runs at a time. Elapsed time is timestamp-based, so suspend and resume never lose or inflate time. A failed submission keeps the session untouched and offers **Retry** in the notification.

When the extension is disabled by the lock screen, a logout or a crash, the running session is restored according to **When the screen locks**: pause it and tell you (with **Resume** and **Add N min** in the notification), keep counting the downtime, or pause it and resume on unlock. Paused sessions are never altered.

### Reminders

All reminders are regular notifications with actions; none interrupt you.

- **Idle time**: after you were away for the configured number of minutes while a session ran, choose **Remove N min** or **Keep**.
- **Long timer**: once per session when it has run for the configured number of hours, with **Submit…**, **Pause** and **Keep**.
- **Stale sessions**: once per day, paused sessions from earlier days are summed up with a **Review** action that opens the menu.

### Your Doing queue

The queue shows open issues assigned to you with the configured **Doing labels** (default: `doing`) in every tracked project, in GitLab's manual board order. For scoped labels enter the full name, for example `workflow::Doing`; leave the labels empty to show all your open issues. The last known queue is cached, rendered immediately when the menu opens and refreshed in place. When offline, the cached queue stays visible and its heading shows when it was fetched.

GitLab remains the place for reading user stories, commenting, and moving work across the board. The extension never changes issue labels or board state.

GitLab accepts submitted durations in forms such as `30m`, `2h`, or `2h 30m`. The minimum submitted duration is one minute.

### Default Shortcuts

- `<Super><Alt>t`: pause or resume the active session; resume the most recent paused one; otherwise open the menu with the search focused
- `<Super><Alt>s`: submit the active session
- `<Super><Alt>c`: discard the active session (with Undo)
- `<Super><Alt>i`: open the menu with the search focused
- `<Super><Alt>m`: open the menu (or close it when it is open) without clicking the top bar icon
- `<Super><Alt>r`: open the monthly report

Shortcuts are recorded in the preferences: activate a row, press the new chord, `Backspace` disables it, `Esc` cancels. Conflicts with the other shortcuts are rejected.

## Preferences

Until GitLab is connected, the preferences show three numbered steps: server, access token (with a **Create token…** link that opens GitLab with the name and scope prefilled), and tracked projects. Once connected, the account row leads to the connection details and **Sign out**, and the **Timer** group holds dropdown-only options: top bar content, lock behaviour, idle reminder, long-timer reminder, and the rounding step for the submit dialog.

## Reports

The monthly report opens in its own window. Pick a project (searchable), a month (`Alt+Left` / `Alt+Right` or the header buttons), and a user: **Me** (default), **Everyone**, or one of the people who logged time that month. The summary card shows the total, the number of issues, the average per working day, and the change against the previous month.

The **Categories** view lists time per label; expand a category to see its issues with their hours and a link to GitLab. With **Everyone** selected, the user × category table appears below it. The **Calendar** view shows the month as a grid with weekly totals; click a day to see its entries, including the comment of each timelog. **Export** writes CSV (default) or Markdown to your Downloads folder and offers to open the file; the menu also copies the report to the clipboard. `Ctrl+1` / `Ctrl+2` switch views, `Ctrl+E` exports, `Ctrl+Shift+C` copies Markdown, `Ctrl+R` or `F5` reloads.

The **Categories** filter accepts exact label names or regular expressions, comma-separated:

```text
Bug,Hotfix
^Feature.*$
Corrective maintenance,^.+ maintenance$
```

Entries without a matching label are grouped under **Other**.

## Technical Overview

This is a GNOME Shell extension written in JavaScript and loaded directly by GNOME Shell. It is not a Node.js application and has no package manifest or external test framework.

- `extension.js`: wiring only — settings, session store, panel indicator, keybindings, report launcher
- `prefs.js`: libadwaita preferences
- `core/`: pure logic shared by all processes (GitLab client, config and migrations, session store, lock policy, issue source, formatting)
- `ui/`: Shell widgets (panel indicator and menu sections, submit dialog, notifications, actions, reminders)
- `report/`: standalone GTK4 + libadwaita report process; `reportData.js` and `exporters.js` are pure
- `tests/run.js`: headless checks run with `gjs -m`
- `schemas/`: GSettings schema
- `po/`: gettext translation sources
- `metadata.json`: extension identity and supported GNOME Shell versions

GitLab requests use API v4 (and GraphQL for reports) with the `PRIVATE-TOKEN` header. Version 3 of the GSettings `timer-state` JSON stores all sessions keyed by project ID and issue IID with timestamp-based elapsed time; older single-timer states are migrated automatically. The token is stored in the system keyring via libsecret when available.

The extension UUID is `timelogs-extension@heno-dm.github.io`. Its GSettings schema is separate from upstream, so both extensions can coexist without sharing configuration.

## Development

Required build tools include `make`, `gnome-extensions`, `glib-compile-schemas`, `gjs`, and gettext utilities such as `msgfmt` and `xgettext`.

```bash
# Run headless checks (requires gjs, no GNOME session needed)
make test

# Compile schemas and translations, then create the extension archive
make build

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
gnome-extensions list --enabled | grep timelogs-extension
```

Follow GNOME Shell logs while reproducing a problem:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

If the menu shows **Set up GitLab…**, the URL or token is missing or was rejected; open the preferences and check the **Connection** row. If the Doing queue is empty, check the tracked projects and the Doing labels. If time cannot be submitted, the notification names the reason and offers **Retry**.

## Support And Contributions

No support, maintenance, or contribution process is offered for this personal fork. Issues and pull requests may not receive a response. Use the [upstream project](https://github.com/Gecka-Apps/gitlab-time-tracker) for the maintained version.

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE) or later.
