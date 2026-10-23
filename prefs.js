// Preferences: GitLab connection (apply + check), tracked projects, Doing labels,
// panel time, lock behaviour and keyboard shortcuts.
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {Config} from './core/config.js';
import {GitLabClient, normalizeUrl} from './core/gitlabClient.js';
import {IssueSource} from './core/issueSource.js';
import {LOCK_POLICIES} from './core/lockPolicy.js';

const SHORTCUTS = [
    ['toggle-timer-shortcut', () => _('Pause or resume timer'), () => _('Opens the menu when nothing is tracked')],
    ['stop-send-shortcut', () => _('Submit time'), () => _('Opens the submit dialog for the active session')],
    ['cancel-timer-shortcut', () => _('Discard timer'), () => _('Undo is offered in a notification')],
    ['select-issue-shortcut', () => _('Search issues'), () => _('Opens the menu with the search focused')],
    ['monthly-report-shortcut', () => _('Monthly report'), () => _('Opens the report window')],
];

export default class TimelogsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const config = new Config(settings);
        config.migrate();
        this._config = config;
        this._client = new GitLabClient({url: config.url, token: settings.get_string('gitlab-token')});
        this._issues = new IssueSource({client: this._client, config});
        this._window = window;
        this._checkGeneration = 0;

        const page = new Adw.PreferencesPage();
        window.add(page);
        page.add(this._buildGitLabGroup());
        page.add(this._buildWorkGroup());
        page.add(this._buildTimerGroup());
        page.add(this._buildShortcutsGroup());

        window.connect('close-request', () => {
            this._client.abort();
            return false;
        });

        config.getToken().then(token => {
            if (this._tokenRow.get_text() === '')
                this._tokenRow.set_text(token);
            this._client.setCredentials({url: config.url, token});
            this._updateTokenWarning();
            this._checkConnection({openProjectsIfEmpty: true});
        });
    }

    // ---- GitLab ------------------------------------------------------------

    _buildGitLabGroup() {
        const config = this._config;
        const group = new Adw.PreferencesGroup({title: _('GitLab')});

        this._urlRow = new Adw.EntryRow({
            title: _('Server URL'),
            text: config.url,
            show_apply_button: true,
            input_purpose: Gtk.InputPurpose.URL,
        });
        this._urlRow.connect('apply', () => this._applyUrl());
        this._urlRow.connect('changed', () => this._updateTokenLink());
        group.add(this._urlRow);

        this._tokenRow = new Adw.PasswordEntryRow({
            title: _('Access token'),
            show_apply_button: true,
        });
        this._tokenRow.connect('apply', () => this._applyToken());
        group.add(this._tokenRow);

        this._connectionRow = new Adw.ActionRow({title: _('Connection'), subtitle: _('Not checked yet')});
        const refresh = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Check connection'),
        });
        refresh.add_css_class('flat');
        refresh.connect('clicked', () => this._checkConnection());
        this._connectionRow.add_suffix(refresh);
        group.add(this._connectionRow);

        this._tokenLinkRow = new Adw.ActionRow({
            title: _('Create access token…'),
            subtitle: _('Opens GitLab with the name and api scope prefilled'),
            activatable: true,
        });
        this._tokenLinkRow.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic', valign: Gtk.Align.CENTER}));
        this._tokenLinkRow.connect('activated', () => this._openTokenPage());
        group.add(this._tokenLinkRow);
        this._updateTokenLink();
        return group;
    }

    _tokenPageUrl() {
        try {
            const url = normalizeUrl(this._urlRow.get_text());
            return `${url}/-/user_settings/personal_access_tokens?name=Timelogs%20Extension&scopes=api`;
        } catch (e) {
            return null;
        }
    }

    _updateTokenLink() {
        this._tokenLinkRow.sensitive = this._tokenPageUrl() !== null;
    }

    _openTokenPage() {
        const url = this._tokenPageUrl();
        if (!url)
            return;
        // GitLab < 16 serves the tokens page under /-/profile instead.
        const legacy = url.replace('/-/user_settings/', '/-/profile/');
        const target = this._serverMajorVersion !== null && this._serverMajorVersion < 16 ? legacy : url;
        Gtk.show_uri(this._window, target, GLib.get_monotonic_time() / 1000);
    }

    async _applyUrl() {
        const config = this._config;
        const previousUrl = config.url;
        let url;
        try {
            url = normalizeUrl(this._urlRow.get_text());
        } catch (e) {
            this._connectionRow.set_subtitle(_('URL must start with https://'));
            this._urlRow.add_css_class('error');
            return;
        }
        this._urlRow.remove_css_class('error');
        this._urlRow.set_text(url);
        if (url !== previousUrl) {
            // Keep the token available under the new server address.
            const token = this._tokenRow.get_text().trim() || await config.getToken(previousUrl);
            config.url = url;
            if (token)
                await config.setToken(token, url);
            config.trackedProjects = [];
            this._updateProjectsSubtitle();
        }
        await this._reconnect();
    }

    async _applyToken() {
        const token = this._tokenRow.get_text().trim();
        await this._config.setToken(token);
        this._updateTokenWarning();
        await this._reconnect();
    }

    _updateTokenWarning() {
        const warning = this._config.tokenStorageWarning;
        this._tokenRow.set_tooltip_text(warning ? _('Stored unencrypted — libsecret not available') : null);
        if (warning)
            this._tokenRow.add_css_class('warning');
        else
            this._tokenRow.remove_css_class('warning');
    }

    async _reconnect() {
        const token = this._tokenRow.get_text().trim() || await this._config.getToken();
        this._client.setCredentials({url: this._config.url, token});
        this._issues.invalidate();
        await this._checkConnection({openProjectsIfEmpty: true});
    }

    async _checkConnection({openProjectsIfEmpty = false} = {}) {
        const generation = ++this._checkGeneration;
        this._serverMajorVersion = null;
        if (!this._client.isConfigured) {
            this._connectionRow.set_subtitle(this._config.url ? _('Enter an access token') : _('Enter the server URL'));
            return;
        }
        this._connectionRow.set_subtitle(_('Checking…'));
        try {
            const user = await this._client.get('/user');
            if (generation !== this._checkGeneration)
                return;
            this._connectionRow.set_subtitle(`${_('Connected as')} ${user.name} (@${user.username})`);
            this._config.cachedUser = {id: user.id, username: user.username, name: user.name};
            this._client.get('/version').then(version => {
                const major = parseInt(String(version?.version ?? '').split('.')[0], 10);
                this._serverMajorVersion = Number.isFinite(major) ? major : null;
            }).catch(() => {});
            if (openProjectsIfEmpty && this._config.trackedProjects.length === 0)
                this._openProjectsPage();
        } catch (error) {
            if (generation !== this._checkGeneration)
                return;
            this._config.cachedUser = null;
            this._connectionRow.set_subtitle(this._describe(error));
        }
    }

    _describe(error) {
        switch (error?.kind) {
        case 'auth':
            return _('Invalid token');
        case 'network':
            return _('Server not reachable');
        case 'config':
            return _('URL must start with https://');
        default:
            return `${_('Error')}: ${error?.message ?? error}`;
        }
    }

    // ---- Work --------------------------------------------------------------

    _buildWorkGroup() {
        const config = this._config;
        const group = new Adw.PreferencesGroup({title: _('Work')});

        this._projectsRow = new Adw.ActionRow({title: _('Tracked projects'), activatable: true});
        this._projectsRow.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic', valign: Gtk.Align.CENTER}));
        this._projectsRow.connect('activated', () => this._openProjectsPage());
        this._updateProjectsSubtitle();
        group.add(this._projectsRow);

        const labelsRow = new Adw.EntryRow({
            title: _('Doing labels'),
            text: config.doingLabels,
            show_apply_button: true,
            tooltip_text: _('Exact GitLab label names, comma-separated. Leave empty to show all your open issues.'),
        });
        labelsRow.connect('apply', () => {
            config.doingLabels = labelsRow.get_text();
        });
        group.add(labelsRow);
        return group;
    }

    _updateProjectsSubtitle() {
        const projects = this._config.trackedProjects;
        this._projectsRow.set_subtitle(projects.length > 0
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
        page.connect('hidden', () => this._updateProjectsSubtitle());

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
                    this._updateProjectsSubtitle();
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

    // ---- Timer -------------------------------------------------------------

    _buildTimerGroup() {
        const config = this._config;
        const group = new Adw.PreferencesGroup({title: _('Timer')});

        const panelRow = new Adw.SwitchRow({title: _('Show time in top bar'), active: config.showPanelTime});
        panelRow.connect('notify::active', () => {
            config.showPanelTime = panelRow.active;
        });
        group.add(panelRow);

        const labels = [_('Pause timer'), _('Keep counting'), _('Pause and resume on unlock')];
        const lockRow = new Adw.ComboRow({
            title: _('When the screen locks'),
            subtitle: _('Also applies to logout, restart and crashes'),
            model: Gtk.StringList.new(labels),
            selected: Math.max(0, LOCK_POLICIES.indexOf(config.lockBehaviour)),
        });
        lockRow.connect('notify::selected', () => {
            config.lockBehaviour = LOCK_POLICIES[lockRow.selected] ?? 'pause';
        });
        group.add(lockRow);
        return group;
    }

    // ---- Shortcuts ---------------------------------------------------------

    _buildShortcutsGroup() {
        const group = new Adw.PreferencesGroup();
        const row = new Adw.ActionRow({title: _('Keyboard shortcuts'), activatable: true});
        row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic', valign: Gtk.Align.CENTER}));
        row.connect('activated', () => this._openShortcutsPage());
        group.add(row);
        return group;
    }

    _openShortcutsPage() {
        const config = this._config;
        const content = new Adw.ToolbarView();
        content.add_top_bar(new Adw.HeaderBar());
        const page = new Adw.NavigationPage({title: _('Keyboard shortcuts'), child: content});
        const prefsPage = new Adw.PreferencesPage();
        content.set_content(prefsPage);
        const group = new Adw.PreferencesGroup({
            description: GLib.markup_escape_text(_('Use accelerator syntax such as <Super><Alt>t. Leave empty to disable a shortcut.'), -1),
        });
        prefsPage.add(group);

        for (const [key, title, subtitle] of SHORTCUTS) {
            const row = new Adw.EntryRow({title: title(), text: config.getShortcut(key), show_apply_button: true});
            row.set_tooltip_text(subtitle());
            row.connect('apply', () => {
                const value = row.get_text().trim();
                if (value === '' || this._isValidShortcut(value)) {
                    row.remove_css_class('error');
                    config.setShortcut(key, value);
                } else {
                    row.add_css_class('error');
                }
            });
            group.add(row);
        }
        this._window.push_subpage(page);
    }

    _isValidShortcut(shortcut) {
        try {
            const parsed = Gtk.accelerator_parse(shortcut);
            const [ok, keyval, modifiers] = parsed.length === 3 ? parsed : [true, ...parsed];
            return ok && keyval !== 0 && Gtk.accelerator_valid(keyval, modifiers);
        } catch (e) {
            return false;
        }
    }
}
