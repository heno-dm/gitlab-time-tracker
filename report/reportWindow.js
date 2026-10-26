// Monthly report window (libadwaita, §2.10 + §2.17). Data logic lives in
// reportData.js and exporters.js; this file only renders and reacts.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import {formatReportHours} from '../core/format.js';
import {exportFileName, toCsv, toMarkdown} from './exporters.js';
import {aggregate, authorsOf, calendarWeeks, fetchTimelogs, issuesInCategory, parseTagFilters, previousMonth,
    summarize} from './reportData.js';

/** printf-style %s/%d substitution; String.prototype.format only exists inside GNOME Shell. */
function fmt(template, ...args) {
    let index = 0;
    return String(template).replace(/%[sd]/g, () => String(args[index++]));
}

const VIEWS = ['categories', 'calendar'];
const FORMATS = {csv: {ext: 'csv'}, md: {ext: 'md'}};
const USER_ME = 0;
const USER_EVERYONE = 1;

// Layout-only CSS plus the calendar heat map: day cells are tinted with the
// accent colour on a fine ramp (visibly continuous) scaled by the day's share
// of the busiest day in the month; text flips to the accent foreground halfway.
const CALENDAR_LEVELS = 24;
const CALENDAR_MIN_ALPHA = 0.2;
const REPORT_CSS = `
.report-calendar-day { padding: 6px 8px; min-height: 56px; }
.report-calendar-day.dimmed { opacity: 0.55; }
.report-calendar-day.today { border: 2px solid @accent_bg_color; }
.report-calendar-day.selected { outline: 2px solid @accent_color; outline-offset: 2px; }
.report-calendar-day.has-time { border-color: transparent; }
levelbar.timelogs-small block { min-height: 4px; }
levelbar.timelogs-small trough { min-height: 4px; }
levelbar.timelogs-neutral block.filled { background-color: alpha(currentColor, 0.35); }
${Array.from({length: CALENDAR_LEVELS}, (_unused, level) => {
    const alpha = (CALENDAR_MIN_ALPHA + (1 - CALENDAR_MIN_ALPHA) * level / (CALENDAR_LEVELS - 1)).toFixed(3);
    const fg = level >= Math.ceil(CALENDAR_LEVELS * 0.55) ? ' color: @accent_fg_color;' : '';
    return `.report-calendar-day.level-${level} { background-color: alpha(@accent_bg_color, ${alpha});${fg} }`;
}).join('\n')}
`;
let cssInstalled = false;

function installCss() {
    if (cssInstalled)
        return;
    const provider = new Gtk.CssProvider();
    provider.load_from_string(REPORT_CSS);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    cssInstalled = true;
}

function clearBox(box) {
    let child = box.get_first_child();
    while (child) {
        const next = child.get_next_sibling();
        box.remove(child);
        child = next;
    }
}

/** Accessible icon button: tooltip plus an explicit accessible label (§2.19). */
function iconButton(iconName, label, {flat = true, action = null} = {}) {
    const button = new Gtk.Button({icon_name: iconName, valign: Gtk.Align.CENTER, tooltip_text: label});
    button.update_property([Gtk.AccessibleProperty.LABEL], [label]);
    if (flat)
        button.add_css_class('flat');
    if (action)
        button.set_action_name(action);
    return button;
}

/** Level bar without GTK's default low/high/full colour offsets, so every bar uses one colour. */
function plainBar(params) {
    const bar = new Gtk.LevelBar(params);
    for (const offset of [Gtk.LEVEL_BAR_OFFSET_LOW, Gtk.LEVEL_BAR_OFFSET_HIGH, Gtk.LEVEL_BAR_OFFSET_FULL])
        bar.remove_offset_value(offset);
    bar.add_css_class('timelogs-small');
    return bar;
}

function numericLabel(params) {
    const label = new Gtk.Label(params);
    label.add_css_class('numeric');
    return label;
}

export const ReportWindow = GObject.registerClass(
class ReportWindow extends Adw.ApplicationWindow {
    _init({application, config, client, issues, gettext, preselectedProjectId}) {
        super._init({application, title: gettext('Monthly Report'), default_width: 1040, default_height: 780});
        this._ = gettext;
        installCss();
        this._config = config;
        this._client = client;
        this._issues = issues;
        this._preselectedProjectId = preselectedProjectId;
        this._projects = [];
        this._project = null;
        this._entries = [];
        this._previousEntries = null;
        this._reportData = null;
        this._authors = [];
        this._visibleCategories = null;
        this._requestId = 0;
        this._filterTimeoutId = 0;
        this._selectedDay = null;
        this._dayCells = new Map();
        const now = new Date();
        this._year = now.getFullYear();
        this._month = now.getMonth();
        this._started = false;

        this._buildActions();
        this._buildUi();
    }

    /** Called once the token is known. */
    start() {
        if (this._started)
            return;
        this._started = true;
        this._loadProjects();
    }

    // ---- actions and shortcuts --------------------------------------------

    _buildActions() {
        const add = (name, callback, accels = []) => {
            const action = new Gio.SimpleAction({name});
            action.connect('activate', () => callback());
            this.add_action(action);
            if (accels.length)
                this.application.set_accels_for_action(`win.${name}`, accels);
            return action;
        };
        this._prevAction = add('prev-month', () => this._changeMonth(-1), ['<Alt>Left']);
        this._nextAction = add('next-month', () => this._changeMonth(1), ['<Alt>Right']);
        add('export-csv', () => this._export('csv'));
        add('export-md', () => this._export('md'));
        add('export-default', () => this._export(this._config.reportExportFormat), ['<Control>e']);
        add('copy-md', () => this._copy('md'), ['<Control><Shift>c']);
        add('copy-csv', () => this._copy('csv'));
        add('reload', () => this._loadReport(), ['<Control>r', 'F5']);
        add('view-categories', () => this._stack.set_visible_child_name('categories'), ['<Control>1']);
        add('view-calendar', () => this._stack.set_visible_child_name('calendar'), ['<Control>2']);
        add('show-everyone', () => this._userDropdown.set_selected(USER_EVERYONE));
        add('close', () => this.close(), ['<Control>w', 'Escape']);
    }

    // ---- UI ----------------------------------------------------------------

    _buildUi() {
        const _ = this._;
        this._toasts = new Adw.ToastOverlay();
        this.set_content(this._toasts);
        const toolbarView = new Adw.ToolbarView();
        this._toasts.set_child(toolbarView);

        const header = new Adw.HeaderBar();
        toolbarView.add_top_bar(header);
        const nav = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL});
        nav.add_css_class('linked');
        nav.append(iconButton('go-previous-symbolic', _('Previous month'), {flat: false, action: 'win.prev-month'}));
        nav.append(iconButton('go-next-symbolic', _('Next month'), {flat: false, action: 'win.next-month'}));
        header.pack_start(nav);

        this._windowTitle = new Adw.WindowTitle({title: _('Monthly Report'), subtitle: ''});
        header.set_title_widget(this._windowTitle);

        this._stack = new Adw.ViewStack();
        this._viewSwitcher = new Adw.ViewSwitcher({stack: this._stack, policy: Adw.ViewSwitcherPolicy.WIDE});
        header.pack_end(this._buildExportButton());
        header.pack_end(this._viewSwitcher);

        const root = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12,
            margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12});
        toolbarView.set_content(root);
        root.append(this._buildToolbar());
        root.append(this._buildSummary());

        this._pages = new Gtk.Stack({vexpand: true, transition_type: Gtk.StackTransitionType.CROSSFADE});
        root.append(this._pages);

        // Loading: spinner + progress line.
        const loading = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER});
        loading.append(new Gtk.Spinner({spinning: true, width_request: 48, height_request: 48}));
        this._progressLabel = new Gtk.Label({label: _('Loading time entries…')});
        this._progressLabel.add_css_class('dim-label');
        loading.append(this._progressLabel);
        this._pages.add_named(loading, 'loading');

        // Empty: no time after filters.
        this._emptyPage = new Adw.StatusPage({icon_name: 'x-office-calendar-symbolic'});
        const emptyButtons = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 12, halign: Gtk.Align.CENTER});
        this._showEveryoneButton = new Gtk.Button({label: _('Show Everyone'), action_name: 'win.show-everyone'});
        this._showEveryoneButton.add_css_class('pill');
        emptyButtons.append(this._showEveryoneButton);
        this._previousMonthButton = new Gtk.Button({action_name: 'win.prev-month'});
        this._previousMonthButton.add_css_class('pill');
        emptyButtons.append(this._previousMonthButton);
        this._emptyPage.set_child(emptyButtons);
        this._pages.add_named(this._emptyPage, 'empty');

        // Error: plain cause, Retry, small detail line.
        this._errorPage = new Adw.StatusPage({icon_name: 'network-error-symbolic'});
        const errorBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, halign: Gtk.Align.CENTER});
        const retry = new Gtk.Button({label: _('Retry'), action_name: 'win.reload', halign: Gtk.Align.CENTER});
        retry.add_css_class('pill');
        retry.add_css_class('suggested-action');
        errorBox.append(retry);
        this._errorDetail = new Gtk.Label({wrap: true, justify: Gtk.Justification.CENTER, selectable: true});
        this._errorDetail.add_css_class('dim-label');
        this._errorDetail.add_css_class('caption');
        errorBox.append(this._errorDetail);
        this._errorPage.set_child(errorBox);
        this._pages.add_named(this._errorPage, 'error');

        this._pages.add_named(this._stack, 'content');

        this._categoriesBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18});
        this._stack.add_titled(new Gtk.ScrolledWindow({child: this._categoriesBox, hscrollbar_policy: Gtk.PolicyType.NEVER}),
            'categories', _('Categories')).set_icon_name('view-list-symbolic');
        this._calendarBox = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 18});
        this._stack.add_titled(new Gtk.ScrolledWindow({child: this._calendarBox, hscrollbar_policy: Gtk.PolicyType.NEVER}),
            'calendar', _('Calendar')).set_icon_name('x-office-calendar-symbolic');
        this._stack.set_visible_child_name(VIEWS.includes(this._config.reportView) ? this._config.reportView : 'categories');
        this._stack.connect('notify::visible-child-name', () => {
            const name = this._stack.get_visible_child_name();
            if (VIEWS.includes(name))
                this._config.reportView = name;
        });

        this._pages.set_visible_child_name('loading');
        this._updateMonthNavigation();
    }

    _buildExportButton() {
        const _ = this._;
        const menu = new Gio.Menu();
        const files = new Gio.Menu();
        files.append(_('Export as CSV'), 'win.export-csv');
        files.append(_('Export as Markdown'), 'win.export-md');
        menu.append_section(null, files);
        const copy = new Gio.Menu();
        copy.append(_('Copy as Markdown'), 'win.copy-md');
        copy.append(_('Copy as CSV'), 'win.copy-csv');
        menu.append_section(null, copy);
        this._exportButton = new Adw.SplitButton({menu_model: menu, action_name: 'win.export-default', sensitive: false,
            dropdown_tooltip: _('Export or copy')});
        this._updateExportLabel();
        return this._exportButton;
    }

    _updateExportLabel() {
        const _ = this._;
        this._exportButton.set_label(this._config.reportExportFormat === 'md' ? _('Export Markdown') : _('Export CSV'));
    }

    _buildToolbar() {
        const _ = this._;
        const toolbar = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 8});

        this._monthTitle = new Gtk.Label({label: this._monthLabel(), xalign: 0, hexpand: true});
        this._monthTitle.add_css_class('title-1');
        toolbar.append(this._monthTitle);

        this._projectModel = new Gtk.StringList();
        this._projectDropdown = new Gtk.DropDown({
            model: this._projectModel,
            enable_search: true,
            expression: Gtk.PropertyExpression.new(Gtk.StringObject, null, 'string'),
            tooltip_text: _('Project'),
            valign: Gtk.Align.CENTER,
        });
        this._projectDropdown.update_property([Gtk.AccessibleProperty.LABEL], [_('Project')]);
        this._projectDropdown.connect('notify::selected', () => {
            if (this._updatingProjects)
                return;
            const project = this._projects[this._projectDropdown.get_selected()];
            if (project && project.id !== this._project?.id) {
                this._project = project;
                this._loadReport();
            }
        });
        toolbar.append(this._projectDropdown);

        this._userModel = Gtk.StringList.new([_('Me'), _('Everyone')]);
        this._userDropdown = new Gtk.DropDown({model: this._userModel, tooltip_text: _('User'), valign: Gtk.Align.CENTER,
            selected: this._config.reportUser === 'me' ? USER_ME : USER_EVERYONE});
        this._userDropdown.update_property([Gtk.AccessibleProperty.LABEL], [_('User')]);
        this._userDropdown.connect('notify::selected', () => {
            if (this._updatingUsers)
                return;
            const index = this._userDropdown.get_selected();
            this._config.reportUser = index === USER_ME ? 'me' : index === USER_EVERYONE ? '' : this._authors[index - 2]?.username ?? '';
            this._process();
        });
        toolbar.append(this._userDropdown);

        const popover = new Gtk.Popover();
        const popoverBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8});
        popover.set_child(popoverBox);
        const popoverTitle = new Gtk.Label({label: _('Category labels or regular expressions, comma-separated'), xalign: 0});
        popoverBox.append(popoverTitle);
        this._categoryEntry = new Gtk.Entry({
            text: this._config.reportTagsFilter,
            placeholder_text: 'Bug,^Feature.*$',
            width_chars: 40,
        });
        this._categoryEntry.update_property([Gtk.AccessibleProperty.LABEL], [_('Category filters')]);
        this._categoryEntry.connect('changed', () => {
            this._config.reportTagsFilter = this._categoryEntry.get_text().trim();
            this._updateCategoryLabel();
            this._scheduleProcess();
        });
        popoverBox.append(this._categoryEntry);
        const hint = new Gtk.Label({label: _('Issues without a matching label are grouped as “Other”.'), xalign: 0, wrap: true});
        hint.add_css_class('dim-label');
        popoverBox.append(hint);
        // GJS cannot build the widget-list GValue for DESCRIBED_BY, so the hint text is the description.
        this._categoryEntry.update_property([Gtk.AccessibleProperty.DESCRIPTION], [hint.get_label()]);
        this._categoryButton = new Gtk.MenuButton({popover, always_show_arrow: true, tooltip_text: _('Filter categories'),
            valign: Gtk.Align.CENTER});
        this._updateCategoryLabel();
        toolbar.append(this._categoryButton);
        return toolbar;
    }

    _updateCategoryLabel() {
        const _ = this._;
        const filters = this._config.reportTagsFilter.split(',').map(filter => filter.trim()).filter(Boolean);
        this._categoryButton.set_label(filters.length === 0 ? _('Categories: All') : `${_('Categories')}: ${filters.join(', ')}`);
    }

    _buildSummary() {
        const _ = this._;
        const card = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, homogeneous: true});
        card.add_css_class('card');
        this._summaryCells = {};
        const cell = (key, caption) => {
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2,
                margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12});
            const value = numericLabel({label: '—', xalign: 0});
            value.add_css_class('title-2');
            box.append(value);
            const captionLabel = new Gtk.Label({label: caption, xalign: 0});
            captionLabel.add_css_class('dim-label');
            captionLabel.add_css_class('caption');
            box.append(captionLabel);
            value.update_property([Gtk.AccessibleProperty.DESCRIPTION], [caption]);
            this._summaryCells[key] = value;
            card.append(box);
        };
        cell('total', _('Total this month'));
        cell('issues', _('Issues'));
        cell('average', _('Average per working day'));
        cell('change', _('Change vs previous month'));
        return card;
    }

    // ---- data --------------------------------------------------------------

    async _loadProjects() {
        const cached = this._config.projectsCache;
        if (cached.length > 0)
            this._setProjects(cached);
        try {
            const projects = await this._issues.listMemberProjects({refresh: true});
            this._setProjects(projects);
        } catch (error) {
            if (this._projects.length === 0)
                this._showError(error);
        }
    }

    _setProjects(projects) {
        const sorted = [...projects].sort((a, b) => a.path_with_namespace.localeCompare(b.path_with_namespace));
        this._projects = sorted;
        this._updatingProjects = true;
        this._projectModel.splice(0, this._projectModel.get_n_items(), sorted.map(project => project.path_with_namespace));
        const tracked = this._config.trackedProjects[0];
        const preferredId = this._project?.id ?? this._preselectedProjectId ?? tracked?.id ?? null;
        let index = preferredId ? sorted.findIndex(project => project.id === preferredId) : -1;
        if (index < 0)
            index = 0;
        this._projectDropdown.set_selected(index);
        this._updatingProjects = false;
        const project = sorted[index];
        if (project && project.id !== this._project?.id) {
            this._project = project;
            this._loadReport();
        }
    }

    async _loadReport() {
        const _ = this._;
        if (!this._project)
            return;
        const requestId = ++this._requestId;
        const {_project: project, _year: year, _month: month} = this;
        this._reportData = null;
        this._entries = [];
        this._loaded = false;
        this._previousEntries = null;
        this._selectedDay = null;
        this._exportButton.sensitive = false;
        this._windowTitle.set_subtitle(project.path_with_namespace);
        this._progressLabel.set_label(_('Loading time entries…'));
        this._pages.set_visible_child_name('loading');
        this._renderSummary();
        try {
            const entries = await fetchTimelogs(this._client, project.id, year, month, {
                onProgress: ({loaded, total}) => {
                    if (requestId !== this._requestId)
                        return;
                    this._progressLabel.set_label(total !== null
                        ? fmt(_('Loading time entries… %d of about %d'), loaded, total)
                        : fmt(_('Loading time entries… %d loaded'), loaded));
                },
            });
            if (requestId !== this._requestId)
                return;
            this._entries = entries;
            this._loaded = true;
            this._setAuthors(authorsOf(entries));
            this._process();
            this._loadPreviousMonth(requestId);
        } catch (error) {
            if (requestId !== this._requestId)
                return;
            this._showError(error);
        }
    }

    /** The baseline for "Change vs previous month"; loaded after the main data. */
    async _loadPreviousMonth(requestId) {
        const {year, month} = previousMonth(this._year, this._month);
        try {
            const entries = await fetchTimelogs(this._client, this._project.id, year, month);
            if (requestId !== this._requestId)
                return;
            this._previousEntries = entries;
            this._renderSummary();
        } catch (error) {
            if (requestId === this._requestId)
                console.debug(`Timelogs: previous month unavailable: ${error.message}`);
        }
    }

    _showError(error) {
        const _ = this._;
        const messages = {
            auth: _('GitLab rejected the token'),
            network: _('Server not reachable'),
            config: _('GitLab is not configured'),
            graphql: _('GitLab could not run the report query'),
        };
        this._errorPage.set_title(messages[error?.kind] ?? _('Unable to load report'));
        this._errorPage.set_description(error?.kind === 'config'
            ? _('Open the extension settings first.')
            : _('Check the connection and try again.'));
        const detail = [error?.status ? `HTTP ${error.status}` : null, error?.message ?? String(error)].filter(Boolean).join(' · ');
        this._errorDetail.set_label(detail);
        this._pages.set_visible_child_name('error');
    }

    _setAuthors(authors) {
        const _ = this._;
        this._authors = authors;
        this._updatingUsers = true;
        this._userModel.splice(0, this._userModel.get_n_items(),
            [_('Me'), _('Everyone'), ...authors.map(author => `${author.name} (@${author.username})`)]);
        const saved = this._config.reportUser;
        let index = USER_EVERYONE;
        if (saved === 'me')
            index = this._meUsername() ? USER_ME : USER_EVERYONE;
        else if (saved)
            index = Math.max(USER_EVERYONE, authors.findIndex(author => author.username === saved) + 2);
        this._userDropdown.set_selected(index);
        this._updatingUsers = false;
    }

    _meUsername() {
        return this._config.cachedUser?.username ?? null;
    }

    _scheduleProcess() {
        if (this._filterTimeoutId)
            GLib.source_remove(this._filterTimeoutId);
        this._filterTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._filterTimeoutId = 0;
            this._process();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** '' = everyone; a username otherwise. "Me" with no known user falls back to everyone. */
    _selectedAuthor() {
        const index = this._userDropdown.get_selected();
        if (index === USER_ME)
            return this._meUsername() ?? '';
        if (index === USER_EVERYONE)
            return '';
        return this._authors[index - 2]?.username ?? '';
    }

    _selectedUserLabel() {
        const _ = this._;
        const index = this._userDropdown.get_selected();
        if (index === USER_ME)
            return this._meUsername() ? _('Me') : _('Everyone');
        return this._userModel.get_string(index) ?? _('Everyone');
    }

    _aggregateOptions(year, month) {
        const _ = this._;
        return {
            author: this._selectedAuthor(),
            tagFilters: parseTagFilters(this._config.reportTagsFilter),
            year,
            month,
            labels: {other: _('Other'), none: _('No label'), unknown: _('Unknown user')},
        };
    }

    _process() {
        if (!this._loaded)
            return;
        this._reportData = aggregate(this._entries, this._aggregateOptions(this._year, this._month));
        this._renderSummary();
        if (this._reportData.totalSeconds === 0) {
            this._exportButton.sensitive = false;
            this._renderEmpty();
            this._pages.set_visible_child_name('empty');
            return;
        }
        this._exportButton.sensitive = true;
        this._pages.set_visible_child_name('content');
        this._renderCategories();
        this._renderCalendar();
    }

    // ---- rendering ---------------------------------------------------------

    _renderEmpty() {
        const _ = this._;
        this._emptyPage.set_title(fmt(_('No time tracked in %s'), this._monthLabel()));
        const filters = this._config.reportTagsFilter.trim();
        const everyone = this._selectedAuthor() === '';
        const who = everyone ? _('Showing everyone') : fmt(_('Showing %s'), this._selectedUserLabel());
        const what = filters ? fmt(_('categories %s'), filters) : _('all categories');
        this._emptyPage.set_description(`${who} · ${what}`);
        this._showEveryoneButton.visible = !everyone;
        const previous = previousMonth(this._year, this._month);
        this._previousMonthButton.set_label(fmt(_('Go to %s'), 
            GLib.DateTime.new_local(previous.year, previous.month + 1, 1, 0, 0, 0).format('%B %Y')));
    }

    _renderSummary() {
        const _ = this._;
        const cells = this._summaryCells;
        if (!this._reportData) {
            for (const label of Object.values(cells))
                label.set_label('—');
            return;
        }
        const previousTotal = this._previousEntries
            ? aggregate(this._previousEntries, this._aggregateOptions(previousMonth(this._year, this._month).year,
                previousMonth(this._year, this._month).month)).totalSeconds
            : null;
        const summary = summarize(this._reportData, {year: this._year, month: this._month, previousTotalSeconds: previousTotal});
        cells.total.set_label(formatReportHours(summary.totalSeconds));
        cells.issues.set_label(String(summary.issueCount));
        cells.average.set_label(summary.workingDays > 0 ? formatReportHours(summary.averagePerWorkingDay) : '—');
        if (summary.changeRatio === null)
            cells.change.set_label('—');
        else if (summary.changeRatio === Infinity)
            cells.change.set_label(_('new'));
        else
            cells.change.set_label(`${summary.changeRatio >= 0 ? '+' : '−'}${Math.round(Math.abs(summary.changeRatio) * 100)} %`);
        cells.change.set_tooltip_text(summary.previousTotalSeconds === null ? null
            : fmt(_('Previous month: %s'), formatReportHours(summary.previousTotalSeconds)));
    }

    _renderCategories() {
        const _ = this._;
        clearBox(this._categoriesBox);
        const data = this._reportData;
        const categories = Object.entries(data.timeByLabel).sort((a, b) => b[1] - a[1]);
        const maxSeconds = Math.max(...categories.map(([, seconds]) => seconds));

        const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE});
        list.add_css_class('boxed-list');
        for (const [label, seconds] of categories) {
            const row = new Adw.ExpanderRow({title: label, use_markup: false});
            const bar = plainBar({value: maxSeconds > 0 ? seconds / maxSeconds : 0, valign: Gtk.Align.CENTER, width_request: 160});
            if (data.neutralLabels.includes(label))
                bar.add_css_class('timelogs-neutral');
            bar.update_property([Gtk.AccessibleProperty.LABEL], [_('Share of the largest category')]);
            row.add_suffix(bar);
            row.add_suffix(numericLabel({label: formatReportHours(seconds), width_chars: 8, xalign: 1, valign: Gtk.Align.CENTER}));
            for (const {issue, seconds: issueSeconds} of issuesInCategory(data, label)) {
                const child = new Adw.ActionRow({title: `#${issue.iid} ${issue.title}`, use_markup: false, title_lines: 1});
                child.add_suffix(numericLabel({label: formatReportHours(issueSeconds), xalign: 1, valign: Gtk.Align.CENTER}));
                const open = iconButton('web-browser-symbolic', fmt(_('Open #%s in browser'), issue.iid));
                open.sensitive = Boolean(issue.web_url);
                open.connect('clicked', () => this._openUri(issue.web_url));
                child.add_suffix(open);
                row.add_row(child);
            }
            list.append(row);
        }
        this._categoriesBox.append(list);
        if (this._selectedAuthor() === '')
            this._categoriesBox.append(this._buildTable(categories));
    }

    _buildTable(allCategories) {
        const _ = this._;
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        const heading = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 8});
        const title = new Gtk.Label({label: _('Time by user and category'), xalign: 0, hexpand: true});
        title.add_css_class('heading');
        heading.append(title);

        const names = new Set(allCategories.map(([category]) => category));
        if (this._visibleCategories === null)
            this._visibleCategories = new Set(allCategories.slice(0, 10).map(([category]) => category));
        else
            this._visibleCategories = new Set([...this._visibleCategories].filter(category => names.has(category)));

        const tableBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        const checkboxes = new Map();
        let updating = false;
        const refresh = () => this._renderTable(tableBox, allCategories);
        const columnsBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8});
        const actions = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
        const selectAll = new Gtk.Button({label: _('Select all')});
        selectAll.connect('clicked', () => {
            this._visibleCategories = new Set(names);
            updating = true;
            for (const checkbox of checkboxes.values())
                checkbox.active = true;
            updating = false;
            refresh();
        });
        actions.append(selectAll);
        const clear = new Gtk.Button({label: _('Clear')});
        clear.connect('clicked', () => {
            this._visibleCategories.clear();
            updating = true;
            for (const checkbox of checkboxes.values())
                checkbox.active = false;
            updating = false;
            refresh();
        });
        actions.append(clear);
        columnsBox.append(actions);
        columnsBox.append(new Gtk.Separator({orientation: Gtk.Orientation.HORIZONTAL}));
        const checkboxBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
        for (const [category] of allCategories) {
            const checkbox = new Gtk.CheckButton({label: category, active: this._visibleCategories.has(category)});
            checkbox.connect('toggled', () => {
                if (updating)
                    return;
                if (checkbox.active)
                    this._visibleCategories.add(category);
                else
                    this._visibleCategories.delete(category);
                refresh();
            });
            checkboxes.set(category, checkbox);
            checkboxBox.append(checkbox);
        }
        columnsBox.append(new Gtk.ScrolledWindow({
            child: checkboxBox, min_content_width: 280, min_content_height: 120, max_content_height: 360,
            propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER,
        }));
        const columnsButton = new Gtk.MenuButton({label: _('Columns'), popover: new Gtk.Popover({child: columnsBox})});
        heading.append(columnsButton);
        box.append(heading);
        box.append(tableBox);
        refresh();
        return box;
    }

    _renderTable(tableBox, allCategories) {
        const _ = this._;
        clearBox(tableBox);
        const data = this._reportData;
        const table = new Gtk.Grid({column_spacing: 24, row_spacing: 6});
        const users = Object.entries(data.timeByUserAndLabel).sort();
        const categories = allCategories.filter(([category]) => this._visibleCategories.has(category));
        const header = text => {
            const label = new Gtk.Label({label: text, xalign: text === _('User') ? 0 : 1});
            label.add_css_class('dim-label');
            return label;
        };
        const figure = seconds => numericLabel({label: seconds > 0 ? formatReportHours(seconds, 2) : '–', xalign: 1});
        table.attach(header(_('User')), 0, 0, 1, 1);
        categories.forEach(([category], column) => table.attach(header(category), column + 1, 0, 1, 1));
        table.attach(header(_('Total')), categories.length + 1, 0, 1, 1);

        users.forEach(([user, userCategories], index) => {
            const row = index + 1;
            table.attach(new Gtk.Label({label: user, xalign: 0, selectable: true}), 0, row, 1, 1);
            categories.forEach(([category], column) => table.attach(figure(userCategories[category] || 0), column + 1, row, 1, 1));
            const total = categories.reduce((sum, [category]) => sum + (userCategories[category] || 0), 0);
            table.attach(figure(total), categories.length + 1, row, 1, 1);
        });

        if (users.length > 0) {
            const totalRow = users.length + 1;
            table.attach(new Gtk.Separator({orientation: Gtk.Orientation.HORIZONTAL}), 0, totalRow, categories.length + 2, 1);
            table.attach(new Gtk.Label({label: _('Total'), xalign: 0}), 0, totalRow + 1, 1, 1);
            categories.forEach(([, seconds], column) => table.attach(figure(seconds), column + 1, totalRow + 1, 1, 1));
            const sum = categories.reduce((acc, [, seconds]) => acc + seconds, 0);
            table.attach(figure(sum), categories.length + 1, totalRow + 1, 1, 1);
        }
        tableBox.append(table);
    }

    _renderCalendar() {
        const _ = this._;
        clearBox(this._calendarBox);
        this._dayCells.clear();
        const data = this._reportData;
        const timeByDay = data.timeByDay;
        const maxSeconds = timeByDay.size > 0 ? Math.max(...timeByDay.values()) : 0;
        const today = new Date();
        const weeks = calendarWeeks(this._year, this._month, timeByDay, today);

        if (this._selectedDay === null || !timeByDay.has(this._selectedDay)) {
            const isCurrentMonth = today.getFullYear() === this._year && today.getMonth() === this._month;
            if (isCurrentMonth && timeByDay.has(today.getDate()))
                this._selectedDay = today.getDate();
            else
                this._selectedDay = [...timeByDay.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        }

        const grid = new Gtk.Grid({row_spacing: 6, column_spacing: 6, column_homogeneous: false, hexpand: true});
        for (let column = 0; column < 7; column++) {
            const header = new Gtk.Label({label: GLib.DateTime.new_local(2024, 1, 8 + column, 0, 0, 0).format('%a')});
            header.add_css_class('dim-label');
            grid.attach(header, column, 0, 1, 1);
        }
        const weekHeader = new Gtk.Label({label: _('Week'), xalign: 1});
        weekHeader.add_css_class('dim-label');
        grid.attach(weekHeader, 7, 0, 1, 1);

        weeks.forEach((week, rowIndex) => {
            week.days.forEach((day, column) => {
                if (!day)
                    return;
                const cell = this._buildDayCell(day, maxSeconds);
                this._dayCells.set(day.day, cell);
                grid.attach(cell, column, rowIndex + 1, 1, 1);
            });
            const total = numericLabel({label: week.totalSeconds > 0 ? formatReportHours(week.totalSeconds) : '', xalign: 1,
                valign: Gtk.Align.CENTER, width_chars: 7});
            total.add_css_class('heading');
            grid.attach(total, 7, rowIndex + 1, 1, 1);
        });
        this._calendarBox.append(grid);

        this._dayPanel = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, width_request: 300});
        this._dayPanel.add_css_class('card');
        this._calendarBox.append(this._dayPanel);
        this._renderDayPanel();
    }

    _buildDayCell(day, maxSeconds) {
        const _ = this._;
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true});
        const dayLabel = numericLabel({label: String(day.day), xalign: 0});
        box.append(dayLabel);
        const hours = numericLabel({label: day.seconds > 0 ? formatReportHours(day.seconds) : '', xalign: 1, vexpand: true, valign: Gtk.Align.END});
        hours.add_css_class('heading');
        box.append(hours);
        const bar = plainBar({value: maxSeconds > 0 ? day.seconds / maxSeconds : 0});
        bar.update_property([Gtk.AccessibleProperty.LABEL], [_('Share of the busiest day')]);
        box.append(bar);

        const cell = new Gtk.Button({child: box, hexpand: true, vexpand: true, height_request: 64});
        cell.add_css_class('card');
        cell.add_css_class('report-calendar-day');
        if (day.seconds > 0) {
            const level = Math.min(CALENDAR_LEVELS - 1, Math.round((day.seconds / maxSeconds) * (CALENDAR_LEVELS - 1)));
            cell.add_css_class('has-time');
            cell.add_css_class(`level-${level}`);
        } else {
            dayLabel.add_css_class('dim-label');
        }
        if (day.weekend || day.future)
            cell.add_css_class('dimmed');
        if (day.today)
            cell.add_css_class('today');
        if (day.day === this._selectedDay)
            cell.add_css_class('selected');
        const dateText = GLib.DateTime.new_local(this._year, this._month + 1, day.day, 0, 0, 0).format('%A %-d %B');
        const description = day.seconds > 0 ? `${dateText}, ${formatReportHours(day.seconds, 2)}` : `${dateText}, ${_('no time')}`;
        cell.set_tooltip_text(description);
        cell.update_property([Gtk.AccessibleProperty.LABEL], [description]);
        cell.connect('clicked', () => this._selectDay(day.day));
        return cell;
    }

    _selectDay(day) {
        if (this._selectedDay !== null)
            this._dayCells.get(this._selectedDay)?.remove_css_class('selected');
        this._selectedDay = day;
        this._dayCells.get(day)?.add_css_class('selected');
        this._renderDayPanel();
    }

    _renderDayPanel() {
        const _ = this._;
        clearBox(this._dayPanel);
        const inner = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12});
        this._dayPanel.append(inner);
        const day = this._selectedDay;
        if (day === null) {
            const hint = new Gtk.Label({label: _('Select a day to see its entries'), wrap: true});
            hint.add_css_class('dim-label');
            inner.append(hint);
            return;
        }
        const title = new Gtk.Label({label: GLib.DateTime.new_local(this._year, this._month + 1, day, 0, 0, 0).format('%A, %-d %B'), xalign: 0});
        title.add_css_class('heading');
        inner.append(title);
        const entries = this._reportData.entriesByDay.get(day) ?? [];
        const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.timelog.time_spent || 0), 0);
        const subtitle = numericLabel({label: `${formatReportHours(total, 2)} · ${
            entries.length === 1 ? _('1 entry') : fmt(_('%d entries'), entries.length)}`, xalign: 0});
        subtitle.add_css_class('dim-label');
        inner.append(subtitle);

        const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE});
        list.add_css_class('boxed-list');
        for (const entry of entries) {
            const row = new Adw.ActionRow({
                title: `#${entry.issue.iid} ${entry.issue.title}`,
                subtitle: entry.timelog.summary || (entry.timelog.user?.name ?? entry.timelog.user?.username ?? ''),
                use_markup: false,
                title_lines: 2,
                subtitle_lines: 2,
            });
            row.add_suffix(numericLabel({label: formatReportHours(entry.timelog.time_spent || 0, 2), valign: Gtk.Align.CENTER}));
            const open = iconButton('web-browser-symbolic', fmt(_('Open #%s in browser'), entry.issue.iid));
            open.sensitive = Boolean(entry.issue.web_url);
            open.connect('clicked', () => this._openUri(entry.issue.web_url));
            row.add_suffix(open);
            list.append(row);
        }
        inner.append(new Gtk.ScrolledWindow({child: list, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER,
            propagate_natural_height: true, max_content_height: 520}));
    }

    // ---- month navigation --------------------------------------------------

    _monthLabel() {
        return GLib.DateTime.new_local(this._year, this._month + 1, 1, 0, 0, 0).format('%B %Y');
    }

    _isFuture(year, month) {
        const now = new Date();
        return year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth());
    }

    _changeMonth(delta) {
        const date = new Date(this._year, this._month + delta, 1);
        if (this._isFuture(date.getFullYear(), date.getMonth()))
            return;
        this._year = date.getFullYear();
        this._month = date.getMonth();
        this._monthTitle.set_label(this._monthLabel());
        this._updateMonthNavigation();
        this._loadReport();
    }

    _updateMonthNavigation() {
        const next = new Date(this._year, this._month + 1, 1);
        this._nextAction.set_enabled(!this._isFuture(next.getFullYear(), next.getMonth()));
    }

    // ---- export ------------------------------------------------------------

    _exportContent(format) {
        const _ = this._;
        const key = FORMATS[format] ? format : 'csv';
        const options = {
            projectPath: this._project.path_with_namespace,
            monthLabel: this._monthLabel(),
            strings: {title: _('Monthly Time Report'), period: _('Period'), total: _('Total time'),
                byCategory: _('Summary by category'), byUser: _('Time by user and category')},
        };
        return {key, content: key === 'md' ? toMarkdown(this._reportData, options) : toCsv(this._reportData, options)};
    }

    _export(format) {
        const _ = this._;
        if (!this._reportData || !this._project)
            return;
        const {key, content} = this._exportContent(format);
        this._config.reportExportFormat = key;
        this._updateExportLabel();
        const downloads = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) || GLib.get_home_dir();
        const filename = exportFileName(this._project.path_with_namespace, this._year, this._month, FORMATS[key].ext);
        const file = Gio.File.new_for_path(GLib.build_filenamev([downloads, filename]));
        try {
            file.replace_contents(new TextEncoder().encode(content), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            this._toasts.add_toast(new Adw.Toast({title: `${_('Unable to export')}: ${e.message}`}));
            return;
        }
        const toast = new Adw.Toast({title: `${_('Saved')} ${filename}`, button_label: _('Open'), timeout: 8});
        toast.connect('button-clicked', () => this._openUri(file.get_uri()));
        this._toasts.add_toast(toast);
    }

    _copy(format) {
        const _ = this._;
        if (!this._reportData || !this._project)
            return;
        const {content} = this._exportContent(format);
        this.get_clipboard().set(content);
        this._toasts.add_toast(new Adw.Toast({title: _('Copied report to clipboard')}));
    }

    _openUri(uri) {
        if (!uri)
            return;
        try {
            Gio.AppInfo.launch_default_for_uri(uri, null);
        } catch (e) {
            this._toasts.add_toast(new Adw.Toast({title: `${this._('Unable to open browser')}: ${e.message}`}));
        }
    }

    vfunc_close_request() {
        this._requestId++;
        if (this._filterTimeoutId) {
            GLib.source_remove(this._filterTimeoutId);
            this._filterTimeoutId = 0;
        }
        this._client.abort();
        return false;
    }
});
