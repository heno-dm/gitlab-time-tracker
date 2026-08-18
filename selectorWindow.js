#!/usr/bin/env gjs

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Soup from 'gi://Soup?version=3.0';

import {getDefaultProject, getProjectsCache, getRecentIssues, serializeIssue, serializeProject, setProjectsCache} from './state.js';

const SCHEMA_ID = 'org.gnome.shell.extensions.timelogs-extension';
const _ = (text) => text;

function getSettings() {
    const [scriptPath] = GLib.filename_from_uri(import.meta.url);
    const scriptDir = GLib.path_get_dirname(scriptPath);
    const schemaDir = GLib.build_filenamev([scriptDir, 'schemas']);
    const source = Gio.SettingsSchemaSource.new_from_directory(
        schemaDir,
        Gio.SettingsSchemaSource.get_default(),
        false
    );
    const schema = source.lookup(SCHEMA_ID, true);

    if (!schema)
        throw new Error(`Unable to load GSettings schema: ${SCHEMA_ID}`);

    return new Gio.Settings({ settings_schema: schema });
}

const SelectorWindow = GObject.registerClass(
class SelectorWindow extends Gtk.ApplicationWindow {
    _init(application) {
        super._init({
            application,
            title: _('GitLab Issue Selector'),
            default_width: 900,
            default_height: 720,
        });

        this._settings = getSettings();
        this._httpSession = new Soup.Session();
        this._defaultProject = getDefaultProject(this._settings);
        this._projects = [];
        this._issues = [];
        this._selectedProject = null;
        this._selectedIssue = null;
        this._issuePage = 1;
        this._issuePerPage = 100;
        this._issueHasMore = false;
        this._issueLoading = false;
        this._issueReloadId = null;
        this._currentUser = null;

        this._buildUi();
        this._loadCurrentUser();
        this._loadProjects();
    }

    _buildUi() {
        const root = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        this.set_child(root);

        const header = new Gtk.HeaderBar({
            title_widget: new Gtk.Label({ label: _('Select a project and an issue') }),
            show_title_buttons: true,
        });
        this.set_titlebar(header);

        const panes = new Gtk.Paned({
            orientation: Gtk.Orientation.HORIZONTAL,
            wide_handle: true,
            hexpand: true,
            vexpand: true,
        });
        root.append(panes);

        const projectPane = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
        panes.set_start_child(projectPane);
        panes.set_resize_start_child(true);
        panes.set_shrink_start_child(false);

        projectPane.append(new Gtk.Label({
            label: _('Project'),
            xalign: 0,
        }));

        this._projectSearchEntry = new Gtk.SearchEntry({ placeholder_text: _('Search project...') });
        this._projectSearchEntry.connect('search-changed', () => this._updateProjectList());
        projectPane.append(this._projectSearchEntry);

        this._projectStatusLabel = new Gtk.Label({ label: _('Loading projects...'), xalign: 0 });
        projectPane.append(this._projectStatusLabel);

        this._projectList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            vexpand: true,
        });
        this._projectList.connect('row-selected', (_list, row) => {
            if (row?._project)
                this._selectProject(row._project);
        });

        const projectScroll = new Gtk.ScrolledWindow({
            child: this._projectList,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        projectPane.append(projectScroll);

        const issuePane = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
        panes.set_end_child(issuePane);
        panes.set_resize_end_child(true);
        panes.set_shrink_end_child(false);

        issuePane.append(new Gtk.Label({
            label: _('Issue'),
            xalign: 0,
        }));

        this._recentBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
        issuePane.append(this._recentBox);
        this._updateRecentIssues();

        this._issueSearchEntry = new Gtk.SearchEntry({ placeholder_text: _('Search issues on GitLab...') });
        this._issueSearchEntry.set_text(this._settings.get_string('issue-filter-search'));
        this._issueSearchEntry.connect('search-changed', () => {
            this._settings.set_string('issue-filter-search', this._issueSearchEntry.get_text());
            this._scheduleIssueReload();
        });
        issuePane.append(this._issueSearchEntry);

        const filters = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
        issuePane.append(filters);

        this._issueStateValues = ['opened', 'closed', 'all'];
        this._issueStateDropdown = Gtk.DropDown.new_from_strings(this._issueStateValues.map(state => this._stateLabel(state)));
        this._issueStateDropdown.set_selected(this._issueStateValues.indexOf(this._getIssueState()));
        this._issueStateDropdown.connect('notify::selected', widget => {
            const selected = widget.get_selected();
            const state = this._issueStateValues[selected] || 'opened';
            this._settings.set_string('issue-filter-state', state);
            this._reloadIssues();
        });
        filters.append(this._issueStateDropdown);

        this._issueAssigneeEntry = new Gtk.Entry({
            placeholder_text: _('Assignee: username, me, or None'),
            hexpand: true,
        });
        this._issueAssigneeEntry.set_text(this._settings.get_string('issue-filter-assignee'));
        this._issueAssigneeEntry.connect('changed', () => {
            this._settings.set_string('issue-filter-assignee', this._issueAssigneeEntry.get_text().trim());
            this._scheduleIssueReload();
        });
        filters.append(this._issueAssigneeEntry);

        this._issueLabelsEntry = new Gtk.Entry({
            placeholder_text: _('Labels, comma-separated'),
            hexpand: true,
        });
        this._issueLabelsEntry.set_text(this._settings.get_string('issue-filter-labels'));
        this._issueLabelsEntry.connect('changed', () => {
            this._settings.set_string('issue-filter-labels', this._issueLabelsEntry.get_text().trim());
            this._scheduleIssueReload();
        });
        filters.append(this._issueLabelsEntry);

        this._issueStatusLabel = new Gtk.Label({ label: _('Select a project first'), xalign: 0 });
        issuePane.append(this._issueStatusLabel);

        this._issueList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            vexpand: true,
        });
        this._issueList.connect('row-selected', (_list, row) => {
            this._selectedIssue = row?._issue || null;
            this._selectButton.sensitive = Boolean(this._selectedProject && this._selectedIssue);
        });

        const issueScroll = new Gtk.ScrolledWindow({
            child: this._issueList,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        issuePane.append(issueScroll);

        this._loadMoreButton = new Gtk.Button({ label: _('Load more issues') });
        this._loadMoreButton.connect('clicked', () => this._loadMoreIssues());
        this._loadMoreButton.sensitive = false;
        issuePane.append(this._loadMoreButton);

        const actions = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.END,
        });
        root.append(actions);

        const cancelButton = new Gtk.Button({ label: _('Cancel') });
        cancelButton.connect('clicked', () => this.close());
        actions.append(cancelButton);

        this._selectButton = new Gtk.Button({
            label: _('Select'),
            sensitive: false,
            receives_default: true,
        });
        this._selectButton.connect('clicked', () => this._sendSelection());
        actions.append(this._selectButton);
        this.set_default_widget(this._selectButton);
    }

    _apiGet(path, onSuccess, onError = null) {
        const url = this._settings.get_string('gitlab-url');
        const token = this._settings.get_string('gitlab-token');

        if (!url || !token) {
            if (onError)
                onError(_('Please configure the server URL and token in preferences'));
            return;
        }

        const message = Soup.Message.new('GET', `${url}/api/v4${path}`);
        if (!message) {
            onError?.(_('Invalid GitLab server URL'));
            return;
        }
        message.request_headers.append('PRIVATE-TOKEN', token);

        this._httpSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                const response = new TextDecoder('utf-8').decode(bytes.get_data());

                if (message.status_code === 200) {
                    onSuccess(JSON.parse(response));
                } else if (onError) {
                    onError(`${_('Error')}: ${message.status_code}`);
                }
            } catch (e) {
                if (onError)
                    onError(`${_('Error')}: ${e.message}`);
            }
        });
    }

    _loadCurrentUser() {
        this._apiGet('/user', data => {
            this._currentUser = data;
        });
    }

    _loadProjects() {
        const cachedProjects = getProjectsCache(this._settings);
        if (cachedProjects.length > 0) {
            this._projects = cachedProjects;
            this._updateProjectList();
            this._selectDefaultProject();
        } else {
            this._projectStatusLabel.label = _('Loading projects...');
        }

        this._apiGet('/projects?membership=true&per_page=100&order_by=last_activity_at', data => {
            this._projects = data;
            setProjectsCache(this._settings, data);
            this._projectStatusLabel.label = '';
            this._updateProjectList();
            if (!this._selectedProject)
                this._selectDefaultProject();
        }, error => {
            if (cachedProjects.length === 0)
                this._projectStatusLabel.label = error;
        });
    }

    _updateProjectList() {
        this._clearListBox(this._projectList);

        const searchWords = this._projectSearchEntry.get_text().toLowerCase().split(/\s+/).filter(Boolean);
        const projects = this._projects
            .filter(project => {
                const haystack = `${project.name} ${project.path_with_namespace}`.toLowerCase();
                return searchWords.every(word => haystack.includes(word));
            })
            .sort((a, b) => a.path_with_namespace.localeCompare(b.path_with_namespace));

        for (const project of projects) {
            const row = new Gtk.ListBoxRow();
            row._project = project;
            row.set_child(new Gtk.Label({
                label: project.path_with_namespace,
                xalign: 0,
                margin_top: 6,
                margin_bottom: 6,
                margin_start: 8,
                margin_end: 8,
            }));
            this._projectList.append(row);
        }
    }

    _selectProject(project) {
        this._selectedProject = project;
        this._selectedIssue = null;
        this._selectButton.sensitive = false;
        this._loadIssues(project.id);
    }

    _selectDefaultProject() {
        if (!this._defaultProject)
            return;

        let child = this._projectList.get_first_child();
        while (child) {
            if (child._project?.id === this._defaultProject.id) {
                this._projectList.select_row(child);
                this._selectProject(child._project);
                return;
            }

            child = child.get_next_sibling();
        }
    }

    _loadIssues(projectId) {
        this._issuePage = 1;
        this._issueHasMore = false;
        this._issues = [];
        this._updateIssueList();
        this._loadIssuesPage(projectId, 1, false);
    }

    _reloadIssues() {
        if (!this._selectedProject)
            return;

        this._loadIssues(this._selectedProject.id);
    }

    _scheduleIssueReload() {
        if (this._issueReloadId)
            GLib.source_remove(this._issueReloadId);

        this._issueReloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._issueReloadId = null;
            this._reloadIssues();
            return GLib.SOURCE_REMOVE;
        });
    }

    _loadMoreIssues() {
        if (!this._selectedProject || this._issueLoading || !this._issueHasMore)
            return;

        this._loadIssuesPage(this._selectedProject.id, this._issuePage + 1, true);
    }

    _loadIssuesPage(projectId, page, append) {
        this._issueLoading = true;
        this._issueStatusLabel.label = _('Loading issues...');
        this._loadMoreButton.sensitive = false;

        this._apiGet(`/projects/${projectId}/issues?${this._buildIssueQuery(page)}`, data => {
            this._issueLoading = false;
            this._issuePage = page;
            this._issueHasMore = data.length === this._issuePerPage;
            this._issues = append ? this._issues.concat(data) : data;
            this._updateIssueList();
        }, error => {
            this._issueLoading = false;
            this._issueStatusLabel.label = error;
            this._updateIssueList();
        });
    }

    _buildIssueQuery(page) {
        const params = [
            ['state', this._getIssueState()],
            ['per_page', String(this._issuePerPage)],
            ['page', String(page)],
        ];

        const search = this._settings.get_string('issue-filter-search').trim();
        if (search) {
            params.push(['search', search]);
            params.push(['in', 'title,description']);
        }

        const assignee = this._settings.get_string('issue-filter-assignee').trim();
        if (assignee) {
            const normalized = assignee.toLowerCase();
            if (normalized === 'none' || normalized === 'unassigned') {
                params.push(['assignee_id', 'None']);
            } else if (normalized === 'me') {
                if (this._currentUser?.username)
                    params.push(['assignee_username', this._currentUser.username]);
            } else {
                params.push(['assignee_username', assignee.replace(/^@/, '')]);
            }
        }

        const labels = this._settings.get_string('issue-filter-labels').trim();
        if (labels)
            params.push(['labels', labels]);

        return params
            .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
            .join('&');
    }

    _getIssueState() {
        const state = this._settings.get_string('issue-filter-state');
        return ['opened', 'closed', 'all'].includes(state) ? state : 'opened';
    }

    _stateLabel(state) {
        switch (state) {
        case 'closed':
            return _('Closed issues');
        case 'all':
            return _('All issues');
        default:
            return _('Open issues');
        }
    }

    _updateIssueList() {
        this._clearListBox(this._issueList);
        this._selectedIssue = null;
        this._selectButton.sensitive = false;

        for (const issue of this._issues) {
            const row = new Gtk.ListBoxRow();
            row._issue = issue;
            row.set_child(new Gtk.Label({
                label: `#${issue.iid} - ${issue.title}`,
                xalign: 0,
                wrap: true,
                margin_top: 6,
                margin_bottom: 6,
                margin_start: 8,
                margin_end: 8,
            }));
            this._issueList.append(row);
        }

        if (this._issues.length === 0 && !this._issueLoading)
            this._issueStatusLabel.label = this._selectedProject ? _('No issues found') : _('Select a project first');
        else if (!this._issueLoading)
            this._issueStatusLabel.label = '';

        this._loadMoreButton.sensitive = this._issueHasMore && !this._issueLoading;
    }

    _updateRecentIssues() {
        const recentIssues = getRecentIssues(this._settings);
        if (recentIssues.length === 0)
            return;

        this._recentBox.append(new Gtk.Label({
            label: _('Recently worked issues'),
            xalign: 0,
        }));

        const recentList = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
        this._recentBox.append(recentList);

        for (const recent of recentIssues) {
            const row = new Gtk.ListBoxRow({ activatable: true });
            row.set_child(new Gtk.Label({
                label: `#${recent.issue.iid} - ${recent.issue.title}\n${recent.project.path_with_namespace}`,
                xalign: 0,
                wrap: true,
                margin_top: 6,
                margin_bottom: 6,
                margin_start: 8,
                margin_end: 8,
            }));
            row.connect('activate', () => {
                this._selectedProject = recent.project;
                this._selectedIssue = recent.issue;
                this._sendSelection();
            });
            recentList.append(row);
        }
    }

    _sendSelection() {
        if (!this._selectedProject || !this._selectedIssue)
            return;

        this._settings.set_string('selection-state', JSON.stringify({
            nonce: GLib.uuid_string_random(),
            project: serializeProject(this._selectedProject),
            issue: serializeIssue(this._selectedIssue),
        }));
        Gio.Settings.sync();
        this.close();
    }

    _clearListBox(listBox) {
        let child = listBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            listBox.remove(child);
            child = next;
        }
    }

    close() {
        if (this._issueReloadId) {
            GLib.source_remove(this._issueReloadId);
            this._issueReloadId = null;
        }
        this._httpSession.abort();
        super.close();
    }
});

const app = new Gtk.Application({
    application_id: 'com.github.heno_dm.TimelogsExtension.Selector',
    flags: Gio.ApplicationFlags.FLAGS_NONE,
});

app.connect('activate', application => {
    const window = new SelectorWindow(application);
    window.present();
});

app.run([]);
