# GitLab Time Tracking

[<img src="https://github.com/aunetx/files_utils/raw/master/get_it_on_gnome_extensions.png" height="100" align="right">](https://extensions.gnome.org/extension/9029/gitlab-time-tracking/)

A GNOME Shell extension for tracking time spent on GitLab issues directly from your system tray.

![Version](https://img.shields.io/github/v/release/Gecka-Apps/gitlab-time-tracker)
![License](https://img.shields.io/badge/license-GPL--3.0-green)
![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-46%20|%2047%20|%2048%20|%2049-blue)
![Languages](https://img.shields.io/badge/languages-4-brightgreen)

## Features

- **System Tray Integration**: Quick access timer in your GNOME top bar
- **Project & Issue Selection**: Browse projects and filter issues through GitLab server-side search
- **Timer Controls**: Start, pause, resume, and cancel time tracking
- **Keyboard Shortcuts**: Configurable shortcuts for timer and dialog actions
- **Automatic Time Submission**: Send tracked time directly to GitLab issues
- **Monthly Reports**: Generate detailed time reports by project and tag
- **Quick Links**: Open projects and issues directly in your browser
- **Tag Filtering**: Filter reports by specific labels or regex patterns
- **Multi-language Support**: Available in English, French, Spanish, and German

## Screenshots

### System Tray Timer
The extension adds a timer icon to your system tray that changes based on the timer state:
- ⏱️ Stopped: Default timer icon
- ▶️ Running: Play icon
- ⏸️ Paused: Pause icon

### Project & Issue Selector
Browse and search your GitLab projects and issues with a clean, intuitive interface:
- Alphabetically sorted project list
- Server-side issue filtering for large projects
- Persistent issue filters for search text, state, assignee, and labels
- Project avatars with fallback to group/user avatars

## Installation

### From [https://extensions.gnome.org](https://extensions.gnome.org)

Visit the [extension page](https://extensions.gnome.org/extension/9029/gitlab-time-tracking/) and click install

### From Source

Clone this repository:
   ```bash
   git clone https://github.com/Gecka-Apps/gitlab-time-tracker.git
   cd gitlab-time-tracker
   make install
   ```

## Configuration

1. Click on the timer icon in the system tray
2. Select **Settings** from the menu
3. Configure your GitLab instance:
   - **GitLab Server URL**: Your GitLab instance URL (e.g., `https://gitlab.com`)
   - **Personal Access Token**: Generate a token with `api` scope from your GitLab settings
4. (Optional) Configure report filters:
   - **Tags included in reports**: Filter reports by specific labels (comma-separated list or regex patterns)
5. (Optional) Configure keyboard shortcuts in the **Keyboard Shortcuts** section.

### Creating a GitLab Personal Access Token

1. Go to your GitLab instance
2. Navigate to **Preferences** → **Personal Access Token**
3. Create a new token with the following:
   - **Name**: GNOME Time Tracker
   - **Scopes**: `api` (to read projects/issues and add time entries)
4. Copy the token and paste it in the extension settings

## Usage

### Starting Time Tracking

1. Click the timer icon in the system tray
2. Select **Select project & issue**
3. Search and select your project
4. Filter issues by search text, state, assignee, or labels
5. Click **Select**
6. Click **Start** to begin tracking time

### Issue Filters

Issue filtering is done by GitLab instead of locally, so projects with thousands of issues can be searched without loading every issue first.

- **Search**: Searches GitLab issues by title and description
- **State**: Cycles between open, closed, and all issues
- **Assignee**: Leave empty for any assignee, use `None` or `unassigned` for unassigned issues, `me` for your GitLab user, or a GitLab username
- **Labels**: Comma-separated GitLab labels, for example `bug,frontend`
- **Load more issues**: Fetches the next page when more than 100 matching issues exist

Filters persist across issue selector openings.

### Timer Controls

- **Start**: Begin tracking time on the selected issue
- **Pause/Resume**: Pause or resume the timer without losing progress
- **Stop & Send**: Stop the timer and send the tracked time to GitLab
- **Cancel**: Cancel the timer without sending time

### Keyboard Shortcuts

Default shortcuts can be changed or disabled in Settings:

- `<Super><Alt>t`: Start, pause, or resume the timer; opens issue selection if no issue is selected
- `<Super><Alt>s`: Stop and send tracked time
- `<Super><Alt>c`: Cancel the timer
- `<Super><Alt>i`: Open project and issue selection
- `<Super><Alt>r`: Open the monthly report

### Time Format

The extension tracks time in seconds and sends it to GitLab in the following format:
- Hours: `Xh` (e.g., `2h` for 2 hours)
- Minutes: `Xm` (e.g., `30m` for 30 minutes)
- Combined: `XhYm` (e.g., `2h30m` for 2 hours and 30 minutes)

**Note**: The minimum time that can be sent is 1 minute.

## Monthly Reports

Generate detailed time reports for your projects with comprehensive breakdown by tags.

### Accessing Reports

1. Click the timer icon in the system tray
2. Select **Monthly Report** from the menu
3. Choose a project from the dropdown list
4. Navigate between months using the arrow buttons

### Report Features

- **Visual Chart**: Bar chart showing time distribution by tag/label
- **Tag Filtering**: Configure which tags to include in reports (see Settings)
- **Export Options**:
  - **Markdown**: Detailed report with summary by category and per-ticket breakdown
  - **CSV**: Simple data export for spreadsheet analysis
- **Quick Navigation**: Month-by-month browsing with arrow controls
- **Summary Statistics**: Total time, issue count, and category count

### Filtering Reports by Tags

You can configure which tags appear in your reports:

1. Open **Settings** from the extension menu
2. Go to the **Report Configuration** section
3. Enter tags in the **Tags included in reports** field

**Filter Examples**:
- Exact match: `Corrective maintenance,Adaptive maintenance,Preventive maintenance`
- Regex pattern: `^.+ maintenance$` (all tags ending with "Maintenance")
- Mixed: `Bug,^Feature.*$,Hotfix`

**Note**: Issues without matching tags will appear as "Other" in filtered reports.

### Report Exports

**Markdown Export** includes:
- Project name and period
- Total time for the month
- Summary by category (tags)
- Detailed breakdown by ticket with clickable links

**CSV Export** includes:
- Project, Month, Label, and Time columns
- Compatible with Excel, Google Sheets, etc.

Files are saved to your Downloads folder automatically.

## Quick Browser Access

Once you've selected a project and issue:

1. Click **Open project in browser** to view the project in GitLab
2. Click **Open issue in browser** to view the issue in GitLab

These links use the URLs provided by GitLab's API for maximum compatibility.

## Supported Languages

The extension automatically detects your system language and displays in:

- 🇬🇧 **English** (default)
- 🇫🇷 **French** (Français)
- 🇪🇸 **Spanish** (Español)
- 🇩🇪 **German** (Deutsch)

## Compatibility

- **GNOME Shell**: 46, 47, 48, 49
- **GitLab**: Any version with API v4
- **Operating Systems**: Linux distributions with GNOME Shell

## Troubleshooting

### Extension not appearing in the system tray

1. Restart GNOME Shell (X11: `Alt+F2` → `r` → Enter)
2. Check if the extension is enabled:
   ```bash
   gnome-extensions list --enabled | grep gitlab-time-tracker
   ```
3. Check the extension logs:
   ```bash
   journalctl -f -o cat /usr/bin/gnome-shell
   ```

### Cannot select projects or issues

1. Verify your GitLab URL and token in settings
2. Ensure your token has `api` scope
3. Check your network connection
4. Verify the GitLab instance is accessible

### Time not sent to GitLab

1. Check the notification message for error details
2. Verify you have permission to add time to the issue
3. Ensure the project allows time tracking
4. Check the browser console for API errors

## Development

### Development Container

Open the repository in a Dev Container-compatible editor and select **Reopen in Container**. The container installs the GNOME extension packaging, GSettings schema, and gettext tools, then runs `make build` when it is created.

The container supports building the extension package. Run `make install`, `make test-shell`, and `make test-prefs` on the Ubuntu GNOME host because those targets interact with the user's GNOME Shell session.

### Building from Source

The extension includes a Makefile for building and development:

```bash
# Build the extension package (compiles schemas and translations)
make build

# Build and install the extension
make install

# Update translation templates
make pot

# Test in nested GNOME Shell
make test-shell

# Test preferences dialog
make test-prefs

# Clean build artifacts
make clean

# Show all available commands
make help
```

The `build` command uses `gnome-extensions pack` which automatically:
- Compiles GSettings schemas
- Compiles translations from .po files
- Creates a .zip package in the `build/` directory

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

### Adding Translations

1. Copy `po/gitlab-time-tracker@gecka.nc.pot` to `po/XX.po` (where XX is your language code)
2. Translate the strings in the new `.po` file
3. Add your language code to `po/LINGUAS`
4. Test your translation by building and installing the extension

## Support

For issues, questions, or feature requests, please visit:
- **Issues**: https://github.com/Gecka-Apps/gitlab-time-tracker/issues
- **Discussions**: https://github.com/Gecka-Apps/gitlab-time-tracker/discussions

## Credits

- **Material Design Icons**: Timer icons from [Material Design Icons](https://materialdesignicons.com/)
- **GNOME Shell**: Extension API and documentation

## License

This project is licensed under the [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html) or later - see the [LICENSE](LICENSE) file for details.

## Author

- **Laurent Dinclaux** <laurent@gecka.nc> - Gecka

---

Built with 🥥 and ☕ by [Gecka](https://gecka.nc) — Kanaky-New Caledonia 🇳🇨
