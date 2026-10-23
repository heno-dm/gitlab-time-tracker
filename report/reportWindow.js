// Monthly report window (libadwaita). Data logic lives in reportData.js and
// exporters.js; this file only renders and reacts.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import {formatHours} from '../core/format.js';
import {exportFileName, toCsv, toMarkdown} from './exporters.js';
import {aggregate, authorsOf, fetchTimelogs, parseTagFilters} from './reportData.js';

const VIEWS = ['categories', 'calendar'];
const FORMATS = {csv: {ext: 'csv'}, md: {ext: 'md'}};

// Calendar heat map: day cells are tinted with the accent colour, scaled by
// the day's share of the busiest day in the month.
const CALENDAR_LEVELS = 8;
const CALENDAR_CSS = `
.report-calendar-day.today { border: 2px solid @accent_bg_color; }
.report-calendar-day.has-time { border-color: transparent; }
${Array.from({length: CALENDAR_LEVELS}, (_unused, level) => {
    const alpha = (0.15 + 0.85 * level / (CALENDAR_LEVELS - 1)).toFixed(2);
    const fg = level >= CALENDAR_LEVELS / 2 ? ' color: @accent_fg_color;' : '';
    return `.report-calendar-day.level-${level} { background-color: alpha(@accent_bg_color, ${alpha});${fg} }`;
}).join('\n')}
`;
let calendarCssInstalled = false;

function installCalendarCss() {
    if (calendarCssInstalled)
        return;
    const provider = new Gtk.CssProvider();
    provider.load_from_string(CALENDAR_CSS);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    calendarCssInstalled = true;
}

function clearBox(box) {
    let child = box.get_first_child();
    while (child) {
        const next = child.get_next_sibling();
        box.remove(child);
        child = next;
    }
}

export const ReportWindow = GObject.registerClass(
class ReportWindow extends Adw.ApplicationWindow {
    _init({application, config, client, issues, gettext, preselectedProjectId}) {
        super._init({application, title: gettext('Monthly Report'), default_width: 1000, default_height: 760});
        this._ = gettext;
        installCalendarCss();
        this._config = config;
        this._client = client;
        this._issues = issues;
        this._preselectedProjectId = preselectedProjectId;
        this._projects = [];
        this._project = null;
        this._entries = [];
        this._reportData = null;
        this._authors = [];
        this._visibleCategories = null;
        this._requestId = 0;
        this._filterTimeoutId = 0;
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
        add('export-default', () => this._export(this._config.reportExportFormat));
        add('retry', () => this._loadReport());
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
        const prev = new Gtk.Button({icon_name: 'go-previous-symbolic', action_name: 'win.prev-month', tooltip_text: _('Previous month')});
        const next = new Gtk.Button({icon_name: 'go-next-symbolic', action_name: 'win.next-month', tooltip_text: _('Next month')});
        nav.append(prev);
        nav.append(next);
        header.pack_start(nav);

        this._windowTitle = new Adw.WindowTitle({title: this._monthLabel(), subtitle: ''});
        header.set_title_widget(this._windowTitle);

        this._stack = new Adw.ViewStack();
        this._viewSwitcher = new Adw.ViewSwitcher({stack: this._stack, policy: Adw.ViewSwitcherPolicy.WIDE});
        header.pack_end(this._buildExportButton());
        header.pack_end(this._viewSwitcher);

        const root = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12,
            margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12});
        toolbarView.set_content(root);
        root.append(this._buildToolbar());

        this._summary = new Gtk.Label({xalign: 0, label: ''});
        this._summary.add_css_class('heading');
        root.append(this._summary);

        this._pages = new Gtk.Stack({vexpand: true, transition_type: Gtk.StackTransitionType.CROSSFADE});
        root.append(this._pages);

        const spinner = new Gtk.Spinner({spinning: true, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, width_request: 48, height_request: 48});
        this._pages.add_named(spinner, 'loading');

        this._status = new Adw.StatusPage({title: _('Unable to load report'), icon_name: 'network-error-symbolic'});
        const retry = new Gtk.Button({label: _('Retry'), action_name: 'win.retry', halign: Gtk.Align.CENTER});
        retry.add_css_class('pill');
        retry.add_css_class('suggested-action');
        this._status.set_child(retry);
        this._pages.add_named(this._status, 'error');

        this._pages.add_named(this._stack, 'content');

        this._categoriesBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
        this._stack.add_titled(new Gtk.ScrolledWindow({child: this._categoriesBox, hscrollbar_policy: Gtk.PolicyType.NEVER}),
            'categories', _('Categories')).set_icon_name('view-list-symbolic');
        this._calendarBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});
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
        menu.append(_('Export as CSV'), 'win.export-csv');
        menu.append(_('Export as Markdown'), 'win.export-md');
        this._exportButton = new Adw.SplitButton({menu_model: menu, action_name: 'win.export-default', sensitive: false});
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

        this._projectModel = new Gtk.StringList();
        this._projectDropdown = new Gtk.DropDown({
            model: this._projectModel,
            enable_search: true,
            hexpand: true,
            expression: Gtk.PropertyExpression.new(Gtk.StringObject, null, 'string'),
            tooltip_text: _('Project'),
        });
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

        this._userModel = new Gtk.StringList();
        this._userDropdown = new Gtk.DropDown({model: this._userModel, tooltip_text: _('User')});
        this._userDropdown.connect('notify::selected', () => {
            if (this._updatingUsers)
                return;
            const index = this._userDropdown.get_selected();
            this._config.reportUser = index > 0 ? this._authors[index - 1]?.username ?? '' : '';
            this._process();
        });
        toolbar.append(this._userDropdown);

        const popover = new Gtk.Popover();
        const popoverBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8});
        popover.set_child(popoverBox);
        popoverBox.append(new Gtk.Label({label: _('Category labels or regular expressions, comma-separated'), xalign: 0}));
        this._categoryEntry = new Gtk.Entry({
            text: this._config.reportTagsFilter,
            placeholder_text: 'Bug,^Feature.*$',
            width_chars: 40,
        });
        this._categoryEntry.connect('changed', () => {
            this._config.reportTagsFilter = this._categoryEntry.get_text().trim();
            this._updateCategoryLabel();
            this._scheduleProcess();
        });
        popoverBox.append(this._categoryEntry);
        const hint = new Gtk.Label({label: _('Issues without a matching label are grouped as “Other”.'), xalign: 0, wrap: true});
        hint.add_css_class('dim-label');
        popoverBox.append(hint);
        this._categoryButton = new Gtk.MenuButton({popover, always_show_arrow: true, tooltip_text: _('Filter categories')});
        this._updateCategoryLabel();
        toolbar.append(this._categoryButton);
        return toolbar;
    }

    _updateCategoryLabel() {
        const _ = this._;
        const count = parseTagFilters(this._config.reportTagsFilter).length;
        this._categoryButton.set_label(count === 0 ? _('Categories: All') : `${_('Categories')}: ${count}`);
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
        if (!this._project)
            return;
        const requestId = ++this._requestId;
        const {_project: project, _year: year, _month: month} = this;
        this._reportData = null;
        this._entries = [];
        this._exportButton.sensitive = false;
        this._summary.set_label('');
        this._windowTitle.set_subtitle(project.path_with_namespace);
        this._pages.set_visible_child_name('loading');
        try {
            const entries = await fetchTimelogs(this._client, project.id, year, month);
            if (requestId !== this._requestId)
                return;
            this._entries = entries;
            this._setAuthors(authorsOf(entries));
            this._pages.set_visible_child_name('content');
            this._process();
        } catch (error) {
            if (requestId !== this._requestId)
                return;
            this._showError(error);
        }
    }

    _showError(error) {
        const _ = this._;
        const messages = {
            auth: _('Invalid token or insufficient permissions'),
            network: _('Server not reachable'),
            config: _('GitLab is not configured. Open the extension settings first.'),
        };
        this._status.set_description(messages[error?.kind] ?? (error?.message ?? String(error)));
        this._pages.set_visible_child_name('error');
    }

    _setAuthors(authors) {
        const _ = this._;
        this._authors = authors;
        this._updatingUsers = true;
        this._userModel.splice(0, this._userModel.get_n_items(),
            [_('Everyone'), ...authors.map(author => `${author.name} (@${author.username})`)]);
        const saved = this._config.reportUser;
        const index = saved ? authors.findIndex(author => author.username === saved) : -1;
        this._userDropdown.set_selected(index >= 0 ? index + 1 : 0);
        this._updatingUsers = false;
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

    _selectedAuthor() {
        const index = this._userDropdown.get_selected();
        return index > 0 ? this._authors[index - 1]?.username ?? '' : '';
    }

    _process() {
        const _ = this._;
        if (this._pages.get_visible_child_name() !== 'content')
            return;
        const author = this._selectedAuthor();
        if (author && !this._authors.some(candidate => candidate.username === author))
            return;
        this._reportData = aggregate(this._entries, {
            author,
            tagFilters: parseTagFilters(this._config.reportTagsFilter),
            year: this._year,
            month: this._month,
            labels: {other: _('Other'), none: _('No label'), unknown: _('Unknown user')},
        });
        this._exportButton.sensitive = true;
        const data = this._reportData;
        this._summary.set_label(`${_('Total')} ${formatHours(data.totalSeconds)} · ${data.issueCount} ${_('issues')} · ${data.categoryCount} ${_('categories')}`);
        this._renderCategories();
        this._renderCalendar();
    }

    // ---- rendering ---------------------------------------------------------

    _renderCategories() {
        const _ = this._;
        clearBox(this._categoriesBox);
        const data = this._reportData;
        const categories = Object.entries(data.timeByLabel).sort((a, b) => b[1] - a[1]);
        if (categories.length === 0) {
            const empty = new Gtk.Label({label: _('No time tracked for this period'), xalign: 0});
            empty.add_css_class('dim-label');
            this._categoriesBox.append(empty);
            return;
        }
        const maxSeconds = Math.max(...categories.map(([, seconds]) => seconds));
        const bars = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        for (const [label, seconds] of categories) {
            const row = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 12});
            row.append(new Gtk.Label({label, xalign: 0, width_chars: 24, max_width_chars: 24, ellipsize: Pango.EllipsizeMode.END, valign: Gtk.Align.CENTER}));
            row.append(new Gtk.LevelBar({value: maxSeconds > 0 ? seconds / maxSeconds : 0, hexpand: true, valign: Gtk.Align.CENTER}));
            row.append(new Gtk.Label({label: formatHours(seconds), width_chars: 8, xalign: 1, valign: Gtk.Align.CENTER}));
            bars.append(row);
        }
        this._categoriesBox.append(bars);
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
        table.attach(header(_('User')), 0, 0, 1, 1);
        categories.forEach(([category], column) => table.attach(header(category), column + 1, 0, 1, 1));
        table.attach(header(_('Total')), categories.length + 1, 0, 1, 1);

        users.forEach(([user, userCategories], index) => {
            const row = index + 1;
            table.attach(new Gtk.Label({label: user, xalign: 0, selectable: true}), 0, row, 1, 1);
            categories.forEach(([category], column) => {
                const seconds = userCategories[category] || 0;
                table.attach(new Gtk.Label({label: seconds > 0 ? formatHours(seconds, 2) : '–', xalign: 1}), column + 1, row, 1, 1);
            });
            const total = categories.reduce((sum, [category]) => sum + (userCategories[category] || 0), 0);
            table.attach(new Gtk.Label({label: formatHours(total, 2), xalign: 1}), categories.length + 1, row, 1, 1);
        });

        if (users.length > 0) {
            const totalRow = users.length + 1;
            table.attach(new Gtk.Separator({orientation: Gtk.Orientation.HORIZONTAL}), 0, totalRow, categories.length + 2, 1);
            table.attach(new Gtk.Label({label: _('Total'), xalign: 0}), 0, totalRow + 1, 1, 1);
            categories.forEach(([, seconds], column) =>
                table.attach(new Gtk.Label({label: formatHours(seconds, 2), xalign: 1}), column + 1, totalRow + 1, 1, 1));
            const sum = categories.reduce((acc, [, seconds]) => acc + seconds, 0);
            table.attach(new Gtk.Label({label: formatHours(sum, 2), xalign: 1}), categories.length + 1, totalRow + 1, 1, 1);
        }
        tableBox.append(table);
    }

    _renderCalendar() {
        const _ = this._;
        clearBox(this._calendarBox);
        const data = this._reportData;
        const timeByDay = data.timeByDay;
        if (timeByDay.size === 0) {
            const empty = new Gtk.Label({label: _('No time tracked for this period'), xalign: 0});
            empty.add_css_class('dim-label');
            this._calendarBox.append(empty);
            return;
        }
        const maxSeconds = Math.max(...timeByDay.values());
        const weekStart = 1; // Monday
        const daysInMonth = new Date(this._year, this._month + 1, 0).getDate();
        const firstWeekday = new Date(this._year, this._month, 1).getDay();
        const leadingBlanks = (firstWeekday - weekStart + 7) % 7;
        const today = new Date();
        const isCurrentMonth = today.getFullYear() === this._year && today.getMonth() === this._month;

        const grid = new Gtk.Grid({row_spacing: 6, column_spacing: 6, row_homogeneous: true, column_homogeneous: true, hexpand: true});
        for (let column = 0; column < 7; column++) {
            const weekday = (weekStart + column) % 7;
            const header = new Gtk.Label({label: GLib.DateTime.new_local(2024, 1, 7 + weekday, 0, 0, 0).format('%a')});
            header.add_css_class('dim-label');
            grid.attach(header, column, 0, 1, 1);
        }
        for (let day = 1; day <= daysInMonth; day++) {
            const index = leadingBlanks + day - 1;
            const seconds = timeByDay.get(day) || 0;
            const cell = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, hexpand: true, vexpand: true,
                margin_top: 4, margin_bottom: 4, margin_start: 6, margin_end: 6, height_request: 56});
            const card = new Gtk.Frame({child: cell});
            card.add_css_class('card');
            card.add_css_class('report-calendar-day');
            if (seconds > 0) {
                const level = Math.min(CALENDAR_LEVELS - 1, Math.round((seconds / maxSeconds) * (CALENDAR_LEVELS - 1)));
                card.add_css_class('has-time');
                card.add_css_class(`level-${level}`);
            }
            if (isCurrentMonth && day === today.getDate())
                card.add_css_class('today');
            const dayLabel = new Gtk.Label({label: String(day), xalign: 0});
            if (seconds === 0)
                dayLabel.add_css_class('dim-label');
            cell.append(dayLabel);
            const hoursLabel = new Gtk.Label({label: seconds > 0 ? formatHours(seconds) : '', xalign: 1, vexpand: true, valign: Gtk.Align.END});
            hoursLabel.add_css_class('heading');
            cell.append(hoursLabel);
            if (seconds > 0)
                card.set_tooltip_text(formatHours(seconds, 2));
            grid.attach(card, index % 7, 1 + Math.floor(index / 7), 1, 1);
        }
        this._calendarBox.append(grid);
        this._calendarBox.append(this._buildTable(Object.entries(data.timeByLabel).sort((a, b) => b[1] - a[1])));
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
        this._windowTitle.set_title(this._monthLabel());
        this._updateMonthNavigation();
        this._loadReport();
    }

    _updateMonthNavigation() {
        const next = new Date(this._year, this._month + 1, 1);
        this._nextAction.set_enabled(!this._isFuture(next.getFullYear(), next.getMonth()));
    }

    // ---- export ------------------------------------------------------------

    _export(format) {
        const _ = this._;
        if (!this._reportData || !this._project)
            return;
        const key = FORMATS[format] ? format : 'csv';
        this._config.reportExportFormat = key;
        this._updateExportLabel();
        const options = {
            projectPath: this._project.path_with_namespace,
            monthLabel: this._monthLabel(),
            strings: {title: _('Monthly Time Report'), period: _('Period'), total: _('Total time'),
                byCategory: _('Summary by category'), byUser: _('Time by user and category')},
        };
        const content = key === 'md' ? toMarkdown(this._reportData, options) : toCsv(this._reportData, options);
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
        toast.connect('button-clicked', () => {
            try {
                Gio.AppInfo.launch_default_for_uri(file.get_uri(), null);
            } catch (e) {
                this._toasts.add_toast(new Adw.Toast({title: `${_('Unable to open file')}: ${e.message}`}));
            }
        });
        this._toasts.add_toast(toast);
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
