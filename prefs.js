// Preferences (§2.16): step-based onboarding until connected, then account,
// tracked projects, Doing labels, timer combos and a shortcut-capture subpage.
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {Config, IDLE_MINUTE_OPTIONS, LONG_TIMER_HOUR_OPTIONS, PANEL_CONTENTS, ROUNDING_MINUTE_OPTIONS} from './core/config.js';
import {GitLabClient, normalizeUrl} from './core/gitlabClient.js';
import {IssueSource} from './core/issueSource.js';
import {LOCK_POLICIES} from './core/lockPolicy.js';

/** printf-style %s/%d substitution; String.prototype.format only exists inside GNOME Shell. */
function fmt(template, ...args) {
    let index = 0;
    return String(template).replace(/%[sd]/g, () => String(args[index++]));
}

const SHORTCUTS = [
    ['toggle-timer-shortcut', () => _('Pause or resume timer'), () => _('Opens the menu when nothing is tracked')],
    ['stop-send-shortcut', () => _('Submit time'), () => _('Opens the submit dialog for the active session')],
    ['cancel-timer-shortcut', () => _('Discard timer'), () => _('Undo is offered in a notification')],
    ['select-issue-shortcut', () => _('Search issues'), () => _('Opens the menu with the search focused')],
    ['open-menu-shortcut', () => _('Open menu'), () => _('Opens or closes the menu without clicking the top bar icon')],
    ['monthly-report-shortcut', () => _('Monthly report'), () => _('Opens the report window')],
];

function hostOf(url) {
    try {
        return GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host() || url;
    } catch (e) {
        return url;
    }
}

function chevron() {
    return new Gtk.Image({icon_name: 'go-next-symbolic', valign: Gtk.Align.CENTER});
}

/** Accessible icon button: tooltip plus an explicit accessible label (§2.19). */
function iconButton(iconName, label, {flat = true} = {}) {
    const button = new Gtk.Button({icon_name: iconName, valign: Gtk.Align.CENTER, tooltip_text: label});
    button.update_property([Gtk.AccessibleProperty.LABEL], [label]);
    if (flat)
        button.add_css_class('flat');
    return button;
}

function comboRow({title, subtitle = null, labels, values, current, onChange}) {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(labels)});
    row.set_selected(Math.max(0, values.indexOf(current)));
    row.connect('notify::selected', () => onChange(values[row.get_selected()] ?? values[0]));
    return row;
}

export default class TimelogsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const config = new Config(settings);
        config.migrate();
        this._settings = settings;
        this._config = config;
        this._client = new GitLabClient({url: config.url, token: settings.get_string('gitlab-token')});
        this._issues = new IssueSource({client: this._client, config});
        this._window = window;
        this._checkGeneration = 0;
        this._serverMajorVersion = null;
        this._groups = [];
        this._projectsPage = null;
        // mode: checking | connected | offline | auth | unconfigured
        this._status = {mode: config.url ? 'checking' : 'unconfigured', user: config.cachedUser, error: null};

        this._page = new Adw.PreferencesPage();
        window.add(this._page);
        window.set_default_size(Math.max(window.default_width, 640), Math.max(window.default_height, 720));

        window.connect('close-request', () => {
            this._client.abort();
            return false;
        });

        this._render();
        config.getToken().then(token => {
            this._token = token;
            this._client.setCredentials({url: config.url, token});
            this._checkConnection({openProjectsIfEmpty: true});
        });
    }

    // ---- state -------------------------------------------------------------

    get _connected() {
        return this._status.mode === 'connected' || this._status.mode === 'offline';
    }

    _setStatus(status) {
        const wasOnboarding = this._isOnboarding();
        this._status = status;
        if (this._isOnboarding() !== wasOnboarding || this._groups.length === 0)
            this._render();
        else
            this._updateStatusWidgets();
    }

    _isOnboarding() {
        return this._status.mode === 'unconfigured' || this._status.mode === 'auth';
    }

    async _checkConnection({openProjectsIfEmpty = false} = {}) {
        const generation = ++this._checkGeneration;
        this._serverMajorVersion = null;
        if (!this._client.isConfigured) {
            this._setStatus({mode: 'unconfigured', user: null, error: null});
            return;
        }
        this._setStatus({mode: 'checking', user: this._config.cachedUser, error: null});
        try {
            const user = await this._client.get('/user');
            if (generation !== this._checkGeneration)
                return;
            this._config.cachedUser = {id: user.id, username: user.username, name: user.name};
            this._setStatus({mode: 'connected', user: {id: user.id, username: user.username, name: user.name}, error: null});
            this._client.get('/version').then(version => {
                const major = parseInt(String(version?.version ?? '').split('.')[0], 10);
                this._serverMajorVersion = Number.isFinite(major) ? major : null;
            }).catch(() => {});
            if (openProjectsIfEmpty && this._config.trackedProjects.length === 0)
                this._openProjectsPage();
        } catch (error) {
            if (generation !== this._checkGeneration)
                return;
            if (error?.kind === 'auth') {
                this._config.cachedUser = null;
                this._setStatus({mode: 'auth', user: null, error});
            } else {
                this._setStatus({mode: 'offline', user: this._config.cachedUser, error});
            }
        }
    }

    _describe(error) {
        switch (error?.kind) {
        case 'auth':
            return fmt(_('GitLab answered %d: the token is expired, revoked or missing the api scope.'), error.status || 401);
        case 'network':
            return _('Server not reachable');
        case 'config':
            return _('URL must start with https://');
        default:
            return `${_('Error')}: ${error?.message ?? error}`;
        }
    }

    // ---- rendering ---------------------------------------------------------

    _render() {
        for (const group of this._groups)
            this._page.remove(group);
        this._groups = this._isOnboarding() ? this._buildOnboarding() : this._buildConnected();
        for (const group of this._groups)
            this._page.add(group);
        this._updateStatusWidgets();
    }

    _updateStatusWidgets() {
        const {mode, user, error} = this._status;
        if (this._banner) {
            this._banner.set_title(mode === 'auth'
                ? _("Token rejected — tracking still works, submitting doesn't")
                : _('Not connected to GitLab'));
            if (mode === 'auth')
                this._banner.add_css_class('error');
            else
                this._banner.remove_css_class('error');
        }
        if (this._tokenRow) {
            if (mode === 'auth')
                this._tokenRow.add_css_class('error');
            else
                this._tokenRow.remove_css_class('error');
        }
        if (this._tokenErrorRow) {
            this._tokenErrorRow.visible = mode === 'auth';
            const reason = mode === 'auth' ? this._describe(error) : '';
            if (mode === 'auth')
                this._tokenErrorRow.set_title(reason);
            // The error text doubles as the token row's accessible description (DESCRIBED_BY is not buildable from GJS).
            this._tokenRow?.update_property([Gtk.AccessibleProperty.DESCRIPTION], [reason]);
        }
        if (this._projectsStepRow)
            this._projectsStepRow.sensitive = this._connected;
        if (this._accountRow) {
            const host = hostOf(this._config.url);
            if (mode === 'checking') {
                this._accountRow.set_title(user ? `${user.name} (@${user.username})` : _('Checking…'));
                this._accountRow.set_subtitle(fmt(_('Checking connection to %s…'), host));
            } else if (mode === 'offline') {
                this._accountRow.set_title(user ? `${user.name} (@${user.username})` : host);
                this._accountRow.set_subtitle(`${this._describe(error)} · ${host}`);
            } else if (user) {
                this._accountRow.set_title(`${user.name} (@${user.username})`);
                this._accountRow.set_subtitle(fmt(_('Connected to %s'), host));
            }
        }
        if (this._accountStatusRow)
            this._accountStatusRow.set_subtitle(this._connectionText());
        this._updateStepBadges();
    }

    _connectionText() {
        const {mode, user, error} = this._status;
        switch (mode) {
        case 'checking':
            return _('Checking…');
        case 'connected':
            return `${_('Connected as')} ${user.name} (@${user.username})`;
        case 'offline':
        case 'auth':
            return this._describe(error);
        default:
            return this._config.url ? _('Enter an access token') : _('Enter the server URL');
        }
    }

    // ---- onboarding (not connected) ----------------------------------------

    _buildOnboarding() {
        const config = this._config;
        const groups = [];

        const intro = new Adw.PreferencesGroup();
        this._banner = new Adw.Banner({revealed: true});
        intro.add(this._banner);
        const header = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 24, margin_bottom: 12});
        header.append(new Gtk.Image({icon_name: 'alarm-symbolic', pixel_size: 96, margin_bottom: 12}));
        const title = new Gtk.Label({label: _('Track GitLab time from the top bar'), wrap: true, justify: Gtk.Justification.CENTER});
        title.add_css_class('title-1');
        header.append(title);
        const description = new Gtk.Label({label: _('Three steps. Everything else is optional.'), wrap: true, justify: Gtk.Justification.CENTER});
        description.add_css_class('dim-label');
        header.append(description);
        intro.add(header);
        groups.push(intro);

        const steps = new Adw.PreferencesGroup();
        this._urlRow = new Adw.EntryRow({
            title: _('GitLab server'),
            text: config.url,
            show_apply_button: true,
            input_purpose: Gtk.InputPurpose.URL,
        });
        this._urlBadge = this._stepBadge('1');
        this._urlRow.add_prefix(this._urlBadge);
        this._urlRow.connect('apply', () => this._applyUrl());
        this._urlRow.connect('changed', () => {
            this._updateTokenLink();
            this._updateStepBadges();
        });
        steps.add(this._urlRow);

        this._tokenRow = new Adw.PasswordEntryRow({title: _('Access token'), show_apply_button: true});
        this._tokenBadge = this._stepBadge('2');
        this._tokenRow.add_prefix(this._tokenBadge);
        this._tokenRow.connect('apply', () => this._applyToken());
        this._tokenLinkButton = new Gtk.Button({label: _('Create token…'), valign: Gtk.Align.CENTER, tooltip_text:
            _('Opens GitLab with the name and api scope prefilled')});
        this._tokenLinkButton.add_css_class('flat');
        this._tokenLinkButton.connect('clicked', () => this._openTokenPage());
        this._tokenRow.add_suffix(this._tokenLinkButton);
        steps.add(this._tokenRow);
        this._tokenErrorRow = new Adw.ActionRow({activatable: false, selectable: false, visible: false});
        this._tokenErrorRow.add_css_class('error');
        this._tokenErrorRow.add_prefix(new Gtk.Image({icon_name: 'dialog-error-symbolic', valign: Gtk.Align.CENTER}));
        steps.add(this._tokenErrorRow);
        this._updateTokenWarning();

        this._projectsStepRow = new Adw.ActionRow({title: _('Choose projects'), activatable: true, sensitive: false});
        this._projectsStepRow.add_prefix(this._stepBadge('3'));
        this._projectsStepRow.add_suffix(chevron());
        this._projectsStepRow.connect('activated', () => this._openProjectsPage());
        this._updateProjectsSubtitle(this._projectsStepRow);
        steps.add(this._projectsStepRow);
        groups.push(steps);

        this._accountRow = null;
        this._accountStatusRow = null;
        this._updateTokenLink();
        return groups;
    }

    /** Numbered badge that turns into a check mark once the step is valid. */
    _stepBadge(number) {
        const stack = new Gtk.Stack({valign: Gtk.Align.CENTER});
        const label = new Gtk.Label({label: number, width_chars: 2});
        label.add_css_class('numeric');
        label.add_css_class('dim-label');
        stack.add_named(label, 'number');
        const check = new Gtk.Image({icon_name: 'emblem-ok-symbolic'});
        check.add_css_class('success');
        stack.add_named(check, 'done');
        return stack;
    }

    _updateStepBadges() {
        if (!this._urlBadge)
            return;
        const urlValid = this._tokenPageUrl() !== null && this._config.url !== '';
        this._urlBadge.set_visible_child_name(urlValid ? 'done' : 'number');
        this._tokenBadge?.set_visible_child_name(this._connected ? 'done' : 'number');
    }

    // ---- connected ---------------------------------------------------------

    _buildConnected() {
        const config = this._config;
        const groups = [];
        this._banner = null;
        this._tokenRow = null;
        this._tokenErrorRow = null;
        this._urlBadge = null;
        this._tokenBadge = null;
        this._projectsStepRow = null;

        const gitlab = new Adw.PreferencesGroup({title: _('GitLab')});
        this._accountRow = new Adw.ActionRow({title: '', activatable: true});
        this._accountRow.add_prefix(new Gtk.Image({icon_name: 'avatar-default-symbolic', valign: Gtk.Align.CENTER}));
        this._accountRow.add_suffix(chevron());
        this._accountRow.connect('activated', () => this._openAccountPage());
        gitlab.add(this._accountRow);

        this._projectsRow = new Adw.ActionRow({title: _('Tracked projects'), activatable: true});
        this._projectsRow.add_suffix(chevron());
        this._projectsRow.connect('activated', () => this._openProjectsPage());
        this._updateProjectsSubtitle(this._projectsRow);
        gitlab.add(this._projectsRow);

        const labelsRow = new Adw.EntryRow({
            title: _('Doing labels'),
            text: config.doingLabels,
            show_apply_button: true,
            tooltip_text: _('Exact GitLab label names, comma-separated. Leave empty to show all your open issues.'),
        });
        labelsRow.connect('apply', () => {
            config.doingLabels = labelsRow.get_text();
        });
        gitlab.add(labelsRow);
        groups.push(gitlab);

        const timer = new Adw.PreferencesGroup({title: _('Timer')});
        timer.add(comboRow({
            title: _('Top bar shows'),
            labels: [_('Time'), _('Issue and time'), _('Icon only')],
            values: PANEL_CONTENTS,
            current: config.panelContent,
            onChange: value => {
                config.panelContent = value;
            },
        }));
        timer.add(comboRow({
            title: _('When the screen locks'),
            subtitle: _('Also applies to logout, restart and crashes'),
            labels: [_('Pause and tell me'), _('Keep counting'), _('Pause, resume on unlock')],
            values: LOCK_POLICIES,
            current: config.lockBehaviour,
            onChange: value => {
                config.lockBehaviour = value;
            },
        }));
        const minutes = value => value === 0 ? _('Off') : fmt(_('%d minutes'), value);
        timer.add(comboRow({
            title: _('Ask about idle time'),
            subtitle: _('After returning from being away while a session runs'),
            labels: IDLE_MINUTE_OPTIONS.map(minutes),
            values: IDLE_MINUTE_OPTIONS,
            current: config.idleMinutes,
            onChange: value => {
                config.idleMinutes = value;
            },
        }));
        timer.add(comboRow({
            title: _('Remind me of long timers'),
            labels: LONG_TIMER_HOUR_OPTIONS.map(value => value === 0 ? _('Off') : fmt(_('%d hours'), value)),
            values: LONG_TIMER_HOUR_OPTIONS,
            current: config.longTimerHours,
            onChange: value => {
                config.longTimerHours = value;
            },
        }));
        timer.add(comboRow({
            title: _('Rounding step'),
            subtitle: _('For the quick-adjust chips in the submit dialog'),
            labels: ROUNDING_MINUTE_OPTIONS.map(minutes),
            values: ROUNDING_MINUTE_OPTIONS,
            current: config.roundingMinutes,
            onChange: value => {
                config.roundingMinutes = value;
            },
        }));
        groups.push(timer);

        const shortcuts = new Adw.PreferencesGroup();
        const row = new Adw.ActionRow({title: _('Keyboard shortcuts'), activatable: true});
        row.add_suffix(chevron());
        row.connect('activated', () => this._openShortcutsPage());
        shortcuts.add(row);
        groups.push(shortcuts);
        return groups;
    }

    _openAccountPage() {
        const config = this._config;
        const content = new Adw.ToolbarView();
        content.add_top_bar(new Adw.HeaderBar());
        const navPage = new Adw.NavigationPage({title: _('GitLab account'), child: content});
        const prefsPage = new Adw.PreferencesPage();
        content.set_content(prefsPage);

        const group = new Adw.PreferencesGroup();
        this._urlRow = new Adw.EntryRow({
            title: _('Server URL'),
            text: config.url,
            show_apply_button: true,
            input_purpose: Gtk.InputPurpose.URL,
        });
        this._urlRow.connect('apply', () => this._applyUrl());
        this._urlRow.connect('changed', () => this._updateTokenLink());
        group.add(this._urlRow);

        this._tokenRow = new Adw.PasswordEntryRow({title: _('Access token'), show_apply_button: true});
        this._tokenRow.connect('apply', () => this._applyToken());
        group.add(this._tokenRow);
        this._updateTokenWarning();

        this._accountStatusRow = new Adw.ActionRow({title: _('Connection'), subtitle: this._connectionText()});
        const refresh = iconButton('view-refresh-symbolic', _('Check connection'));
        refresh.connect('clicked', () => this._checkConnection());
        this._accountStatusRow.add_suffix(refresh);
        group.add(this._accountStatusRow);

        this._tokenLinkRow = new Adw.ActionRow({
            title: _('Create access token…'),
            subtitle: _('Opens GitLab with the name and api scope prefilled'),
            activatable: true,
        });
        this._tokenLinkRow.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic', valign: Gtk.Align.CENTER}));
        this._tokenLinkRow.connect('activated', () => this._openTokenPage());
        group.add(this._tokenLinkRow);
        prefsPage.add(group);

        const signOutGroup = new Adw.PreferencesGroup();
        const signOut = new Gtk.Button({label: _('Sign out'), halign: Gtk.Align.CENTER, margin_top: 12});
        signOut.add_css_class('destructive-action');
        signOut.add_css_class('pill');
        signOut.set_tooltip_text(_('Removes the token; tracked time is kept'));
        signOut.connect('clicked', () => this._signOut(navPage));
        signOutGroup.add(signOut);
        prefsPage.add(signOutGroup);

        navPage.connect('hidden', () => {
            this._urlRow = null;
            this._tokenRow = null;
            this._tokenLinkRow = null;
            this._accountStatusRow = null;
        });
        this._updateTokenLink();
        this._window.push_subpage(navPage);
    }

    async _signOut(navPage) {
        await this._config.setToken('');
        this._token = '';
        this._config.cachedUser = null;
        this._client.setCredentials({url: this._config.url, token: ''});
        this._issues.invalidate();
        this._window.pop_subpage();
        this._setStatus({mode: 'unconfigured', user: null, error: null});
    }

    // ---- URL / token -------------------------------------------------------

    _tokenPageUrl() {
        try {
            const url = normalizeUrl(this._urlRow?.get_text() ?? this._config.url);
            return `${url}/-/user_settings/personal_access_tokens?name=Timelogs%20Extension&scopes=api`;
        } catch (e) {
            return null;
        }
    }

    _updateTokenLink() {
        const valid = this._tokenPageUrl() !== null;
        if (this._tokenLinkRow)
            this._tokenLinkRow.sensitive = valid;
        if (this._tokenLinkButton)
            this._tokenLinkButton.sensitive = valid;
    }

    _openTokenPage() {
        const url = this._tokenPageUrl();
        if (!url)
            return;
        // GitLab < 16 serves the tokens page under /-/profile instead.
        const legacy = url.replace('/-/user_settings/', '/-/profile/');
        const target = this._serverMajorVersion !== null && this._serverMajorVersion < 16 ? legacy : url;
        Gtk.show_uri(this._window, target, Gdk.CURRENT_TIME);
    }

    async _applyUrl() {
        const config = this._config;
        const previousUrl = config.url;
        let url;
        try {
            url = normalizeUrl(this._urlRow.get_text());
        } catch (e) {
            this._urlRow.add_css_class('error');
            this._urlRow.set_tooltip_text(_('URL must start with https://'));
            return;
        }
        this._urlRow.remove_css_class('error');
        this._urlRow.set_tooltip_text(null);
        this._urlRow.set_text(url);
        if (url !== previousUrl) {
            // Keep the token available under the new server address.
            const token = this._tokenRow?.get_text().trim() || await config.getToken(previousUrl);
            config.url = url;
            if (token)
                await config.setToken(token, url);
            config.trackedProjects = [];
            this._updateProjectsSubtitle(this._projectsRow);
            this._updateProjectsSubtitle(this._projectsStepRow);
        }
        this._updateStepBadges();
        await this._reconnect();
    }

    async _applyToken() {
        const token = this._tokenRow.get_text().trim();
        await this._config.setToken(token);
        this._updateTokenWarning();
        await this._reconnect();
    }

    _updateTokenWarning() {
        if (!this._tokenRow)
            return;
        const warning = this._config.tokenStorageWarning;
        this._tokenRow.set_tooltip_text(warning ? _('Stored unencrypted — libsecret not available') : null);
        if (warning)
            this._tokenRow.add_css_class('warning');
        else
            this._tokenRow.remove_css_class('warning');
    }

    async _reconnect() {
        const token = this._tokenRow?.get_text().trim() || await this._config.getToken();
        this._token = token;
        this._client.setCredentials({url: this._config.url, token});
        this._issues.invalidate();
        await this._checkConnection({openProjectsIfEmpty: true});
    }

    // ---- tracked projects --------------------------------------------------

    _updateProjectsSubtitle(row) {
        if (!row)
            return;
        const projects = this._config.trackedProjects;
        row.set_subtitle(projects.length > 0
            ? projects.map(project => project.path_with_namespace).join(', ')
            : _('None — choose the projects to track'));
    }

    _openProjectsPage() {
        if (this._projectsPage) {
            this._window.push_subpage(this._projectsPage);
            return;
        }
        const config = this._config;
        const content = new Adw.ToolbarView();
        content.add_top_bar(new Adw.HeaderBar());
        const page = new Adw.NavigationPage({title: _('Tracked projects'), child: content});
        this._projectsPage = page;
        page.connect('hidden', () => {
            this._updateProjectsSubtitle(this._projectsRow);
            this._updateProjectsSubtitle(this._projectsStepRow);
        });

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12,
            margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12});
        content.set_content(box);

        const search = new Gtk.SearchEntry({placeholder_text: _('Search projects…')});
        box.append(search);

        const status = new Gtk.Label({label: _('Loading projects…'), xalign: 0});
        status.add_css_class('dim-label');
        box.append(status);

        const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE});
        list.add_css_class('boxed-list');
        const scroll = new Gtk.ScrolledWindow({child: list, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER});
        box.append(scroll);

        const rows = new Map();
        const tracked = () => new Map(config.trackedProjects.map(project => [project.id, project]));
        const render = projects => {
            let child = list.get_first_child();
            while (child) {
                const next = child.get_next_sibling();
                list.remove(child);
                child = next;
            }
            rows.clear();
            const selected = tracked();
            // Tracked projects first so the current choice is visible without scrolling.
            const ordered = [...projects].sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)));
            for (const project of ordered) {
                const row = new Adw.SwitchRow({
                    title: project.name ?? project.path_with_namespace,
                    subtitle: project.path_with_namespace,
                    active: selected.has(project.id),
                });
                row.connect('notify::active', () => {
                    const current = tracked();
                    if (row.active)
                        current.set(project.id, project);
                    else
                        current.delete(project.id);
                    config.trackedProjects = projects.filter(candidate => current.has(candidate.id));
                    this._updateProjectsSubtitle(this._projectsRow);
                    this._updateProjectsSubtitle(this._projectsStepRow);
                });
                rows.set(row, project);
                list.append(row);
            }
            status.visible = projects.length === 0;
            if (projects.length === 0)
                status.set_label(_('No projects found'));
        };
        list.set_filter_func(row => {
            const query = search.get_text().trim().toLowerCase();
            const project = rows.get(row);
            return !query || `${project.name} ${project.path_with_namespace}`.toLowerCase().includes(query);
        });
        search.connect('search-changed', () => list.invalidate_filter());

        const cached = config.projectsCache;
        if (cached.length > 0)
            render(cached);
        this._issues.listMemberProjects({refresh: true}).then(projects => {
            if (this._projectsPage !== page)
                return;
            render(projects);
        }).catch(error => {
            if (cached.length === 0)
                status.set_label(this._describe(error));
        });

        this._window.push_subpage(page);
        search.grab_focus();
    }

    // ---- shortcuts ---------------------------------------------------------

    _openShortcutsPage() {
        const config = this._config;
        const content = new Adw.ToolbarView();
        content.add_top_bar(new Adw.HeaderBar());
        const page = new Adw.NavigationPage({title: _('Keyboard shortcuts'), child: content});
        const prefsPage = new Adw.PreferencesPage();
        content.set_content(prefsPage);
        const group = new Adw.PreferencesGroup({description: _('Activate a row to record a new shortcut.')});
        prefsPage.add(group);

        const rows = new Map(); // key → {row, suffix}
        const refreshRow = key => {
            const accelerator = config.getShortcut(key);
            const {row, suffix} = rows.get(key);
            suffix.set_visible_child_name(accelerator ? 'accel' : 'disabled');
            if (accelerator)
                suffix.get_child_by_name('accel').set_accelerator(accelerator);
            row.update_property([Gtk.AccessibleProperty.DESCRIPTION], [accelerator || _('Disabled')]);
        };
        for (const [key, title, subtitle] of SHORTCUTS) {
            const row = new Adw.ActionRow({title: title(), subtitle: subtitle(), activatable: true});
            const suffix = new Gtk.Stack({valign: Gtk.Align.CENTER});
            suffix.add_named(new Gtk.ShortcutLabel({accelerator: 'a', disabled_text: _('Disabled')}), 'accel');
            const disabled = new Gtk.Label({label: _('Disabled')});
            disabled.add_css_class('dim-label');
            suffix.add_named(disabled, 'disabled');
            row.add_suffix(suffix);
            row.add_suffix(chevron());
            rows.set(key, {row, suffix});
            refreshRow(key);
            row.connect('activated', () => this._captureShortcut(key, title(), accelerator => {
                config.setShortcut(key, accelerator);
                refreshRow(key);
            }));
            group.add(row);
        }

        const resetGroup = new Adw.PreferencesGroup();
        const reset = new Gtk.Button({label: _('Reset all'), halign: Gtk.Align.CENTER, margin_top: 12});
        reset.add_css_class('pill');
        reset.connect('clicked', () => {
            for (const [key] of SHORTCUTS) {
                this._settings.reset(key);
                refreshRow(key);
            }
        });
        resetGroup.add(reset);
        prefsPage.add(resetGroup);
        this._window.push_subpage(page);
    }

    /** Modal capture dialog: Esc cancels, Backspace disables, any other valid chord is saved. */
    _captureShortcut(key, name, onCaptured) {
        const dialog = new Adw.Dialog({title: _('Set shortcut'), content_width: 380});
        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        dialog.set_child(toolbar);
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12,
            margin_top: 12, margin_bottom: 24, margin_start: 24, margin_end: 24});
        toolbar.set_content(box);
        box.append(new Gtk.Image({icon_name: 'input-keyboard-symbolic', pixel_size: 64}));
        const prompt = new Gtk.Label({label: fmt(_('Press the new shortcut for %s'), name), wrap: true, justify: Gtk.Justification.CENTER});
        prompt.add_css_class('title-3');
        box.append(prompt);
        const hint = new Gtk.Label({label: _('Esc to cancel · Backspace to disable'), justify: Gtk.Justification.CENTER});
        hint.add_css_class('dim-label');
        box.append(hint);
        const error = new Gtk.Label({wrap: true, justify: Gtk.Justification.CENTER, visible: false});
        error.add_css_class('error');
        box.append(error);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            if (keyval === Gdk.KEY_Escape) {
                dialog.close();
                return true;
            }
            const mask = state & Gtk.accelerator_get_default_mod_mask();
            if (keyval === Gdk.KEY_BackSpace && mask === 0) {
                onCaptured('');
                dialog.close();
                return true;
            }
            if (!Gtk.accelerator_valid(keyval, mask)) {
                // Lone modifiers arrive first; wait for the full chord.
                return true;
            }
            const accelerator = Gtk.accelerator_name(keyval, mask);
            const conflict = SHORTCUTS.find(([other]) => other !== key && this._config.getShortcut(other) === accelerator);
            if (conflict) {
                error.set_label(fmt(_('%s is already used for “%s”'), Gtk.accelerator_get_label(keyval, mask), conflict[1]()));
                error.visible = true;
                prompt.update_property([Gtk.AccessibleProperty.DESCRIPTION], [error.get_label()]);
                return true;
            }
            onCaptured(accelerator);
            dialog.close();
            return true;
        });
        dialog.add_controller(controller);
        dialog.present(this._window);
    }
}
