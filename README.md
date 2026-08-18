# Timelogs Extension

A GNOME Shell extension for tracking time spent on GitLab issues from the top bar.

## Fork Notice

This repository was forked from [`Gecka-Apps/gitlab-time-tracker:main`](https://github.com/Gecka-Apps/gitlab-time-tracker/tree/main).

This fork is for personal use only and will not be maintained. Changes in this personal fork were developed primarily through AI-assisted "vibe programming" as an experiment in exploring the capabilities and limitations of AI-assisted software development. Expect rough edges, limited support, and changes tailored to one person's workflow.

For the maintained project, releases, support, and contributions, use the [upstream repository](https://github.com/Gecka-Apps/gitlab-time-tracker).

## Features

- Timer controls in the GNOME top bar
- GitLab project and issue selection
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

1. Open the extension menu and select **Select project & issue**.
2. Choose a project and filter its issues as needed.
3. Select an issue and start the timer.
4. Pause or resume the timer without losing elapsed time.
5. Use **Stop & Send** to submit the elapsed time to GitLab, or **Cancel** to discard it.

GitLab accepts submitted durations in forms such as `30m`, `2h`, or `2h30m`. The minimum submitted duration is one minute.

### Issue Filters

Filtering is performed by GitLab's API, which avoids loading every issue in large projects.

- **Search** searches issue titles and descriptions.
- **State** selects open, closed, or all issues.
- **Assignee** accepts a username, `me`, `None`, or `unassigned`.
- **Labels** accepts comma-separated GitLab labels, such as `bug,frontend`.
- **Load more issues** retrieves another page when more than 100 results match.

Issue filters persist between selector sessions.

### Default Shortcuts

- `<Super><Alt>t`: Start, pause, or resume; open issue selection when none is selected
- `<Super><Alt>s`: Stop and submit tracked time
- `<Super><Alt>c`: Cancel the timer
- `<Super><Alt>i`: Open project and issue selection
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

This is a GNOME Shell extension written in JavaScript and loaded directly by GNOME Shell. It is not a Node.js application and has no package manifest or JavaScript test runner.

- `extension.js`: runtime entry point and top-bar integration
- `prefs.js`: preferences entry point
- `issueSelector.js`: project and issue selection
- `reportDialog.js`: report retrieval and presentation
- `avatarLoader.js`: shared avatar loading
- `schemas/`: GSettings schema and persistent configuration
- `po/`: gettext translation sources
- `metadata.json`: extension identity and supported GNOME Shell versions

GitLab requests use API v4 with the `PRIVATE-TOKEN` header. Timer and selected-project state are serialized as JSON in the GSettings `timer-state` value so they can survive extension reloads, lock screens, logout, and restart.

The extension UUID is `timelogs-extension@heno-dm.github.io`. Its GSettings schema is separate from upstream, so both extensions can coexist without sharing configuration.

## Development

Required build tools include `make`, `gnome-extensions`, `glib-compile-schemas`, and gettext utilities such as `msgfmt` and `xgettext`.

```bash
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
