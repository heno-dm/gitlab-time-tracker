import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {TimeEntryDialog} from './timeEntryDialog.js';
import {addRecentIssue, getDefaultProject, serializeIssue, serializeProject, setDefaultProject} from './state.js';

const GitLabIssuesIndicator = GObject.registerClass(
class GitLabIssuesIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'GitLab Issues Timer');

        this._extension = extension;
        this._ = extension.gettext.bind(extension);

        this._settings = extension.getSettings();
        this._extensionPath = extension.path;
        this._httpSession = new Soup.Session();
        this._selectorProcess = null;
        this._selectionChangedId = this._settings.connect('changed::selection-state', () => this._applySelectionState());

        // Timer state
        this._timerRunning = false;
        this._timerPaused = false;
        this._elapsedSeconds = 0;
        this._timerId = null;
        this._selectedProject = null;
        this._selectedIssue = null;
        this._timerStartTimestamp = null; // Timestamp when timer was started

        // Create icon
        this._icon = new St.Icon({
            style_class: 'system-status-icon',
        });
        this._updateIcon();
        this.add_child(this._icon);

        // Build menu
        this._buildMenu();

        // Restore timer state if any (after menu is built)
        this._restoreTimerState();
        if (this._timerRunning || this._selectedProject) {
            this._updateUIAfterRestore();
        }
    }

    _getIconGicon(iconName) {
        const iconPath = `${this._extensionPath}/icons/${iconName}`;
        const file = Gio.File.new_for_path(iconPath);
        return new Gio.FileIcon({ file });
    }

    _validateSettings() {
        const url = this._settings.get_string('gitlab-url');
        const token = this._settings.get_string('gitlab-token');

        if (!url || !token) {
            Main.notify(this._('GitLab Issues Timer'), this._('Please configure the server URL and token in preferences'));
            return false;
        }
        if (!/^https?:\/\//i.test(url)) {
            Main.notify(this._('GitLab Issues Timer'), this._('The GitLab server URL must include http:// or https://'));
            return false;
        }
        return true;
    }

    _buildMenu() {
        // Project/Issue selection button
        let selectButton = new PopupMenu.PopupMenuItem(this._('Select project & issue'));
        selectButton.connect('activate', () => {
            this._openIssueSelector();
        });
        this.menu.addMenuItem(selectButton);

        // Current selection display
        this._projectLabel = new PopupMenu.PopupMenuItem(this._('Project: None'), {reactive: false});
        this.menu.addMenuItem(this._projectLabel);

        this._issueLabel = new PopupMenu.PopupMenuItem(this._('Issue: None'), {reactive: false});
        this.menu.addMenuItem(this._issueLabel);

        // Open links buttons
        this._openProjectButton = new PopupMenu.PopupMenuItem(this._('Open project in browser'));
        this._openProjectButton.connect('activate', () => this._openProjectInBrowser());
        this._openProjectButton.visible = false;
        this.menu.addMenuItem(this._openProjectButton);

        this._openIssueButton = new PopupMenu.PopupMenuItem(this._('Open issue in browser'));
        this._openIssueButton.connect('activate', () => this._openIssueInBrowser());
        this._openIssueButton.visible = false;
        this.menu.addMenuItem(this._openIssueButton);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Timer display
        this._timerLabel = new PopupMenu.PopupMenuItem('00:00:00', {reactive: false});
        this._timerLabel.label.add_style_class_name('gitlab-timer-label');
        this.menu.addMenuItem(this._timerLabel);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Control buttons
        this._startButton = new PopupMenu.PopupMenuItem(this._('Start'));
        this._startButton.connect('activate', () => this._startTimer());
        this.menu.addMenuItem(this._startButton);

        this._pauseButton = new PopupMenu.PopupMenuItem(this._('Pause'));
        this._pauseButton.connect('activate', () => this._pauseTimer());
        this._pauseButton.visible = false;
        this.menu.addMenuItem(this._pauseButton);

        this._stopButton = new PopupMenu.PopupMenuItem(this._('Stop & Send'));
        this._stopButton.connect('activate', () => this._stopTimer());
        this._stopButton.visible = false;
        this.menu.addMenuItem(this._stopButton);

        this._cancelButton = new PopupMenu.PopupMenuItem(this._('Cancel'));
        this._cancelButton.connect('activate', () => this._cancelTimer());
        this._cancelButton.visible = false;
        this.menu.addMenuItem(this._cancelButton);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Report button
        let reportItem = new PopupMenu.PopupMenuItem(this._('Monthly Report'));
        reportItem.connect('activate', () => {
            this._openReport();
        });
        this.menu.addMenuItem(reportItem);

        // Settings button
        let settingsItem = new PopupMenu.PopupMenuItem(this._('Settings'));
        settingsItem.connect('activate', () => {
            this._extension.openPreferences();
        });
        this.menu.addMenuItem(settingsItem);
    }

    _openIssueSelector() {
        console.debug('GitLab Timer: Opening issue selector...');
        if (!this._validateSettings()) {
            console.debug('GitLab Timer: Settings validation failed');
            return;
        }

        try {
            const gjs = GLib.find_program_in_path('gjs') || 'gjs';
            this._selectorProcess = Gio.Subprocess.new(
                [gjs, '-m', `${this._extensionPath}/selectorWindow.js`],
                Gio.SubprocessFlags.NONE
            );
            console.debug('GitLab Timer: Selector window launched successfully');
        } catch (e) {
            console.debug('GitLab Timer: Error opening issue selector: ' + e.message);
            console.debug('Stack trace: ' + e.stack);
            Main.notify(this._('Error'), this._('Unable to open selector') + ': ' + e.message);
        }
    }

    _applySelectionState() {
        try {
            const stateJson = this._settings.get_string('selection-state');
            if (!stateJson || stateJson === '{}')
                return;

            const state = JSON.parse(stateJson);
            if (!state.project || !state.issue)
                return;

            this._setSelectedIssue(state.project, state.issue);
            this._settings.set_string('selection-state', '{}');
        } catch (e) {
            console.debug(`GitLab Timer: Unable to apply selector state: ${e.message}`);
            this._settings.set_string('selection-state', '{}');
        }
    }

    _setSelectedIssue(project, issue) {
        this._selectedProject = project;
        this._selectedIssue = issue;
        if (!getDefaultProject(this._settings))
            setDefaultProject(this._settings, project);
        this._projectLabel.label.text = `${this._('Project')}: ${project.path_with_namespace}`;
        this._issueLabel.label.text = `${this._('Issue')}: #${issue.iid} - ${issue.title.length > 40 ? issue.title.substring(0, 40) + '...' : issue.title}`;
        this._openProjectButton.visible = true;
        this._openIssueButton.visible = true;
        this._saveTimerState();
    }

    _openProjectInBrowser() {
        if (!this._selectedProject) {
            Main.notify(this._('GitLab Issues Timer'), this._('No project selected'));
            return;
        }

        // Use the web_url from the GitLab API response
        const projectUrl = this._selectedProject.web_url;

        if (!projectUrl) {
            Main.notify(this._('Error'), this._('Project URL not available'));
            console.debug('GitLab Timer: Project web_url is missing');
            return;
        }

        try {
            Gio.AppInfo.launch_default_for_uri(projectUrl, null);
        } catch (e) {
            Main.notify(this._('Error'), this._('Unable to open browser') + ': ' + e.message);
            console.debug('GitLab Timer: Error opening project URL:', e.message);
        }
    }

    _openIssueInBrowser() {
        if (!this._selectedProject || !this._selectedIssue) {
            Main.notify(this._('GitLab Issues Timer'), this._('No issue selected'));
            return;
        }

        // Use the web_url from the GitLab API response
        const issueUrl = this._selectedIssue.web_url;

        if (!issueUrl) {
            Main.notify(this._('Error'), this._('Issue URL not available'));
            console.debug('GitLab Timer: Issue web_url is missing');
            return;
        }

        try {
            Gio.AppInfo.launch_default_for_uri(issueUrl, null);
        } catch (e) {
            Main.notify(this._('Error'), this._('Unable to open browser') + ': ' + e.message);
            console.debug('GitLab Timer: Error opening issue URL:', e.message);
        }
    }

    _startTimer() {
        if (!this._selectedProject || !this._selectedIssue) {
            Main.notify(this._('GitLab Issues Timer'), this._('Please select a project and an issue'));
            return;
        }

        this._timerRunning = true;
        this._timerPaused = false;
        this._timerStartTimestamp = Math.floor(Date.now() / 1000) - this._elapsedSeconds;

        // Remove existing timeout before creating a new one
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (!this._timerPaused) {
                this._elapsedSeconds++;
                this._updateTimerDisplay();
                // Save state every 5 seconds for crash/session end recovery
                if (this._elapsedSeconds % 5 === 0) {
                    this._saveTimerState();
                }
            }
            return GLib.SOURCE_CONTINUE;
        });

        this._updateButtonVisibility();
        this._updateIcon();
        this._saveTimerState();
    }

    _pauseTimer() {
        if (this._timerPaused) {
            this._timerPaused = false;
            this._pauseButton.label.text = this._('Pause');
        } else {
            this._timerPaused = true;
            this._pauseButton.label.text = this._('Resume');
        }
        this._updateIcon();
        this._saveTimerState();
    }

    _stopTimer() {
        if (!this._timerRunning) return;

        const duration = this._formatGitLabDuration(this._elapsedSeconds);
        const dialog = new TimeEntryDialog(this._, this._selectedProject, this._selectedIssue, duration, (editedDuration, comment) => {
            this._sendTimeToGitLab(editedDuration, comment);
            this._resetTimer();
        });

        dialog.open();
    }

    _cancelTimer() {
        this._resetTimer();
        Main.notify(this._('GitLab Issues Timer'), this._('Timer cancelled'));
    }

    _toggleTimerFromShortcut() {
        if (!this._selectedProject || !this._selectedIssue) {
            this._openIssueSelector();
        } else if (!this._timerRunning) {
            this._startTimer();
        } else {
            this._pauseTimer();
        }
    }

    _stopTimerFromShortcut() {
        if (this._timerRunning)
            this._stopTimer();
    }

    _cancelTimerFromShortcut() {
        if (this._timerRunning)
            this._cancelTimer();
    }

    _resetTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }

        this._timerRunning = false;
        this._timerPaused = false;
        this._elapsedSeconds = 0;
        this._updateTimerDisplay();
        this._updateButtonVisibility();
        this._updateIcon();
        this._saveTimerState();
    }

    _updateTimerDisplay() {
        const hours = Math.floor(this._elapsedSeconds / 3600);
        const minutes = Math.floor((this._elapsedSeconds % 3600) / 60);
        const seconds = this._elapsedSeconds % 60;

        const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        this._timerLabel.label.text = timeString;
    }

    _updateButtonVisibility() {
        this._startButton.visible = !this._timerRunning;
        this._pauseButton.visible = this._timerRunning;
        this._stopButton.visible = this._timerRunning;
        this._cancelButton.visible = this._timerRunning;
    }

    _updateIcon() {
        if (!this._timerRunning) {
            // Timer stopped - show stop icon
            this._icon.gicon = this._getIconGicon('timer-outline-symbolic.svg');
        } else if (this._timerPaused) {
            // Timer paused - show pause icon
            this._icon.gicon = this._getIconGicon('timer-pause-outline-symbolic.svg');
        } else {
            // Timer running - show play/recording icon
            this._icon.gicon = this._getIconGicon('timer-play-outline-symbolic.svg');
        }
    }

    _formatGitLabDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);

        let duration = '';
        if (hours > 0) duration += `${hours}h`;
        if (minutes > 0) duration += `${minutes}m`;

        return duration || '1m';
    }

    _sendTimeToGitLab(duration, comment) {
        const url = this._settings.get_string('gitlab-url');
        const token = this._settings.get_string('gitlab-token');
        const project = this._selectedProject;
        const issue = this._selectedIssue;
        const params = [['duration', duration]];

        if (comment)
            params.push(['summary', comment]);

        const query = params
            .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
            .join('&');
        const apiUrl = `${url}/api/v4/projects/${project.id}/issues/${issue.iid}/add_spent_time?${query}`;

        const message = Soup.Message.new('POST', apiUrl);
        message.request_headers.append('PRIVATE-TOKEN', token);

        this._httpSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    session.send_and_read_finish(result);
                    if (message.status_code === 201 || message.status_code === 200) {
                        addRecentIssue(this._settings, project, issue);
                        Main.notify(this._('GitLab Issues Timer'), `${this._('Time sent')}: ${duration} ${this._('on issue')} #${issue.iid}`);
                    } else if (message.status_code === 401 || message.status_code === 403) {
                        Main.notify(this._('Error'), this._('Please configure the server URL and token in preferences'));
                    } else {
                        Main.notify(this._('Error'), `${this._('Unable to send time')}: ${message.status_code}`);
                    }
                } catch (e) {
                    Main.notify(this._('Error'), `${this._('Error sending time')}: ${e.message}`);
                }
            }
        );
    }

    _openReport() {
        console.debug('GitLab Timer: Opening report dialog...');
        if (!this._validateSettings()) {
            console.debug('GitLab Timer: Settings validation failed');
            return;
        }

        try {
            const gjs = GLib.find_program_in_path('gjs') || 'gjs';
            const args = [gjs, '-m', `${this._extensionPath}/reportWindow.js`];
            if (this._selectedProject?.id)
                args.push(String(this._selectedProject.id));

            Gio.Subprocess.new(args, Gio.SubprocessFlags.NONE);
            console.debug('GitLab Timer: Report window launched successfully');
        } catch (e) {
            console.debug('GitLab Timer: Error opening report window: ' + e.message);
            Main.notify(this._('Error'), this._('Unable to open report') + ': ' + e.message);
        }
    }

    _saveTimerState() {
        const projectData = serializeProject(this._selectedProject);
        const issueData = serializeIssue(this._selectedIssue);

        if (this._timerRunning) {
            const state = {
                running: this._timerRunning,
                paused: this._timerPaused,
                startTimestamp: this._timerStartTimestamp,
                elapsedSeconds: this._elapsedSeconds,
                project: projectData,
                issue: issueData
            };
            this._settings.set_string('timer-state', JSON.stringify(state));
            console.debug(`GitLab Timer: Saved timer state (paused: ${this._timerPaused}, elapsed: ${this._elapsedSeconds})`);
        } else if (projectData) {
            // Even if timer is not running, save the selected project for session persistence
            const state = {
                running: false,
                paused: false,
                project: projectData,
                issue: issueData
            };
            this._settings.set_string('timer-state', JSON.stringify(state));
            console.debug('GitLab Timer: Saved project state (timer not running)');
        } else {
            this._settings.set_string('timer-state', '{}');
        }
    }

    _restoreTimerState() {
        try {
            const stateJson = this._settings.get_string('timer-state');
            if (!stateJson || stateJson === '{}') return;

            const state = JSON.parse(stateJson);

            console.debug('GitLab Timer: Restoring timer state...');

            // Restore project and issue selection
            this._selectedProject = state.project;
            this._selectedIssue = state.issue;

            // If timer was not running, just restore project/issue selection
            if (!state.running) {
                console.debug('GitLab Timer: Restored project selection (timer was not running)');
                return;
            }

            this._timerRunning = true;
            this._timerStartTimestamp = state.startTimestamp;

            // Check settings
            const resumeOnUnlock = this._settings.get_boolean('resume-on-unlock');
            const countTimeWhenLocked = this._settings.get_boolean('count-time-when-locked');

            // Handle restore based on settings
            if (resumeOnUnlock) {
                // Option 1: Resume automatically
                this._timerPaused = false;

                if (countTimeWhenLocked) {
                    // Count time elapsed since timer was started
                    const now = Math.floor(Date.now() / 1000);
                    this._elapsedSeconds = now - state.startTimestamp;
                    console.debug(`GitLab Timer: Timer resumed with calculated time: ${this._elapsedSeconds} seconds`);
                } else {
                    // Use saved elapsed time (don't count time during lock/shutdown)
                    this._elapsedSeconds = state.elapsedSeconds;
                    console.debug(`GitLab Timer: Timer resumed with saved time: ${this._elapsedSeconds} seconds`);
                }
            } else {
                // Default: restore in paused state with saved time
                this._timerPaused = true;
                this._elapsedSeconds = state.elapsedSeconds;
                console.debug('GitLab Timer: Timer restored in paused state');
            }

            // Restart the timer interval
            this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                if (!this._timerPaused) {
                    this._elapsedSeconds++;
                    // Save state every 5 seconds for crash/session end recovery
                    if (this._elapsedSeconds % 5 === 0) {
                        this._saveTimerState();
                    }
                }
                this._updateTimerDisplay();
                return GLib.SOURCE_CONTINUE;
            });

            console.debug(`GitLab Timer: Timer restored with ${this._elapsedSeconds} seconds (paused: ${this._timerPaused})`);
        } catch (e) {
            console.debug(`GitLab Timer: Error restoring timer state: ${e.message}`);
            this._settings.set_string('timer-state', '{}');
        }
    }

    _updateUIAfterRestore() {
        // Update timer display
        this._updateTimerDisplay();
        // Update button visibility
        this._updateButtonVisibility();
        // Update icon
        this._updateIcon();
        // Update pause button text if paused
        if (this._timerPaused) {
            this._pauseButton.label.text = this._('Resume');
        }
        // Update project label
        if (this._selectedProject) {
            this._projectLabel.label.text = `${this._('Project')}: ${this._selectedProject.path_with_namespace}`;
            this._openProjectButton.visible = true;
        }
        // Update issue label
        if (this._selectedIssue) {
            this._issueLabel.label.text = `${this._('Issue')}: #${this._selectedIssue.iid} - ${this._selectedIssue.title.length > 40 ? this._selectedIssue.title.substring(0, 40) + '...' : this._selectedIssue.title}`;
            this._openIssueButton.visible = true;
        }
    }

    destroy() {
        console.debug('GitLab Timer: destroy() called');

        // Save timer state before destroying
        this._saveTimerState();

        // Force GSettings to sync to disk (important for session end)
        Gio.Settings.sync();

        // Abort any pending HTTP requests
        this._httpSession.abort();

        if (this._selectionChangedId) {
            this._settings.disconnect(this._selectionChangedId);
            this._selectionChangedId = null;
        }

        if (this._timerId) {
            GLib.source_remove(this._timerId);
        }
        super.destroy();
    }
});

export default class GitLabIssuesExtension extends Extension {
    enable() {
        this._indicator = new GitLabIssuesIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._settings = this.getSettings();
        this._keybindings = [
            ['toggle-timer-shortcut', () => this._indicator?._toggleTimerFromShortcut()],
            ['stop-send-shortcut', () => this._indicator?._stopTimerFromShortcut()],
            ['cancel-timer-shortcut', () => this._indicator?._cancelTimerFromShortcut()],
            ['select-issue-shortcut', () => this._indicator?._openIssueSelector()],
            ['monthly-report-shortcut', () => this._indicator?._openReport()],
        ];

        for (const [name, callback] of this._keybindings) {
            Main.wm.addKeybinding(
                name,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                callback
            );
        }
    }

    disable() {
        if (this._keybindings) {
            for (const [name] of this._keybindings)
                Main.wm.removeKeybinding(name);
            this._keybindings = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._settings = null;
    }
}
