#!/usr/bin/env gjs

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Soup from 'gi://Soup?version=3.0';
import Gettext from 'gettext';

import {getDefaultProject, getProjectsCache, getWorkSessions, serializeIssue, serializeProject, setProjectsCache} from './state.js';

const SCHEMA_ID = 'org.gnome.shell.extensions.timelogs-extension';
const [scriptPath] = GLib.filename_from_uri(import.meta.url);
Gettext.bindtextdomain('timelogs-extension@heno-dm.github.io', `${GLib.path_get_dirname(scriptPath)}/locale`);
const _ = Gettext.domain('timelogs-extension@heno-dm.github.io').gettext;

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
            title: _('Switch issue'),
            default_width: 760,
            default_height: 620,
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
        this._issueRequestSerial = 0;
        this._issueReloadId = null;
        this._currentUser = null;
        this._currentUserError = null;
        this._closed = false;
        this._quickSearch = true;

        this._buildUi();
        this.connect('close-request', () => {
            this._cleanup();
            return false;
        });
        this._loadCurrentUser();
        if (this._defaultProject)
            this._selectProject(this._defaultProject);
        else
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
            title_widget: new Gtk.Label({ label: _('Find an issue and start working') }),
            show_title_buttons: true,
        });
        this.set_titlebar(header);
        const changeProject = new Gtk.Button({label: _('Change project')});
        changeProject.connect('clicked', () => {
            this._projectPane.visible = !this._projectPane.visible;
            if (this._projectPane.visible)
                this._loadProjects();
        });
        header.pack_start(changeProject);

        const panes = new Gtk.Paned({
            orientation: Gtk.Orientation.HORIZONTAL,
            wide_handle: true,
            hexpand: true,
            vexpand: true,
        });
        root.append(panes);

        const projectPane = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
        this._projectPane = projectPane;
        projectPane.visible = !this._defaultProject;
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

        this._projectTitle = new Gtk.Label({
            label: _('Choose your project once to get started'),
            xalign: 0,
        });
        issuePane.append(this._projectTitle);

        this._issueSearchEntry = new Gtk.SearchEntry({ placeholder_text: _('Search all project issues by text or #number…') });
        this._issueSearchEntry.connect('changed', () => {
            this._settings.set_string('issue-filter-search', this._issueSearchEntry.get_text());
            this._updateWorkSuggestions();
            this._scheduleIssueReload();
        });
        this._issueSearchEntry.connect('activate', () => this._sendSelection());
        issuePane.append(this._issueSearchEntry);
        this._workBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
        issuePane.append(this._workBox);
        this._updateWorkSuggestions();

        const useFilters = new Gtk.CheckButton({label: _('Use saved filters')});
        issuePane.append(useFilters);

        const filters = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
        filters.visible = false;
        useFilters.connect('toggled', button => {
            this._quickSearch = !button.active;
            filters.visible = button.active;
            this._reloadIssues();
        });
        issuePane.append(filters);

        this._issueStateValues = ['opened', 'closed', 'all'];
        this._issueStateDropdown = Gtk.DropDown.new_from_strings(this._issueStateValues.map(state => this._stateLabel(state)));
        const savedState = this._settings.get_string('issue-filter-state');
        this._issueStateDropdown.set_selected(Math.max(0, this._issueStateValues.indexOf(savedState)));
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
        this._issueList.connect('row-activated', () => this._sendSelection());
        const searchKeys = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        searchKeys.connect('key-pressed', (_controller, key) => {
            if (key !== Gdk.KEY_Down && key !== Gdk.KEY_Up)
                return false;
            const selected = this._issueList.get_selected_row();
            const index = Math.max(0, (selected?.get_index() ?? -1) + (key === Gdk.KEY_Down ? 1 : -1));
            const row = this._issueList.get_row_at_index(index);
            if (row)
                this._issueList.select_row(row);
            return true;
        });
        this._issueSearchEntry.add_controller(searchKeys);

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
            label: _('Switch and start'),
            sensitive: false,
            receives_default: true,
        });
        this._selectButton.connect('clicked', () => this._sendSelection());
        actions.append(this._selectButton);
        this.set_default_widget(this._selectButton);
        const openButton = new Gtk.Button({label: _('Open in GitLab')});
        openButton.connect('clicked', () => {
            if (this._selectedIssue?.web_url)
                Gio.AppInfo.launch_default_for_uri(this._selectedIssue.web_url, null);
        });
        actions.prepend(openButton);
        const windowKeys = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        windowKeys.connect('key-pressed', (_controller, key) => {
            if (key !== Gdk.KEY_Escape)
                return false;
            this.close();
            return true;
        });
        this.add_controller(windowKeys);
        this._issueSearchEntry.grab_focus();
    }

    _apiGet(path, onSuccess, onError = null, collectPages = false) {
        const url = this._settings.get_string('gitlab-url');
        const token = this._settings.get_string('gitlab-token');

        if (!url || !token) {
            if (onError)
                onError(_('Please configure the server URL and token in preferences'));
            return;
        }

        const loadPage = (page = null, collected = []) => {
            const pagePath = page ? `${path}${path.includes('?') ? '&' : '?'}page=${page}` : path;
            const message = Soup.Message.new('GET', `${url}/api/v4${pagePath}`);
            if (!message) {
                onError?.(_('Invalid GitLab server URL'));
                return;
            }
            message.request_headers.append('PRIVATE-TOKEN', token);

            this._httpSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (this._closed)
                        return;

                    const response = new TextDecoder('utf-8').decode(bytes.get_data());

                    if (message.status_code === 200) {
                        const data = JSON.parse(response);
                        const allData = collectPages ? collected.concat(data) : data;
                        const nextPage = collectPages ? message.response_headers.get_one('X-Next-Page') : '';
                        if (nextPage)
                            loadPage(nextPage, allData);
                        else
                            onSuccess(allData);
                    } else if (onError) {
                        onError(`${_('Error')}: ${message.status_code}`);
                    }
                } catch (e) {
                    if (!this._closed && onError)
                        onError(`${_('Error')}: ${e.message}`);
                }
            });
        };

        loadPage();
    }

    _loadCurrentUser() {
        this._apiGet('/user', data => {
            this._currentUser = data;
            if (!this._quickSearch && this._settings.get_string('issue-filter-assignee').trim().toLowerCase() === 'me')
                this._reloadIssues();
        }, error => {
            this._currentUserError = error;
            if (!this._quickSearch && this._settings.get_string('issue-filter-assignee').trim().toLowerCase() === 'me')
                this._reloadIssues();
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
        }, true);
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
        this._projectPane.visible = false;
        this._projectTitle.label = project.path_with_namespace;
        this._updateWorkSuggestions();
        this._loadIssues(project.id);
    }

    _selectDefaultProject() {
        if (!this._defaultProject)
            return;

        let child = this._projectList.get_first_child();
        while (child) {
            if (child._project?.id === this._defaultProject.id) {
                this._projectList.select_row(child);
                return;
            }

            child = child.get_next_sibling();
        }
    }

    _loadIssues(projectId) {
        if (this._issueReloadId) {
            GLib.source_remove(this._issueReloadId);
            this._issueReloadId = null;
        }

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

        // Invalidate immediately, not after the debounce: old rows and responses
        // must not remain selectable under the newly displayed filters.
        this._issueRequestSerial++;
        this._issues = [];
        this._issueHasMore = false;
        this._issueLoading = true;
        this._updateIssueList();
        this._issueStatusLabel.label = _('Loading issues...');

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
        const requestSerial = ++this._issueRequestSerial;
        if (!this._quickSearch && this._settings.get_string('issue-filter-assignee').trim().toLowerCase() === 'me' && !this._currentUser) {
            this._issueLoading = false;
            this._loadMoreButton.sensitive = false;
            this._issueStatusLabel.label = this._currentUserError || _('Loading current user...');
            return;
        }

        this._issueLoading = true;
        this._issueStatusLabel.label = _('Loading issues...');
        this._loadMoreButton.sensitive = false;

        this._apiGet(`/projects/${projectId}/issues?${this._buildIssueQuery(page)}`, data => {
            if (requestSerial !== this._issueRequestSerial)
                return;

            this._issueLoading = false;
            this._issuePage = page;
            this._issueHasMore = data.length === this._issuePerPage;
            this._issues = append ? this._issues.concat(data) : data;
            this._updateIssueList();
        }, error => {
            if (requestSerial !== this._issueRequestSerial)
                return;

            this._issueLoading = false;
            this._updateIssueList();
            this._issueStatusLabel.label = error;
        });
    }

    _buildIssueQuery(page) {
        const params = [
            ['state', this._getIssueState()],
            // Match the manual top-to-bottom ranking used by GitLab boards.
            ['order_by', 'relative_position'],
            ['sort', 'asc'],
            ['per_page', String(this._issuePerPage)],
            ['page', String(page)],
        ];

        const search = this._issueSearchEntry ? this._issueSearchEntry.get_text().trim()
            : this._settings.get_string('issue-filter-search').trim();
        if (search) {
            if (/^#?\d+$/.test(search)) {
                params.push(['iids[]', search.replace(/^#/, '')]);
            } else {
                params.push(['search', search]);
                params.push(['in', 'title,description']);
            }
        }

        const assignee = this._quickSearch ? '' : this._settings.get_string('issue-filter-assignee').trim();
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

        const labels = this._quickSearch ? '' : this._settings.get_string('issue-filter-labels').trim();
        if (labels)
            params.push(['labels', labels]);

        return params
            .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
            .join('&');
    }

    _getIssueState() {
        if (this._quickSearch)
            return 'all';
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
        const previousIid = this._selectedIssue?.iid;
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
            if (issue.iid === previousIid)
                this._issueList.select_row(row);
        }
        if (!this._selectedIssue && this._issues.length > 0)
            this._issueList.select_row(this._issueList.get_row_at_index(0));

        if (this._issues.length === 0 && !this._issueLoading)
            this._issueStatusLabel.label = this._selectedProject ? _('No issues found') : _('Select a project first');
        else if (!this._issueLoading)
            this._issueStatusLabel.label = '';

        this._loadMoreButton.sensitive = this._issueHasMore && !this._issueLoading;
    }

    _updateWorkSuggestions() {
        this._clearListBox(this._workBox);
        const query = this._issueSearchEntry.get_text().trim().toLowerCase().replace(/^#/, '');
        const sessions = getWorkSessions(this._settings).filter(session =>
            (!this._selectedProject || session.project.id === this._selectedProject.id) &&
            (!query || `${session.issue.iid} ${session.issue.title}`.toLowerCase().includes(query)));
        this._workBox.visible = sessions.length > 0;
        if (sessions.length === 0)
            return;
        this._workBox.append(new Gtk.Label({label: _('Work in progress — click to resume'), xalign: 0}));
        const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE});
        for (const session of sessions) {
            const minutes = Math.floor(session.elapsedSeconds / 60);
            const row = new Gtk.ListBoxRow({activatable: true, child: new Gtk.Label({
                label: `#${session.issue.iid} — ${session.issue.title} (${minutes}m)`,
                xalign: 0, margin_top: 4, margin_bottom: 4,
            })});
            row.connect('activate', () => {
                this._selectedProject = session.project;
                this._selectedIssue = session.issue;
                this._sendSelection();
            });
            list.append(row);
        }
        this._workBox.append(new Gtk.ScrolledWindow({child: list, max_content_height: 150, propagate_natural_height: true}));
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

    _cleanup() {
        if (this._closed)
            return;

        this._closed = true;
        if (this._issueReloadId) {
            GLib.source_remove(this._issueReloadId);
            this._issueReloadId = null;
        }
        this._httpSession.abort();
    }

    close() {
        this._cleanup();
        super.close();
    }
});

const app = new Gtk.Application({
    application_id: 'com.github.heno_dm.TimelogsExtension.Selector',
    flags: Gio.ApplicationFlags.FLAGS_NONE,
});

app.connect('activate', application => {
    if (application.active_window) {
        application.active_window.present();
        application.active_window._issueSearchEntry.grab_focus();
        return;
    }
    const window = new SelectorWindow(application);
    window.present();
});

app.run([]);
