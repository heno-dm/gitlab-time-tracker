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
        this._timeEntryDialog = null;
        this._sendingTime = false;
        this._destroyed = false;
        this._pausedSessions = [];
        this._queueRequestId = 0;
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
        this._refreshWorkMenu();
        this._updateButtonVisibility();
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._loadDoingQueue();
        });
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
        this._workingHeading = new PopupMenu.PopupMenuItem(this._('No active timer'), {reactive: false});
        this.menu.addMenuItem(this._workingHeading);

        let selectButton = new PopupMenu.PopupMenuItem(this._('Find another issue…'));
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
        this._timerLabel = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._timerLabel.label = new St.Label({text: '00:00:00', x_expand: true});
        this._timerLabel.add_child(this._timerLabel.label);
        this._timerLabel.label.add_style_class_name('gitlab-timer-label');
        this._submitButton = new St.Button({label: this._('Submit'), style_class: 'button', can_focus: true});
        this._submitButton.connect('clicked', () => {
            this.menu.close();
            this._stopTimer();
        });
        this._timerLabel.add_child(this._submitButton);
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

        this._cancelButton = new PopupMenu.PopupMenuItem(this._('Cancel'));
        this._cancelButton.connect('activate', () => this._cancelTimer());
        this._cancelButton.visible = false;
        this.menu.addMenuItem(this._cancelButton);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(this._('Paused work'), {reactive: false}));
        this._pausedSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._pausedSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(this._('My Doing — board order'), {reactive: false}));
        this._queueSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._queueSection);
        this._queueSection.addMenuItem(new PopupMenu.PopupMenuItem(this._('Open the menu to refresh your queue'), {reactive: false}));
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
        if (this._sendingTime || this._timeEntryDialog) {
            Main.notify(this._('GitLab Issues Timer'), this._('Finish the time entry before switching issues'));
            return;
        }

        console.debug('GitLab Timer: Opening issue selector...');
        if (!this._validateSettings()) {
            console.debug('GitLab Timer: Settings validation failed');
            return;
        }

        try {
            this._selectorProcess = Gio.Subprocess.new(
                ['gjs', '-m', `${this._extensionPath}/selectorWindow.js`],
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
        if (this._sendingTime || this._timeEntryDialog) {
            Main.notify(this._('GitLab Issues Timer'), this._('Finish the time entry before switching issues'));
            return;
        }

        if (this._matchesIssue(this._currentSession(), project, issue)) {
            if (!this._timerRunning)
                this._startTimer();
            else if (this._timerPaused)
                this._pauseTimer();
            return;
        }

        const previous = this._currentSession();
        const resumed = this._pausedSessions.find(session => this._matchesIssue(session, project, issue));
        this._pausedSessions = this._pausedSessions.filter(session =>
            !this._matchesIssue(session, project, issue) &&
            !this._matchesIssue(session, previous?.project, previous?.issue));
        if (this._timerRunning && previous)
            this._pausedSessions.unshift(previous);

        this._removeTimerSource();
        this._selectedProject = project;
        this._selectedIssue = issue;
        this._elapsedSeconds = resumed?.elapsedSeconds || 0;
        if (!getDefaultProject(this._settings))
            setDefaultProject(this._settings, project);
        this._projectLabel.label.set_text(`${this._('Project')}: ${project.path_with_namespace}`);
        this._issueLabel.label.set_text(`${this._('Issue')}: #${issue.iid} - ${issue.title.length > 40 ? issue.title.substring(0, 40) + '...' : issue.title}`);
        this._openProjectButton.visible = true;
        this._openIssueButton.visible = true;
        this._startTimer();
        this._updateTimerDisplay();
        this._refreshWorkMenu();
    }

    _currentSession() {
        if (!this._selectedProject || !this._selectedIssue)
            return null;
        return {project: serializeProject(this._selectedProject), issue: serializeIssue(this._selectedIssue),
            elapsedSeconds: this._elapsedSeconds};
    }

    _matchesIssue(session, project, issue) {
        return Boolean(session && project && issue && session.project.id === project.id && session.issue.iid === issue.iid);
    }

    _refreshWorkMenu() {
        this._pausedSection.removeAll();
        if (this._pausedSessions.length === 0)
            this._pausedSection.addMenuItem(new PopupMenu.PopupMenuItem(this._('No paused work'), {reactive: false}));

        for (const session of this._pausedSessions) {
            const row = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            const switchButton = new St.Button({
                label: `#${session.issue.iid} — ${session.issue.title}`,
                style_class: 'button gitlab-work-title', x_expand: true, can_focus: true,
            });
            switchButton.accessible_name = `${session.project.path_with_namespace}: ${session.issue.title}`;
            switchButton.connect('clicked', () => {
                this.menu.close();
                this._setSelectedIssue(session.project, session.issue);
            });
            row.add_child(switchButton);
            row.add_child(new St.Label({text: this._formatElapsed(session.elapsedSeconds)}));
            const submit = new St.Button({label: this._('Submit'), style_class: 'button', can_focus: true,
                reactive: !this._sendingTime, visible: session.elapsedSeconds > 0});
            submit.connect('clicked', () => {
                this.menu.close();
                this._showTimeEntry(session);
            });
            row.add_child(submit);
            this._pausedSection.addMenuItem(row);
        }
    }

    _loadDoingQueue() {
        const requestId = ++this._queueRequestId;
        const project = getDefaultProject(this._settings) || this._selectedProject;
        this._queueSection.removeAll();
        const status = new PopupMenu.PopupMenuItem(this._('Loading…'), {reactive: false});
        this._queueSection.addMenuItem(status);
        if (!project) {
            status.label.set_text(this._('Find an issue to choose your project first'));
            return;
        }
        const url = this._settings.get_string('gitlab-url');
        const token = this._settings.get_string('gitlab-token');
        if (!url || !token) {
            status.label.set_text(this._('Please configure the server URL and token in preferences'));
            return;
        }
        const onError = error => {
            this._queueSection.removeAll();
            this._queueSection.addMenuItem(new PopupMenu.PopupMenuItem(`${this._('Unable to load Doing queue')}: ${error}`, {reactive: false}));
        };
        this._queueGet('/user', requestId, user => {
            const labels = this._settings.get_string('doing-labels').trim();
            const query = `state=opened&assignee_id=${user.id}&order_by=relative_position&sort=asc&per_page=100` +
                (labels ? `&labels=${encodeURIComponent(labels)}` : '');
            this._queueGet(`/projects/${project.id}/issues?${query}`, requestId, issues => {
                this._queueSection.removeAll();
                const available = issues.filter(issue =>
                    !(this._timerRunning && this._matchesIssue(this._currentSession(), project, issue)) &&
                    !this._pausedSessions.some(session => this._matchesIssue(session, project, issue)));
                if (available.length === 0)
                    this._queueSection.addMenuItem(new PopupMenu.PopupMenuItem(this._('No other issues in Doing'), {reactive: false}));
                for (const issue of available.slice(0, 20)) {
                    const item = new PopupMenu.PopupMenuItem(`#${issue.iid} — ${issue.title}`);
                    item.connect('activate', () => this._setSelectedIssue(project, issue));
                    this._queueSection.addMenuItem(item);
                }
                if (available.length > 20 || issues.length === 100) {
                    const more = new PopupMenu.PopupMenuItem(this._('Find more issues…'));
                    more.connect('activate', () => this._openIssueSelector());
                    this._queueSection.addMenuItem(more);
                }
            }, onError);
        }, onError);
    }

    _queueGet(path, requestId, onSuccess, onError) {
        const url = this._settings.get_string('gitlab-url');
        const token = this._settings.get_string('gitlab-token');
        const isCurrent = () => !this._destroyed && requestId === this._queueRequestId &&
            url === this._settings.get_string('gitlab-url') && token === this._settings.get_string('gitlab-token');
        try {
            const message = Soup.Message.new('GET', `${url}/api/v4${path}`);
            if (!message)
                throw new Error(this._('Invalid GitLab server URL'));
            message.request_headers.append('PRIVATE-TOKEN', token);
            this._httpSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (!isCurrent())
                        return;
                    if (message.status_code !== 200)
                        throw new Error(String(message.status_code));
                    onSuccess(JSON.parse(new TextDecoder().decode(bytes.get_data())));
                } catch (e) {
                    if (isCurrent())
                        onError(e.message);
                }
            });
        } catch (e) {
            if (isCurrent())
                onError(e.message);
        }
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
        if (this._sendingTime || this._timeEntryDialog)
            return;

        if (!this._selectedProject || !this._selectedIssue) {
            Main.notify(this._('GitLab Issues Timer'), this._('Please select a project and an issue'));
            return;
        }

        this._timerRunning = true;
        this._timerPaused = false;
        this._timerStartTimestamp = Math.floor(Date.now() / 1000) - this._elapsedSeconds;

        this._startTimerSource();

        this._updateButtonVisibility();
        this._updateIcon();
        this._saveTimerState();
    }

    _startTimerSource() {
        this._removeTimerSource();
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
    }

    _removeTimerSource() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _pauseTimer() {
        if (this._sendingTime || this._timeEntryDialog)
            return;

        if (this._timerPaused) {
            this._timerPaused = false;
            this._timerStartTimestamp = Math.floor(Date.now() / 1000) - this._elapsedSeconds;
            this._pauseButton.label.set_text(this._('Pause'));
        } else {
            this._timerPaused = true;
            this._pauseButton.label.set_text(this._('Resume'));
        }
        this._updateIcon();
        this._updateButtonVisibility();
        this._saveTimerState();
    }

    _stopTimer() {
        if (!this._timerRunning || this._sendingTime || this._timeEntryDialog)
            return;

        // Freeze the session while editing/submitting. Cancel and failures leave it
        // paused so no tracked time is lost and the same duration can be retried.
        if (!this._timerPaused)
            this._pauseTimer();

        this._showTimeEntry(this._currentSession());
    }

    _showTimeEntry(session) {
        if (!session || this._sendingTime || this._timeEntryDialog)
            return;

        const duration = this._formatGitLabDuration(session.elapsedSeconds);
        const dialog = new TimeEntryDialog(this._, session.project, session.issue, duration, (editedDuration, comment) => {
            this._sendTimeToGitLab(editedDuration, comment, session);
        });
        this._timeEntryDialog = dialog;
        dialog.connect('closed', () => {
            this._timeEntryDialog = null;
        });

        if (!dialog.open()) {
            this._timeEntryDialog = null;
            dialog.destroy();
        }
    }

    _cancelTimer() {
        if (this._sendingTime || this._timeEntryDialog)
            return;

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
        this._removeTimerSource();

        this._timerRunning = false;
        this._timerPaused = false;
        this._elapsedSeconds = 0;
        this._updateTimerDisplay();
        this._updateButtonVisibility();
        this._updateIcon();
        this._saveTimerState();
        this._refreshWorkMenu();
    }

    _formatElapsed(elapsed) {
        const hours = Math.floor(elapsed / 3600);
        const minutes = Math.floor((elapsed % 3600) / 60);
        const seconds = elapsed % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    _updateTimerDisplay() {
        this._timerLabel.label.set_text(this._formatElapsed(this._elapsedSeconds));
    }

    _updateButtonVisibility() {
        this._workingHeading.label.set_text(this._timerRunning
            ? (this._timerPaused ? this._('Paused') : this._('Working on')) : this._('No active timer'));
        this._pauseButton.label.set_text(this._timerPaused ? this._('Resume') : this._('Pause'));
        this._startButton.visible = !this._timerRunning;
        this._pauseButton.visible = this._timerRunning;
        this._submitButton.visible = this._timerRunning;
        this._cancelButton.visible = this._timerRunning;
        this._pauseButton.setSensitive(!this._sendingTime);
        this._submitButton.reactive = !this._sendingTime;
        this._submitButton.can_focus = !this._sendingTime;
        this._cancelButton.setSensitive(!this._sendingTime);
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

    _sendTimeToGitLab(duration, comment, session = this._currentSession()) {
        if (this._sendingTime || !this._validateSettings())
            return;

        const url = this._settings.get_string('gitlab-url');
        const token = this._settings.get_string('gitlab-token');
        if (!session)
            return;
        const {project, issue} = session;
        const isCurrent = this._matchesIssue(session, this._selectedProject, this._selectedIssue);
        const params = [['duration', duration]];

        if (comment)
            params.push(['summary', comment]);

        const query = params
            .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
            .join('&');
        const apiUrl = `${url}/api/v4/projects/${project.id}/issues/${issue.iid}/add_spent_time?${query}`;

        this._sendingTime = true;
        this._updateButtonVisibility();
        this._refreshWorkMenu();

        try {
            const message = Soup.Message.new('POST', apiUrl);
            if (!message)
                throw new Error(this._('Invalid GitLab server URL'));
            message.request_headers.append('PRIVATE-TOKEN', token);

            this._httpSession.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (session, result) => {
                    try {
                        session.send_and_read_finish(result);
                        if (this._destroyed)
                            return;

                        if (message.status_code === 201 || message.status_code === 200) {
                            if (isCurrent) {
                                this._resetTimer();
                            } else {
                                this._pausedSessions = this._pausedSessions.filter(item => !this._matchesIssue(item, project, issue));
                                this._saveTimerState();
                            }
                            addRecentIssue(this._settings, project, issue);
                            Main.notify(this._('GitLab Issues Timer'), `${this._('Time sent')}: ${duration} ${this._('on issue')} #${issue.iid}`);
                        } else if (message.status_code === 401 || message.status_code === 403) {
                            Main.notify(this._('Error'), this._('Please configure the server URL and token in preferences'));
                        } else {
                            Main.notify(this._('Error'), `${this._('Unable to send time')}: ${message.status_code}`);
                        }
                    } catch (e) {
                        if (!this._destroyed)
                            Main.notify(this._('Error'), `${this._('Error sending time')}: ${e.message}`);
                    } finally {
                        if (!this._destroyed) {
                            this._sendingTime = false;
                            this._updateButtonVisibility();
                            this._refreshWorkMenu();
                        }
                    }
                }
            );
        } catch (e) {
            this._sendingTime = false;
            this._updateButtonVisibility();
            this._refreshWorkMenu();
            Main.notify(this._('Error'), `${this._('Error sending time')}: ${e.message}`);
        }
    }

    _openReport() {
        console.debug('GitLab Timer: Opening report dialog...');
        if (!this._validateSettings()) {
            console.debug('GitLab Timer: Settings validation failed');
            return;
        }

        try {
            Gio.Subprocess.new(
                ['gjs', '-m', `${this._extensionPath}/reportWindow.js`, String(this._selectedProject?.id || '')],
                Gio.SubprocessFlags.NONE
            );
            console.debug('GitLab Timer: Report window launched successfully');
        } catch (e) {
            console.debug('GitLab Timer: Error opening report window: ' + e.message);
            Main.notify(this._('Error'), this._('Unable to open report') + ': ' + e.message);
        }
    }

    _saveTimerState() {
        // Keep the legacy current-timer fields so existing installations migrate
        // without losing time; v2 adds independently paused issue sessions.
        this._settings.set_string('timer-state', JSON.stringify({
            version: 2,
            running: this._timerRunning,
            paused: this._timerPaused,
            startTimestamp: this._timerStartTimestamp,
            elapsedSeconds: this._elapsedSeconds,
            savedAt: Math.floor(Date.now() / 1000),
            project: serializeProject(this._selectedProject),
            issue: serializeIssue(this._selectedIssue),
            pausedSessions: this._pausedSessions,
        }));
    }

    _restoreTimerState() {
        try {
            const stateJson = this._settings.get_string('timer-state');
            if (!stateJson || stateJson === '{}') return;

            const state = JSON.parse(stateJson);
            const pausedSessions = Array.isArray(state.pausedSessions) ? state.pausedSessions : [];
            this._pausedSessions = [...new Map(pausedSessions.filter(session =>
                session?.project?.id && session?.issue?.iid && typeof session.issue.title === 'string' &&
                Number.isFinite(session.elapsedSeconds) && session.elapsedSeconds >= 0 &&
                !this._matchesIssue(session, state.project, state.issue))
                .map(session => [`${session.project.id}:${session.issue.iid}`, session])).values()];

            console.debug('GitLab Timer: Restoring timer state...');

            // Restore project and issue selection
            this._selectedProject = state.project;
            this._selectedIssue = state.issue;
            this._timerRunning = Boolean(state.running);

            // If timer was not running, just restore project/issue selection
            if (!state.running) {
                this._timerPaused = false;
                this._elapsedSeconds = 0;
                console.debug('GitLab Timer: Restored project selection (timer was not running)');
                return;
            }

            this._timerRunning = true;
            this._timerStartTimestamp = state.startTimestamp;

            // Check settings
            const resumeOnUnlock = this._settings.get_boolean('resume-on-unlock');
            const countTimeWhenLocked = this._settings.get_boolean('count-time-when-locked');

            // Handle restore based on settings
            if (resumeOnUnlock && !state.paused) {
                // Option 1: Resume automatically
                this._timerPaused = false;

                if (countTimeWhenLocked) {
                    // Only add downtime since the saved active interval. Older
                    // states lack savedAt: keep their saved duration rather than
                    // reintroducing pauses through the original start timestamp.
                    const now = Math.floor(Date.now() / 1000);
                    const downtime = !state.paused && Number.isFinite(state.savedAt)
                        ? Math.max(0, now - state.savedAt) : 0;
                    this._elapsedSeconds = state.elapsedSeconds + downtime;
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

            this._timerStartTimestamp = Math.floor(Date.now() / 1000) - this._elapsedSeconds;
            this._startTimerSource();

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
            this._pauseButton.label.set_text(this._('Resume'));
        }
        // Update project label
        if (this._selectedProject) {
            this._projectLabel.label.set_text(`${this._('Project')}: ${this._selectedProject.path_with_namespace}`);
            this._openProjectButton.visible = true;
        }
        // Update issue label
        if (this._selectedIssue) {
            this._issueLabel.label.set_text(`${this._('Issue')}: #${this._selectedIssue.iid} - ${this._selectedIssue.title.length > 40 ? this._selectedIssue.title.substring(0, 40) + '...' : this._selectedIssue.title}`);
            this._openIssueButton.visible = true;
        }
    }

    destroy() {
        console.debug('GitLab Timer: destroy() called');
        this._destroyed = true;
        if (this._timeEntryDialog) {
            this._timeEntryDialog.destroy();
            this._timeEntryDialog = null;
        }

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

        this._removeTimerSource();
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
