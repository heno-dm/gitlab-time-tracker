#!/usr/bin/env gjs

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Soup from 'gi://Soup?version=3.0';

import {getDefaultProject} from './state.js';

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
        this._authors = [];
        this._authorValues = [''];
        this._currentYear = new Date().getFullYear();
        this._currentMonth = new Date().getMonth();
        this._filterReloadId = null;

        this._buildUi();
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
        nextButton.connect('clicked', () => this._changeMonth(1));
        controls.append(nextButton);

        const filters = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
        root.append(filters);

        filters.append(new Gtk.Label({ label: _('User') }));
        this._authorDropdown = Gtk.DropDown.new_from_strings([_('All users')]);
        this._authorDropdown.connect('notify::selected', () => this._processReportData());
        filters.append(this._authorDropdown);

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

    _apiGet(path, onSuccess, onError = null) {
        const url = this._settings.get_string('gitlab-url');
        const token = this._settings.get_string('gitlab-token');

        if (!url || !token) {
            if (onError)
                onError(_('Please configure the server URL and token in preferences'));
            return;
        }

        const message = Soup.Message.new('GET', `${url}/api/v4${path}`);
        message.request_headers.append('PRIVATE-TOKEN', token);

        this._httpSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                const response = new TextDecoder('utf-8').decode(bytes.get_data());

                if (message.status_code === 200)
                    onSuccess(JSON.parse(response));
                else if (onError)
                    onError(`${_('Error')}: ${message.status_code}`);
            } catch (e) {
                if (onError)
                    onError(`${_('Error')}: ${e.message}`);
            }
        });
    }

    _loadProjects() {
        this._statusLabel.label = _('Loading projects...');
        this._apiGet('/projects?membership=true&per_page=100&order_by=last_activity_at', projects => {
            this._projects = projects.sort((a, b) => a.path_with_namespace.localeCompare(b.path_with_namespace));
            this._projectDropdown.set_model(Gtk.StringList.new(this._projects.map(project => project.path_with_namespace)));

            const defaultProject = getDefaultProject(this._settings);
            const projectId = this._preselectedProjectId || defaultProject?.id;
            const index = projectId ? this._projects.findIndex(project => project.id === projectId) : 0;
            this._projectDropdown.set_selected(index >= 0 ? index : 0);
            if (this._projects.length > 0)
                this._selectProject(this._projects[index >= 0 ? index : 0]);
        }, error => {
            this._statusLabel.label = error;
        });
    }

    _selectProject(project) {
        if (this._selectedProject?.id === project.id)
            return;

        this._selectedProject = project;
        this._loadReportData();
    }

    _changeMonth(delta) {
        this._currentMonth += delta;
        if (this._currentMonth < 0) {
            this._currentMonth = 11;
            this._currentYear--;
        } else if (this._currentMonth > 11) {
            this._currentMonth = 0;
            this._currentYear++;
        }

        this._dateLabel.label = this._formatMonthYear();
        if (this._selectedProject)
            this._loadReportData();
    }

    _formatMonthYear() {
        const monthNames = [
            _('January'), _('February'), _('March'), _('April'), _('May'), _('June'),
            _('July'), _('August'), _('September'), _('October'), _('November'), _('December'),
        ];
        return `${monthNames[this._currentMonth]} ${this._currentYear}`;
    }

    _loadReportData() {
        this._clearBox(this._chartBox);
        this._clearBox(this._detailBox);
        this._statusLabel.label = _('Loading...');
        this._rawEntries = [];

        const month = String(this._currentMonth + 1).padStart(2, '0');
        const lastDay = new Date(this._currentYear, this._currentMonth + 1, 0).getDate();
        const startDateStr = `${this._currentYear}-${month}-01`;
        const endDateStr = `${this._currentYear}-${month}-${String(lastDay).padStart(2, '0')}`;

        this._apiGet(
            `/projects/${this._selectedProject.id}/issues?updated_after=${startDateStr}&updated_before=${endDateStr}T23:59:59Z&per_page=100`,
            issues => {
                const issuesWithTime = issues.filter(issue => issue.time_stats?.total_time_spent > 0);
                if (issuesWithTime.length === 0) {
                    this._updateAuthors([]);
                    this._processReportData();
                    return;
                }

                let pending = issuesWithTime.length;
                for (const issue of issuesWithTime) {
                    this._apiGet(`/projects/${this._selectedProject.id}/issues/${issue.iid}/timelogs?per_page=100`, timelogs => {
                        for (const timelog of timelogs) {
                            const spentAt = timelog.spent_at || timelog.created_at;
                            if (!spentAt)
                                continue;

                            const date = new Date(spentAt);
                            if (date.getFullYear() !== this._currentYear || date.getMonth() !== this._currentMonth)
                                continue;

                            this._rawEntries.push({ issue, timelog });
                        }

                        pending--;
                        if (pending === 0) {
                            this._updateAuthors(this._rawEntries);
                            this._processReportData();
                        }
                    }, () => {
                        pending--;
                        if (pending === 0) {
                            this._updateAuthors(this._rawEntries);
                            this._processReportData();
                        }
                    });
                }
            },
            error => {
                this._statusLabel.label = error;
            }
        );
    }

    _updateAuthors(entries) {
        const currentAuthor = this._authorValues[this._authorDropdown.get_selected()] || '';
        const authors = [...new Set(entries.map(entry => entry.timelog.user?.username).filter(Boolean))].sort();
        this._authorValues = [''].concat(authors);
        this._authorDropdown.set_model(Gtk.StringList.new([_('All users')].concat(authors)));
        const selected = this._authorValues.indexOf(currentAuthor);
        this._authorDropdown.set_selected(selected >= 0 ? selected : 0);
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
        const selectedAuthor = this._authorValues[this._authorDropdown.get_selected()] || '';
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
            const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
            row.append(new Gtk.Label({ label, xalign: 0, width_chars: 24 }));
            const progress = new Gtk.ProgressBar({ fraction: maxSeconds > 0 ? seconds / maxSeconds : 0, hexpand: true });
            row.append(progress);
            row.append(new Gtk.Label({ label: `${(seconds / 3600).toFixed(1)}h`, width_chars: 8 }));
            this._chartBox.append(row);
        }

        const categorySeconds = Object.values(this._reportData.timeByLabel).reduce((sum, seconds) => sum + seconds, 0);
        this._statusLabel.label = `${_('Total time')}: ${(this._reportData.totalSeconds / 3600).toFixed(1)}h | ${_('Category total')}: ${(categorySeconds / 3600).toFixed(1)}h`;
    }

    _updateDetails() {
        this._clearBox(this._detailBox);
        this._detailBox.append(new Gtk.Label({ label: _('Time by user and category'), xalign: 0 }));

        for (const [user, categories] of Object.entries(this._reportData.timeByUserAndLabel).sort()) {
            for (const [label, seconds] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
                this._detailBox.append(new Gtk.Label({
                    label: `${user} | ${label} | ${(seconds / 3600).toFixed(2)}h`,
                    xalign: 0,
                }));
            }
        }
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

    close() {
        if (this._filterReloadId) {
            GLib.source_remove(this._filterReloadId);
            this._filterReloadId = null;
        }
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
