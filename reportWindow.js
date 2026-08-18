#!/usr/bin/env gjs

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Soup from 'gi://Soup?version=3.0';

import {getDefaultProject, getProjectsCache, setProjectsCache} from './state.js';

const SCHEMA_ID = 'org.gnome.shell.extensions.gitlab-time-tracker';
const _ = text => text;

function getSettings() {
    const [scriptPath] = GLib.filename_from_uri(import.meta.url);
    const scriptDir = GLib.path_get_dirname(scriptPath);
    const source = Gio.SettingsSchemaSource.new_from_directory(
        GLib.build_filenamev([scriptDir, 'schemas']),
        Gio.SettingsSchemaSource.get_default(),
        false
    );
    const schema = source.lookup(SCHEMA_ID, true);

    if (!schema)
        throw new Error(`Unable to load GSettings schema: ${SCHEMA_ID}`);

    return new Gio.Settings({ settings_schema: schema });
}

const ReportWindow = GObject.registerClass(
class ReportWindow extends Gtk.ApplicationWindow {
    _init(application, preselectedProjectId) {
        super._init({
            application,
            title: _('GitLab Time Report'),
            default_width: 1000,
            default_height: 760,
        });

        this._settings = getSettings();
        this._httpSession = new Soup.Session();
        this._projects = [];
        this._selectedProject = null;
        this._preselectedProjectId = preselectedProjectId;
        this._rawEntries = [];
        this._users = [];
        this._selectedAuthor = '';
        this._visibleCategories = null;
        this._currentYear = new Date().getFullYear();
        this._currentMonth = new Date().getMonth();
        this._filterReloadId = null;
        this._reportRequestId = 0;
        this._logPath = GLib.build_filenamev([
            GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) || GLib.get_home_dir(),
            'gitlab-time-tracker-report.log',
        ]);
        this._resetLog();

        this._buildUi();
        this._loadUsers();
        this._loadProjects();
    }

    _buildUi() {
        this.set_titlebar(new Gtk.HeaderBar({
            title_widget: new Gtk.Label({ label: _('Monthly Time Report') }),
            show_title_buttons: true,
        }));

        const root = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        this.set_child(root);

        const controls = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
        root.append(controls);

        this._projectDropdown = Gtk.DropDown.new_from_strings([_('Loading projects...')]);
        this._projectDropdown.set_hexpand(true);
        this._projectDropdown.connect('notify::selected', widget => {
            if (this._updatingProjects)
                return;

            const project = this._projects[widget.get_selected()];
            if (project)
                this._selectProject(project);
        });
        controls.append(this._projectDropdown);

        const prevButton = new Gtk.Button({ label: '<' });
        prevButton.connect('clicked', () => this._changeMonth(-1));
        controls.append(prevButton);

        this._dateLabel = new Gtk.Label({ label: this._formatMonthYear() });
        controls.append(this._dateLabel);

        const nextButton = new Gtk.Button({ label: '>' });
        this._nextMonthButton = nextButton;
        nextButton.connect('clicked', () => this._changeMonth(1));
        controls.append(nextButton);
        this._updateMonthNavigation();

        const filters = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
        root.append(filters);

        filters.append(new Gtk.Label({ label: _('User') }));
        this._authorEntry = new Gtk.SearchEntry({
            placeholder_text: _('All users'),
            hexpand: true,
        });
        this._authorEntry.connect('search-changed', () => {
            const text = this._authorEntry.get_text().trim();
            this._selectedAuthor = this._users.some(user => user.username === text) ? text : '';
            this._updateUserSuggestions();
            this._processReportData();
        });
        this._authorEntry.connect('activate', () => {
            const query = this._authorEntry.get_text().trim().toLowerCase();
            const user = this._users.find(item =>
                item.username.toLowerCase() === query || item.name?.toLowerCase() === query);
            if (user)
                this._selectAuthor(user);
        });
        this._authorEntry.connect('notify::has-focus', () => {
            if (this._authorEntry.has_focus)
                this._updateUserSuggestions();
        });
        filters.append(this._authorEntry);

        this._userPopover = new Gtk.Popover({ autohide: true, has_arrow: false });
        this._userPopover.set_parent(this._authorEntry);
        this._userList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            width_request: 320,
            height_request: 240,
        });
        this._userPopover.set_child(new Gtk.ScrolledWindow({ child: this._userList }));

        filters.append(new Gtk.Label({ label: _('Category') }));
        this._categoryEntry = new Gtk.SearchEntry({
            placeholder_text: _('Category labels or regex, comma-separated'),
            hexpand: true,
        });
        this._categoryEntry.set_text(this._settings.get_string('report-tags-filter'));
        this._categoryEntry.connect('search-changed', () => {
            this._settings.set_string('report-tags-filter', this._categoryEntry.get_text().trim());
            this._scheduleFilterRefresh();
        });
        filters.append(this._categoryEntry);

        const exportBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
        root.append(exportBox);

        const exportMarkdownButton = new Gtk.Button({ label: _('Export Markdown') });
        exportMarkdownButton.connect('clicked', () => this._exportMarkdown());
        exportBox.append(exportMarkdownButton);

        const exportCsvButton = new Gtk.Button({ label: _('Export CSV') });
        exportCsvButton.connect('clicked', () => this._exportCSV());
        exportBox.append(exportCsvButton);

        this._statusLabel = new Gtk.Label({ label: _('Select a project'), xalign: 0 });
        root.append(this._statusLabel);

        const content = new Gtk.Paned({ orientation: Gtk.Orientation.VERTICAL, wide_handle: true, vexpand: true });
        root.append(content);

        this._chartBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_top: 8, margin_bottom: 8 });
        content.set_start_child(new Gtk.ScrolledWindow({ child: this._chartBox, vexpand: true }));

        this._detailBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, margin_top: 8, margin_bottom: 8 });
        content.set_end_child(new Gtk.ScrolledWindow({ child: this._detailBox, vexpand: true }));
    }

    _apiGet(path, onSuccess, onError = null, collectPages = false) {
        const url = this._settings.get_string('gitlab-url');
        const token = this._settings.get_string('gitlab-token');

        if (!url || !token) {
            if (onError)
                onError(_('Please configure the server URL and token in preferences'));
            return;
        }

        const loadPage = (pagePath, collected = []) => {
            this._log(`GET ${pagePath}`);
            const message = Soup.Message.new('GET', `${url}/api/v4${pagePath}`);
            message.request_headers.append('PRIVATE-TOKEN', token);

            this._httpSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const response = new TextDecoder('utf-8').decode(bytes.get_data());

                    if (message.status_code !== 200) {
                        this._log(`HTTP ${message.status_code} ${pagePath}`);
                        if (onError)
                            onError(`${_('Error')}: ${message.status_code}`);
                        return;
                    }

                    const data = JSON.parse(response);
                    this._log(`HTTP 200 ${pagePath} items=${Array.isArray(data) ? data.length : 1}`);
                    const allData = collectPages ? collected.concat(data) : data;
                    const nextPage = collectPages ? message.response_headers.get_one('X-Next-Page') : '';
                    if (nextPage) {
                        const separator = pagePath.includes('?') ? '&' : '?';
                        const pathWithoutPage = pagePath.replace(/([?&])page=\d+(&?)/, (_match, prefix, suffix) => suffix ? prefix : '');
                        loadPage(`${pathWithoutPage}${separator}page=${nextPage}`, allData);
                    } else {
                        onSuccess(allData);
                    }
                } catch (e) {
                    this._log(`ERROR ${pagePath}: ${e.message}`);
                    if (onError)
                        onError(`${_('Error')}: ${e.message}`);
                }
            });
        };

        loadPage(path);
    }

    _graphql(query, variables, onSuccess, onError = null) {
        const url = this._settings.get_string('gitlab-url');
        const token = this._settings.get_string('gitlab-token');
        const message = Soup.Message.new('POST', `${url}/api/graphql`);
        message.request_headers.append('PRIVATE-TOKEN', token);
        message.set_request_body_from_bytes(
            'application/json',
            GLib.Bytes.new(new TextEncoder().encode(JSON.stringify({ query, variables })))
        );
        this._log(`POST /api/graphql operation=ReportTimelogs after=${variables.after || 'null'}`);

        this._httpSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                const response = new TextDecoder('utf-8').decode(bytes.get_data());
                if (message.status_code !== 200) {
                    this._log(`HTTP ${message.status_code} POST /api/graphql`);
                    onError?.(`${_('Error')}: ${message.status_code}`);
                    return;
                }

                const payload = JSON.parse(response);
                if (payload.errors?.length) {
                    const error = payload.errors.map(item => item.message).join('; ');
                    this._log(`GraphQL errors: ${error}`);
                    onError?.(error);
                    return;
                }

                onSuccess(payload.data);
            } catch (e) {
                this._log(`GraphQL error: ${e.message}`);
                onError?.(`${_('Error')}: ${e.message}`);
            }
        });
    }

    _loadUsers() {
        this._apiGet('/users?humans=true&active=true&per_page=100', users => {
            this._log(`Loaded human users: ${users.length}`);
            this._users = users.sort((a, b) =>
                (a.name || a.username).localeCompare(b.name || b.username) || a.username.localeCompare(b.username));
            this._updateUserSuggestions();
        }, error => {
            this._statusLabel.label = `${_('Unable to load users')}: ${error}`;
        }, true);
    }

    _updateUserSuggestions() {
        this._clearBox(this._userList);
        const query = this._authorEntry.get_text().trim().toLowerCase();
        const users = this._users.filter(user =>
            !query || user.name?.toLowerCase().includes(query) || user.username.toLowerCase().includes(query));

        const allUsersRow = new Gtk.ListBoxRow({
            activatable: true,
            child: new Gtk.Label({ label: _('All users'), xalign: 0, margin_top: 6, margin_bottom: 6, margin_start: 8, margin_end: 8 }),
        });
        allUsersRow._user = null;
        this._userList.append(allUsersRow);

        for (const user of users) {
            const row = new Gtk.ListBoxRow({
                activatable: true,
                child: new Gtk.Label({
                    label: `${user.name || user.username} (@${user.username})`,
                    xalign: 0,
                    margin_top: 6,
                    margin_bottom: 6,
                    margin_start: 8,
                    margin_end: 8,
                }),
            });
            row._user = user;
            this._userList.append(row);
        }

        if (!this._userList._rowActivatedId) {
            this._userList._rowActivatedId = this._userList.connect('row-activated', (_list, row) => {
                this._selectAuthor(row._user);
            });
        }

        if (this._authorEntry.has_focus)
            this._userPopover.popup();
    }

    _selectAuthor(user) {
        this._selectedAuthor = user?.username || '';
        this._authorEntry.set_text(this._selectedAuthor);
        this._userPopover.popdown();
        this._processReportData();
    }

    _loadProjects() {
        const cachedProjects = getProjectsCache(this._settings);
        this._log(`Cached projects: ${cachedProjects.length}`);
        if (cachedProjects.length > 0)
            this._setProjects(cachedProjects, true);
        else
            this._statusLabel.label = _('Loading projects...');

        this._apiGet('/projects?membership=true&per_page=100&order_by=last_activity_at', projects => {
            this._log(`Refreshed projects: ${projects.length}`);
            setProjectsCache(this._settings, projects);
            this._setProjects(projects, cachedProjects.length === 0);
        }, error => {
            if (cachedProjects.length === 0)
                this._statusLabel.label = error;
        }, true);
    }

    _setProjects(projects, selectProject) {
        const currentProjectId = this._selectedProject?.id;
        this._projects = [...projects].sort((a, b) => a.path_with_namespace.localeCompare(b.path_with_namespace));
        this._updatingProjects = true;
        this._projectDropdown.set_model(Gtk.StringList.new(this._projects.map(project => project.path_with_namespace)));

        const defaultProject = getDefaultProject(this._settings);
        const projectId = currentProjectId || this._preselectedProjectId || defaultProject?.id;
        const index = projectId ? this._projects.findIndex(project => project.id === projectId) : 0;
        const selectedIndex = index >= 0 ? index : 0;
        this._projectDropdown.set_selected(selectedIndex);
        this._updatingProjects = false;

        const project = this._projects[selectedIndex];
        if (!project)
            return;

        if (currentProjectId === project.id) {
            this._selectedProject = project;
        } else if (selectProject || !this._selectedProject) {
            this._selectProject(project);
        }
    }

    _selectProject(project) {
        if (this._selectedProject?.id === project.id)
            return;

        this._selectedProject = project;
        this._loadReportData();
    }

    _changeMonth(delta) {
        const now = new Date();
        const nextDate = new Date(this._currentYear, this._currentMonth + delta, 1);
        if (nextDate.getFullYear() > now.getFullYear() ||
            (nextDate.getFullYear() === now.getFullYear() && nextDate.getMonth() > now.getMonth()))
            return;

        this._currentMonth += delta;
        if (this._currentMonth < 0) {
            this._currentMonth = 11;
            this._currentYear--;
        } else if (this._currentMonth > 11) {
            this._currentMonth = 0;
            this._currentYear++;
        }

        this._dateLabel.label = this._formatMonthYear();
        this._updateMonthNavigation();
        if (this._selectedProject)
            this._loadReportData();
    }

    _updateMonthNavigation() {
        const now = new Date();
        this._nextMonthButton.sensitive = this._currentYear < now.getFullYear() ||
            (this._currentYear === now.getFullYear() && this._currentMonth < now.getMonth());
    }

    _formatMonthYear() {
        const monthNames = [
            _('January'), _('February'), _('March'), _('April'), _('May'), _('June'),
            _('July'), _('August'), _('September'), _('October'), _('November'), _('December'),
        ];
        return `${monthNames[this._currentMonth]} ${this._currentYear}`;
    }

    _loadReportData() {
        const requestId = ++this._reportRequestId;
        const project = this._selectedProject;
        const reportYear = this._currentYear;
        const reportMonth = this._currentMonth;
        this._clearBox(this._chartBox);
        this._clearBox(this._detailBox);
        this._statusLabel.label = _('Loading...');
        this._rawEntries = [];
        this._resetLog();
        this._log(`Report project=${project.id} path=${project.path_with_namespace}`);
        this._log(`Report period=${reportYear}-${String(reportMonth + 1).padStart(2, '0')}`);

        const startDate = `${reportYear}-${String(reportMonth + 1).padStart(2, '0')}-01`;
        const lastDay = new Date(reportYear, reportMonth + 1, 0).getDate();
        const endDate = `${reportYear}-${String(reportMonth + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        this._loadGraphqlTimelogs(requestId, project, startDate, endDate);
    }

    _loadGraphqlTimelogs(requestId, project, startDate, endDate, after = null) {
        const query = `query ReportTimelogs($projectId: ProjectID!, $startDate: Time, $endDate: Time, $after: String) {
            timelogs(projectId: $projectId, startDate: $startDate, endDate: $endDate, first: 100, after: $after) {
                nodes {
                    id
                    spentAt
                    timeSpent
                    user { username }
                    issue { id iid title webUrl labels { nodes { title } } }
                }
                pageInfo { hasNextPage endCursor }
            }
        }`;
        this._graphql(query, {
            projectId: `gid://gitlab/Project/${project.id}`,
            startDate,
            endDate,
            after,
        }, data => {
            if (requestId !== this._reportRequestId)
                return;

            const connection = data.timelogs;
            for (const node of connection.nodes) {
                if (!node.issue)
                    continue;

                this._rawEntries.push({
                    issue: {
                        id: node.issue.id,
                        iid: node.issue.iid,
                        title: node.issue.title,
                        web_url: node.issue.webUrl,
                        labels: node.issue.labels.nodes.map(label => label.title),
                    },
                    timelog: {
                        id: node.id,
                        spent_at: node.spentAt,
                        time_spent: node.timeSpent,
                        user: node.user,
                    },
                });
            }
            this._log(`GraphQL timelogs page=${connection.nodes.length} accumulated=${this._rawEntries.length}`);

            if (connection.pageInfo.hasNextPage) {
                this._loadGraphqlTimelogs(requestId, project, startDate, endDate, connection.pageInfo.endCursor);
            } else {
                this._processReportData();
            }
        }, error => {
            if (requestId === this._reportRequestId)
                this._statusLabel.label = `${_('Unable to load report')}: ${error}`;
        });
    }

    _scheduleFilterRefresh() {
        if (this._filterReloadId)
            GLib.source_remove(this._filterReloadId);

        this._filterReloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._filterReloadId = null;
            this._processReportData();
            return GLib.SOURCE_REMOVE;
        });
    }

    _processReportData() {
        const selectedAuthor = this._selectedAuthor;
        const tagFilters = this._parseTagFilters(this._categoryEntry.get_text().trim());
        const timeByLabel = {};
        const timeByUserAndLabel = {};
        const issuesByLabel = {};
        let totalSeconds = 0;

        for (const entry of this._rawEntries) {
            const author = entry.timelog.user?.username || _('Unknown user');
            if (selectedAuthor && author !== selectedAuthor)
                continue;

            const seconds = entry.timelog.time_spent || 0;
            if (seconds <= 0)
                continue;

            totalSeconds += seconds;
            const labels = entry.issue.labels || [];
            const matchedLabels = tagFilters.length > 0
                ? labels.filter(label => this._labelMatchesFilters(label, tagFilters))
                : labels;
            const categoryLabels = matchedLabels.length > 0
                ? matchedLabels
                : [tagFilters.length > 0 ? _('Other') : _('No label')];

            for (const label of categoryLabels) {
                timeByLabel[label] = (timeByLabel[label] || 0) + seconds;
                if (!timeByUserAndLabel[author])
                    timeByUserAndLabel[author] = {};
                timeByUserAndLabel[author][label] = (timeByUserAndLabel[author][label] || 0) + seconds;
                if (!issuesByLabel[label])
                    issuesByLabel[label] = new Map();
                issuesByLabel[label].set(entry.issue.iid, entry.issue);
            }
        }

        this._log(`Processed entries=${this._rawEntries.length} selected-user=${selectedAuthor || 'all'} total-seconds=${totalSeconds}`);

        this._reportData = { timeByLabel, timeByUserAndLabel, totalSeconds, issuesByLabel, tagFilters };
        this._updateChart();
        this._updateDetails();
    }

    _updateChart() {
        this._clearBox(this._chartBox);

        if (!this._reportData || Object.keys(this._reportData.timeByLabel).length === 0) {
            this._chartBox.append(new Gtk.Label({ label: _('No time tracked for this period'), xalign: 0 }));
            this._statusLabel.label = `${_('Total time')}: 0h`;
            return;
        }

        const maxSeconds = Math.max(...Object.values(this._reportData.timeByLabel));
        for (const [label, seconds] of Object.entries(this._reportData.timeByLabel).sort((a, b) => b[1] - a[1])) {
            const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, valign: Gtk.Align.CENTER });
            row.append(new Gtk.Label({ label, xalign: 0, width_chars: 24, valign: Gtk.Align.CENTER }));
            const progress = new Gtk.ProgressBar({
                fraction: maxSeconds > 0 ? seconds / maxSeconds : 0,
                hexpand: true,
                height_request: 8,
            });
            const progressBox = new Gtk.CenterBox({
                hexpand: true,
                valign: Gtk.Align.FILL,
                center_widget: progress,
            });
            progressBox.set_orientation(Gtk.Orientation.VERTICAL);
            row.append(progressBox);
            row.append(new Gtk.Label({
                label: `${(seconds / 3600).toFixed(1)}h`,
                width_chars: 8,
                valign: Gtk.Align.CENTER,
            }));
            this._chartBox.append(row);
        }

        const categorySeconds = Object.values(this._reportData.timeByLabel).reduce((sum, seconds) => sum + seconds, 0);
        this._statusLabel.label = `${_('Total time')}: ${(this._reportData.totalSeconds / 3600).toFixed(1)}h | ${_('Category total')}: ${(categorySeconds / 3600).toFixed(1)}h`;
    }

    _updateDetails() {
        this._clearBox(this._detailBox);
        const heading = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
        heading.append(new Gtk.Label({ label: _('Time by user and category'), xalign: 0, hexpand: true }));

        const allCategories = Object.entries(this._reportData.timeByLabel).sort((a, b) => b[1] - a[1]);
        const availableNames = new Set(allCategories.map(([category]) => category));
        if (this._visibleCategories === null)
            this._visibleCategories = new Set(allCategories.slice(0, 10).map(([category]) => category));
        else
            this._visibleCategories = new Set([...this._visibleCategories].filter(category => availableNames.has(category)));

        const columnsButton = new Gtk.MenuButton({ label: _('Columns') });
        const columnsBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 8,
            margin_end: 8,
        });
        const actions = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
        const categoryCheckboxes = new Map();
        let updatingCheckboxes = false;
        const selectAllButton = new Gtk.Button({ label: _('Select all') });
        selectAllButton.connect('clicked', () => {
            this._visibleCategories = new Set(availableNames);
            updatingCheckboxes = true;
            for (const [category, checkbox] of categoryCheckboxes)
                checkbox.active = true;
            updatingCheckboxes = false;
            this._updateDetailsTable(tableBox, allCategories);
        });
        actions.append(selectAllButton);
        const clearButton = new Gtk.Button({ label: _('Clear') });
        clearButton.connect('clicked', () => {
            this._visibleCategories.clear();
            updatingCheckboxes = true;
            for (const checkbox of categoryCheckboxes.values())
                checkbox.active = false;
            updatingCheckboxes = false;
            this._updateDetailsTable(tableBox, allCategories);
        });
        actions.append(clearButton);
        columnsBox.append(actions);
        const checkboxBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
        });
        for (const [category] of allCategories) {
            const checkbox = new Gtk.CheckButton({
                label: category,
                active: this._visibleCategories.has(category),
            });
            checkbox.connect('toggled', button => {
                if (updatingCheckboxes)
                    return;

                if (button.active)
                    this._visibleCategories.add(category);
                else
                    this._visibleCategories.delete(category);
                this._updateDetailsTable(tableBox, allCategories);
            });
            categoryCheckboxes.set(category, checkbox);
            checkboxBox.append(checkbox);
        }
        columnsBox.append(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL }));
        columnsBox.append(new Gtk.ScrolledWindow({
            child: checkboxBox,
            min_content_width: 280,
            min_content_height: 240,
            max_content_height: 360,
            propagate_natural_height: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        }));
        const columnsPopover = new Gtk.Popover({ child: columnsBox });
        columnsPopover.set_autohide(true);
        columnsButton.set_popover(columnsPopover);
        heading.append(columnsButton);
        this._detailBox.append(heading);

        const tableBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this._detailBox.append(tableBox);
        this._updateDetailsTable(tableBox, allCategories);
    }

    _updateDetailsTable(tableBox, allCategories) {
        this._clearBox(tableBox);

        const table = new Gtk.Grid({
            column_spacing: 24,
            row_spacing: 6,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });
        const users = Object.entries(this._reportData.timeByUserAndLabel).sort();
        const categories = allCategories.filter(([category]) => this._visibleCategories.has(category));
        table.attach(new Gtk.Label({ label: _('User'), xalign: 0, hexpand: true }), 0, 0, 1, 1);
        categories.forEach(([category], column) => {
            table.attach(new Gtk.Label({ label: category, xalign: 1 }), column + 1, 0, 1, 1);
        });
        table.attach(new Gtk.Label({ label: _('Total time'), xalign: 1 }), categories.length + 1, 0, 1, 1);

        users.forEach(([user, userCategories], index) => {
            const row = index + 1;
            table.attach(new Gtk.Label({ label: user, xalign: 0, selectable: true }), 0, row, 1, 1);
            categories.forEach(([category], column) => {
                const seconds = userCategories[category] || 0;
                table.attach(new Gtk.Label({
                    label: seconds > 0 ? `${(seconds / 3600).toFixed(2)}h` : '-',
                    xalign: 1,
                }), column + 1, row, 1, 1);
            });
            const userTotal = categories.reduce((sum, [category]) => sum + (userCategories[category] || 0), 0);
            table.attach(new Gtk.Label({ label: `${(userTotal / 3600).toFixed(2)}h`, xalign: 1 }), categories.length + 1, row, 1, 1);
        });

        if (users.length > 0) {
            const totalRow = users.length + 1;
            table.attach(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL }), 0, totalRow, categories.length + 2, 1);
            table.attach(new Gtk.Label({ label: _('Total time'), xalign: 0 }), 0, totalRow + 1, 1, 1);
            categories.forEach(([, seconds], column) => {
                table.attach(new Gtk.Label({ label: `${(seconds / 3600).toFixed(2)}h`, xalign: 1 }), column + 1, totalRow + 1, 1, 1);
            });
            table.attach(new Gtk.Label({
                label: `${(categories.reduce((sum, [, seconds]) => sum + seconds, 0) / 3600).toFixed(2)}h`,
                xalign: 1,
            }), categories.length + 1, totalRow + 1, 1, 1);
        }

        tableBox.append(table);
    }

    _parseTagFilters(filterString) {
        if (!filterString)
            return [];

        return filterString.split(',').map(filter => filter.trim()).filter(Boolean).map(filter => {
            if (filter.startsWith('^') || filter.endsWith('$') || filter.includes('.*') || filter.includes('.+')) {
                try {
                    return { type: 'regex', pattern: new RegExp(filter) };
                } catch (e) {
                    return { type: 'literal', value: filter };
                }
            }
            return { type: 'literal', value: filter };
        });
    }

    _labelMatchesFilters(label, tagFilters) {
        return tagFilters.some(filter => filter.type === 'regex' ? filter.pattern.test(label) : filter.value === label);
    }

    _exportMarkdown() {
        if (!this._reportData || !this._selectedProject)
            return;

        let content = `# ${_('Monthly Time Report')} - ${this._selectedProject.path_with_namespace}\n\n`;
        content += `**${_('Period')}:** ${this._formatMonthYear()}\n`;
        content += `**${_('Total time')}:** ${(this._reportData.totalSeconds / 3600).toFixed(2)}h\n\n`;
        content += `## ${_('Summary by category')}\n\n`;
        for (const [label, seconds] of Object.entries(this._reportData.timeByLabel).sort((a, b) => b[1] - a[1]))
            content += `- **${label}:** ${(seconds / 3600).toFixed(2)}h\n`;

        content += `\n## ${_('Time by user and category')}\n\n`;
        for (const [user, categories] of Object.entries(this._reportData.timeByUserAndLabel).sort()) {
            for (const [label, seconds] of Object.entries(categories).sort((a, b) => b[1] - a[1]))
                content += `- **${user} / ${label}:** ${(seconds / 3600).toFixed(2)}h\n`;
        }

        this._saveExport(content, 'md');
    }

    _exportCSV() {
        if (!this._reportData || !this._selectedProject)
            return;

        const escape = value => String(value).replace(/"/g, '""');
        let content = '"Project","Month","User","Category","Time (hours)"\n';
        for (const [user, categories] of Object.entries(this._reportData.timeByUserAndLabel)) {
            for (const [label, seconds] of Object.entries(categories))
                content += `"${escape(this._selectedProject.path_with_namespace)}","${escape(this._formatMonthYear())}","${escape(user)}","${escape(label)}","${(seconds / 3600).toFixed(2)}"\n`;
        }
        content += `"${escape(this._selectedProject.path_with_namespace)}","${escape(this._formatMonthYear())}","TOTAL","TOTAL","${(this._reportData.totalSeconds / 3600).toFixed(2)}"\n`;

        this._saveExport(content, 'csv');
    }

    _saveExport(content, extension) {
        const downloadsDir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) || GLib.get_home_dir();
        const safePath = this._selectedProject.path_with_namespace.replace(/[\/\\:*?"<>|]/g, '-');
        const filename = `gitlab-report-${safePath}-${this._currentYear}-${String(this._currentMonth + 1).padStart(2, '0')}.${extension}`;
        const filepath = GLib.build_filenamev([downloadsDir, filename]);

        try {
            Gio.File.new_for_path(filepath).replace_contents(
                new TextEncoder().encode(content),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            this._statusLabel.label = `${_('Report exported')}: ${filepath}`;
        } catch (e) {
            this._statusLabel.label = `${_('Unable to export')}: ${e.message}`;
        }
    }

    _clearBox(box) {
        let child = box.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            box.remove(child);
            child = next;
        }
    }

    _resetLog() {
        try {
            Gio.File.new_for_path(this._logPath).replace_contents(
                new TextEncoder().encode(`GitLab Time Tracker report log\nStarted: ${new Date().toISOString()}\n`),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (e) {
            console.error(`Unable to create report log: ${e.message}`);
        }
    }

    _log(message) {
        try {
            const file = Gio.File.new_for_path(this._logPath);
            const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
            stream.write_all(new TextEncoder().encode(`${new Date().toISOString()} ${message}\n`), null);
            stream.close(null);
        } catch (e) {
            console.error(`Unable to write report log: ${e.message}`);
        }
    }

    close() {
        if (this._filterReloadId) {
            GLib.source_remove(this._filterReloadId);
            this._filterReloadId = null;
        }
        this._userPopover.unparent();
        this._httpSession.abort();
        super.close();
    }
});

const app = new Gtk.Application({
    application_id: 'nc.gecka.GitlabTimeTracker.Report',
    flags: Gio.ApplicationFlags.FLAGS_NONE,
});

app.connect('activate', application => {
    const projectIdArg = ARGV[0] ? Number(ARGV[0]) : null;
    const window = new ReportWindow(application, Number.isFinite(projectIdArg) ? projectIdArg : null);
    window.present();
});

app.run([]);
