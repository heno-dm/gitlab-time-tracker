// Menu sections. Each keeps existing rows keyed by session/issue so focus and
// hover survive refreshes; only labels and visibility change in place.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {formatClock, formatHuman, formatShort} from '../core/format.js';
import {sessionKey} from '../core/sessionStore.js';

function ellipsized(label) {
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    label.clutter_text.line_wrap = false;
    return label;
}

function numeric(label) {
    label.add_style_class_name('timelogs-numeric');
    return label;
}

function iconButton(iconName, accessibleName, onClick) {
    const button = new St.Button({
        style_class: 'icon-button',
        can_focus: true,
        child: new St.Icon({icon_name: iconName, style_class: 'popup-menu-icon'}),
        accessible_name: accessibleName,
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', () => onClick());
    return button;
}

/** Labelled button: icon + text, stock `button` style. */
function labelledButton(iconName, text, onClick) {
    const content = new St.BoxLayout({style_class: 'timelogs-button-content'});
    const icon = new St.Icon({icon_name: iconName, style_class: 'popup-menu-icon', y_align: Clutter.ActorAlign.CENTER});
    const label = new St.Label({text, y_align: Clutter.ActorAlign.CENTER});
    content.add_child(icon);
    content.add_child(label);
    const button = new St.Button({style_class: 'button', can_focus: true, child: content, accessible_name: text,
        y_align: Clutter.ActorAlign.CENTER});
    button.connect('clicked', () => onClick());
    button.setContent = (newIcon, newText) => {
        icon.icon_name = newIcon;
        label.set_text(newText);
        button.accessible_name = newText;
    };
    return button;
}

function setEnabled(button, enabled) {
    button.reactive = enabled;
    button.can_focus = enabled;
    if (enabled)
        button.remove_style_pseudo_class('insensitive');
    else
        button.add_style_pseudo_class('insensitive');
}

function isEnter(symbol) {
    return symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter || symbol === Clutter.KEY_ISO_Enter;
}

function isCtrlEnter(event) {
    return isEnter(event.get_key_symbol()) && Boolean(event.get_state() & Clutter.ModifierType.CONTROL_MASK);
}

/**
 * One-row warning banner: icon, text and one action button. Shown for auth
 * errors and offline state; the "Set up GitLab…" row replaces it (§2.9).
 */
export class BannerSection extends PopupMenu.PopupMenuSection {
    constructor() {
        super();
        this._item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, activate: false, hover: false,
            style_class: 'timelogs-banner'});
        this._item.add_child(new St.Icon({icon_name: 'dialog-warning-symbolic', style_class: 'popup-menu-icon',
            y_align: Clutter.ActorAlign.CENTER}));
        this._label = ellipsized(new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        this._item.add_child(this._label);
        this._item.label_actor = this._label;
        this._button = new St.Button({style_class: 'button', can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        this._button.connect('clicked', () => this._onAction?.());
        this._item.add_child(this._button);
        this.addMenuItem(this._item);
        this.actor.visible = false;
    }

    /** @param {{text: string, action: string, onAction: () => void}|null} banner */
    update(banner) {
        if (!banner) {
            this.actor.visible = false;
            return;
        }
        this._label.set_text(banner.text);
        this._button.set_label(banner.action);
        this._button.accessible_name = banner.action;
        this._onAction = banner.onAction;
        this.actor.visible = true;
    }
}

export const SearchSection = GObject.registerClass({
    Signals: {
        'text-changed': {param_types: [GObject.TYPE_STRING]},
        'activate-first': {},
        'navigate-down': {},
    },
}, class SearchSection extends PopupMenu.PopupBaseMenuItem {
    _init({gettext}) {
        super._init({reactive: false, can_focus: false, activate: false, hover: false});
        this._ = gettext;
        this._defaultHint = gettext('Search issues or #number…');
        this.entry = new St.Entry({
            hint_text: this._defaultHint,
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'popup-menu-icon'}),
        });
        this._clearIcon = new St.Icon({icon_name: 'edit-clear-symbolic', style_class: 'popup-menu-icon'});
        this.add_child(this.entry);
        this.entry.clutter_text.connect('text-changed', () => {
            this.entry.secondary_icon = this.text ? this._clearIcon : null;
            this.emit('text-changed', this.text);
        });
        this.entry.connect('secondary-icon-clicked', () => this.clear());
        this.entry.clutter_text.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Down || symbol === Clutter.KEY_Tab) {
                this.emit('navigate-down');
                return Clutter.EVENT_STOP;
            }
            if (isEnter(symbol)) {
                this.emit('activate-first');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    get text() {
        return this.entry.get_text().trim();
    }

    /** Offline: only local sessions are searchable, and the placeholder says so. */
    setOffline(offline) {
        this.entry.hint_text = offline ? this._('Search your sessions (offline)') : this._defaultHint;
    }

    clear() {
        if (this.entry.get_text() !== '')
            this.entry.set_text('');
    }

    focus() {
        this.entry.grab_key_focus();
    }
});

/**
 * A row describing one issue: optional leading glyph, "#iid title", optional
 * project line, optional elapsed, suffix buttons. Sections set `onSelected`,
 * a plain callback invoked after the menu has handled `activate` (and closed).
 * It is not a GObject signal on purpose: closing the menu clears the search,
 * which destroys result rows and would disconnect their signal handlers
 * before they could fire.
 */
export const IssueRow = GObject.registerClass({
    Signals: {'open-in-browser': {}},
}, class IssueRow extends PopupMenu.PopupBaseMenuItem {
    _init({project, issue, showProject = false, elapsedText = null, leadingIcon = null}) {
        super._init({});
        this.project = project;
        this.issue = issue;
        this.key = sessionKey(project, issue);
        this.onSelected = null; // (project, issue, key) => void
        this._showProject = showProject;
        this._note = null;

        this._leading = new St.Icon({icon_name: leadingIcon ?? 'media-playback-start-symbolic',
            style_class: 'popup-menu-icon', visible: leadingIcon !== null, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._leading);

        const text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = ellipsized(new St.Label({text: `#${issue.iid} ${issue.title}`, x_expand: true}));
        text.add_child(this._title);
        this._subtitle = ellipsized(new St.Label({
            text: project.path_with_namespace ?? '',
            style_class: 'timelogs-subtitle',
            visible: showProject,
        }));
        text.add_child(this._subtitle);
        this.add_child(text);
        this.label_actor = this._title;

        this._elapsed = numeric(new St.Label({text: elapsedText ?? '', y_align: Clutter.ActorAlign.CENTER, visible: elapsedText !== null}));
        this.add_child(this._elapsed);

        this._suffix = new St.BoxLayout({style_class: 'timelogs-row-buttons', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._suffix);

        this.connect('key-press-event', (_actor, event) => {
            if (isCtrlEnter(event)) {
                this.emit('open-in-browser');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    addButton(iconName, accessibleName, onClick) {
        const button = iconButton(iconName, accessibleName, onClick);
        this._suffix.add_child(button);
        return button;
    }

    /**
     * @param {{project?, issue?, showProject?: boolean, elapsedText?: string|null, note?: string|null, leadingIcon?: boolean}} params
     * The secondary line shows the project path (when `showProject`) and/or a note such as "paused".
     */
    update({project, issue, showProject, elapsedText, note, leadingIcon}) {
        if (project)
            this.project = project;
        if (issue) {
            this.issue = issue;
            this._title.set_text(`#${issue.iid} ${issue.title}`);
        }
        if (showProject !== undefined)
            this._showProject = showProject;
        if (note !== undefined)
            this._note = note;
        if (leadingIcon !== undefined)
            this._leading.visible = Boolean(leadingIcon);
        const parts = [this._showProject ? this.project.path_with_namespace : null, this._note].filter(Boolean);
        this._subtitle.set_text(parts.join(' · '));
        this._subtitle.visible = parts.length > 0;
        if (elapsedText !== undefined) {
            this._elapsed.set_text(elapsedText ?? '');
            this._elapsed.visible = elapsedText !== null;
        }
        this.accessible_name = [this._title.text, ...parts, this._elapsed.visible ? this._elapsed.text : null]
            .filter(Boolean).join(', ');
    }

    activate(event) {
        // Capture before closing: the close may destroy this row.
        const {project, issue, key, onSelected} = this;
        super.activate(event);
        onSelected?.(project, issue, key);
    }
});

/** Shared helper: reconcile rows keyed by item key, keeping existing actors. */
class KeyedRows {
    constructor(section, insertAt = 0) {
        this.section = section;
        this.rows = new Map();
        this.insertAt = insertAt;
    }

    sync(items, {create, update}) {
        const keep = new Set();
        items.forEach((item, index) => {
            const key = item.key;
            keep.add(key);
            let row = this.rows.get(key);
            if (!row) {
                row = create(item);
                row.connect('destroy', () => {
                    if (this.rows.get(key) === row)
                        this.rows.delete(key);
                });
                this.rows.set(key, row);
                this.section.addMenuItem(row, this.insertAt + index);
                update(row, item);
            } else {
                update(row, item);
                const position = this.insertAt + index;
                const children = this.section.box.get_children();
                if (children[position] !== row)
                    this.section.box.set_child_at_index(row, position);
            }
        });
        for (const [key, row] of [...this.rows.entries()]) {
            if (!keep.has(key)) {
                this.rows.delete(key);
                row.destroy();
            }
        }
    }

    first() {
        return this.section.box.get_children().find(child => child instanceof IssueRow && child.visible) ?? null;
    }
}

/**
 * The active block (§2.13): not activatable; title + elapsed, optional project
 * line, then Pause/Resume and Submit… with labels, Open in browser, spacer, Discard.
 * Space on the focused block toggles pause.
 */
export class ActiveSection extends PopupMenu.PopupMenuSection {
    /**
     * @param {{gettext, onToggle, onSubmit, onOpen, onDiscard}} params
     */
    constructor({gettext, onToggle, onSubmit, onOpen, onDiscard}) {
        super();
        const _ = gettext;
        this._ = gettext;
        this._callbacks = {onToggle, onSubmit, onOpen, onDiscard};
        this._active = null;

        this._block = new PopupMenu.PopupBaseMenuItem({activate: false, hover: false, can_focus: true,
            style_class: 'timelogs-active-block'});
        const column = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'timelogs-active-column'});
        this._block.add_child(column);

        const titleRow = new St.BoxLayout({x_expand: true});
        this._title = ellipsized(new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        titleRow.add_child(this._title);
        this._elapsed = numeric(new St.Label({y_align: Clutter.ActorAlign.CENTER}));
        titleRow.add_child(this._elapsed);
        column.add_child(titleRow);
        this._block.label_actor = this._title;

        this._subtitle = ellipsized(new St.Label({style_class: 'timelogs-subtitle', visible: false}));
        column.add_child(this._subtitle);

        const buttons = new St.BoxLayout({x_expand: true, style_class: 'timelogs-active-buttons'});
        this._toggleButton = labelledButton('media-playback-pause-symbolic', _('Pause'), () => this._callbacks.onToggle());
        buttons.add_child(this._toggleButton);
        this._submitButton = labelledButton('document-send-symbolic', _('Submit…'), () => this._callbacks.onSubmit(this._active?.key));
        this._submitButton.add_style_class_name('timelogs-primary-button');
        buttons.add_child(this._submitButton);
        this._openButton = iconButton('web-browser-symbolic', _('Open in browser'), () => this._callbacks.onOpen(this._active?.issue));
        buttons.add_child(this._openButton);
        buttons.add_child(new St.Widget({x_expand: true}));
        this._discardButton = iconButton('user-trash-symbolic', _('Discard'), () => this._callbacks.onDiscard(this._active?.key));
        buttons.add_child(this._discardButton);
        column.add_child(buttons);

        this._block.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_space && this._active && !this._active.sending) {
                this._callbacks.onToggle();
                return Clutter.EVENT_STOP;
            }
            if (isCtrlEnter(event) && this._active) {
                this._callbacks.onOpen(this._active.issue);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.addMenuItem(this._block);
        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.actor.visible = false;
    }

    /** Focusable block, used for Down navigation from the search entry. */
    get row() {
        return this.actor.visible ? this._block : null;
    }

    update(active, {showProject}) {
        this._active = active;
        if (!active) {
            this.actor.visible = false;
            return;
        }
        const _ = this._;
        this._title.set_text(`#${active.issue.iid} ${active.issue.title}`);
        this._elapsed.set_text(formatClock(active.elapsedSeconds));
        const parts = [showProject ? active.project.path_with_namespace : null, active.sending ? _('Submitting…') : null].filter(Boolean);
        this._subtitle.set_text(parts.join(' · '));
        this._subtitle.visible = parts.length > 0;
        this._toggleButton.setContent(active.running ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
            active.running ? _('Pause') : _('Resume'));
        for (const button of [this._toggleButton, this._submitButton, this._discardButton])
            setEnabled(button, !active.sending);
        this._block.accessible_name = `${active.running ? _('Active') : _('Paused')}: #${active.issue.iid} ${active.issue.title}, ${formatClock(active.elapsedSeconds)}`;
        this.actor.visible = true;
    }

    tick(active) {
        if (this._active && active && this._active.key === active.key) {
            this._active = active;
            this._elapsed.set_text(formatClock(active.elapsedSeconds));
        }
    }
}

export class PausedSection extends PopupMenu.PopupMenuSection {
    constructor({gettext, onSwitch, onSubmit, onOpen}) {
        super();
        this._ = gettext;
        this._callbacks = {onSwitch, onSubmit, onOpen};
        this._heading = new PopupMenu.PopupSeparatorMenuItem(gettext('Paused'));
        this.addMenuItem(this._heading);
        this._rows = new KeyedRows(this, 1);
        this.actor.visible = false;
    }

    update(paused, {showProject}) {
        const _ = this._;
        this._rows.sync(paused, {
            create: session => {
                const row = new IssueRow({
                    project: session.project,
                    issue: session.issue,
                    showProject,
                    elapsedText: formatShort(session.elapsedSeconds),
                });
                row.onSelected = (_project, _issue, key) => this._callbacks.onSwitch(key);
                row.connect('open-in-browser', () => this._callbacks.onOpen(row.issue));
                row._submitButton = row.addButton('document-send-symbolic', _('Submit…'), () => this._callbacks.onSubmit(row.key));
                return row;
            },
            update: (row, session) => {
                row.update({
                    project: session.project,
                    issue: session.issue,
                    showProject,
                    elapsedText: session.sending ? _('Submitting…') : formatShort(session.elapsedSeconds),
                });
                row.setSensitive(!session.sending);
                row._submitButton.visible = !session.sending;
                setEnabled(row._submitButton, !session.sending);
            },
        });
        const unsubmitted = paused.reduce((sum, session) => sum + session.elapsedSeconds, 0);
        this._heading.label.set_text(paused.length > 0
            ? _('Paused · %s not submitted').format(formatShort(unsubmitted))
            : _('Paused'));
        this.actor.visible = paused.length > 0;
    }

    get firstRow() {
        return this._rows.first();
    }
}

export class QueueSection extends PopupMenu.PopupMenuSection {
    constructor({gettext, onStart, onOpen, onChooseProjects}) {
        super();
        this._ = gettext;
        this._callbacks = {onStart, onOpen, onChooseProjects};
        this._heading = new PopupMenu.PopupSeparatorMenuItem(gettext('Doing'));
        this.addMenuItem(this._heading);
        this._rows = new KeyedRows(this, 1);
        this._chooseRow = new PopupMenu.PopupMenuItem(gettext('Choose projects…'));
        this._chooseRow.connect('activate', () => this._callbacks.onChooseProjects());
        this.addMenuItem(this._chooseRow);
        this._status = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        this._status.label.add_style_class_name('timelogs-subtitle');
        ellipsized(this._status.label);
        this.addMenuItem(this._status);
        this.actor.visible = false;
    }

    /**
     * @param {object[]} items  IssueItem with key
     * @param {{showProject: boolean, status: string|null, needsProjects: boolean, visible: boolean,
     *          idle: boolean, staleSince: string|null}} options
     * `idle` = nothing is being tracked (heading invites a click, rows get a play glyph);
     * `staleSince` = time of the cached queue when the last refresh failed.
     */
    update(items, {showProject, status, needsProjects, visible, idle, staleSince}) {
        const _ = this._;
        this._rows.sync(visible ? items : [], {
            create: item => {
                const row = new IssueRow({project: item.project, issue: item.issue, showProject});
                row.onSelected = (project, issue) => this._callbacks.onStart(project, issue);
                row.connect('open-in-browser', () => this._callbacks.onOpen(row.issue));
                return row;
            },
            update: (row, item) => row.update({project: item.project, issue: item.issue, showProject, leadingIcon: idle}),
        });
        let heading = _('Doing');
        if (staleSince)
            heading = _('Doing · from %s').format(staleSince);
        else if (idle && items.length > 0)
            heading = _('Doing — click to start');
        this._heading.label.set_text(heading);
        this._chooseRow.visible = visible && needsProjects;
        this._status.visible = visible && Boolean(status);
        if (status)
            this._status.label.set_text(status);
        const show = visible && (items.length > 0 || Boolean(status) || needsProjects);
        this._heading.visible = show;
        this.actor.visible = show;
    }

    get firstRow() {
        return this._rows.first();
    }
}

export class ResultsSection extends PopupMenu.PopupMenuSection {
    constructor({gettext, onStart, onOpen, onIncludeClosed, onSearchOnGitLab}) {
        super();
        const _ = gettext;
        this._ = gettext;
        this._callbacks = {onStart, onOpen, onIncludeClosed, onSearchOnGitLab};
        this._rows = new KeyedRows(this, 0);
        this._status = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        this._status.label.add_style_class_name('timelogs-subtitle');
        ellipsized(this._status.label);
        this.addMenuItem(this._status);

        // "No results" state: centred two-line message, then two action rows.
        this._empty = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, activate: false, hover: false});
        const emptyBox = new St.BoxLayout({vertical: true, x_expand: true, x_align: Clutter.ActorAlign.CENTER,
            style_class: 'timelogs-empty'});
        this._emptyTitle = ellipsized(new St.Label({x_align: Clutter.ActorAlign.CENTER}));
        this._emptyDetail = ellipsized(new St.Label({style_class: 'timelogs-subtitle', x_align: Clutter.ActorAlign.CENTER}));
        emptyBox.add_child(this._emptyTitle);
        emptyBox.add_child(this._emptyDetail);
        this._empty.add_child(emptyBox);
        this.addMenuItem(this._empty);
        this._includeClosedRow = new PopupMenu.PopupMenuItem(_('Include closed issues'));
        this._includeClosedRow.connect('activate', () => this._callbacks.onIncludeClosed());
        this.addMenuItem(this._includeClosedRow);
        this._searchOnGitLabRow = new PopupMenu.PopupMenuItem(_('Search on GitLab'));
        this._searchOnGitLabRow.connect('activate', () => this._callbacks.onSearchOnGitLab());
        this.addMenuItem(this._searchOnGitLabRow);
        this.actor.visible = false;
    }

    /**
     * @param {object[]} items  with key, project, issue, badge (e.g. "paused"), elapsedText
     * @param {{showProject: boolean, status: string|null, visible: boolean,
     *          empty: {query: string, projects: string[], closedIncluded: boolean, canSearchRemote: boolean}|null}} options
     */
    update(items, {showProject, status, visible, empty = null}) {
        const _ = this._;
        this._rows.sync(visible ? items : [], {
            create: item => {
                const row = new IssueRow({
                    project: item.project,
                    issue: item.issue,
                    showProject,
                    elapsedText: item.elapsedText ?? null,
                });
                row.onSelected = (project, issue) => this._callbacks.onStart(project, issue);
                row.connect('open-in-browser', () => this._callbacks.onOpen(row.issue));
                return row;
            },
            update: (row, item) => row.update({
                project: item.project,
                issue: item.issue,
                showProject,
                elapsedText: item.elapsedText ?? null,
                note: item.badge ?? null,
            }),
        });
        this._status.visible = visible && Boolean(status);
        if (status)
            this._status.label.set_text(status);
        const showEmpty = visible && Boolean(empty);
        this._empty.visible = showEmpty;
        this._includeClosedRow.visible = showEmpty && empty.canSearchRemote && !empty.closedIncluded;
        this._searchOnGitLabRow.visible = showEmpty && empty.canSearchRemote;
        if (showEmpty) {
            this._emptyTitle.set_text(empty.closedIncluded
                ? _('No issues match “%s”').format(empty.query)
                : _('No open issues match “%s”').format(empty.query));
            this._emptyDetail.set_text(empty.projects.length > 0
                ? _('Searched %s').format(empty.projects.join(', '))
                : _('Only your sessions were searched'));
        }
        this.actor.visible = visible;
    }

    get firstRow() {
        return this._rows.first();
    }
}

export class Footer extends PopupMenu.PopupMenuSection {
    constructor({gettext, onReport, onSettings}) {
        super();
        this._ = gettext;
        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._report = new PopupMenu.PopupMenuItem(gettext('Report'));
        this._today = numeric(new St.Label({style_class: 'timelogs-subtitle', y_align: Clutter.ActorAlign.CENTER, visible: false}));
        this._report.add_child(this._today);
        this._report.connect('activate', () => onReport());
        this.addMenuItem(this._report);
        const settings = new PopupMenu.PopupMenuItem(gettext('Settings'));
        settings.connect('activate', () => onSettings());
        this.addMenuItem(settings);
    }

    /** @param {number} todaySeconds successful submits today; the suffix is hidden when 0 */
    update({todaySeconds}) {
        const show = todaySeconds > 0;
        this._today.visible = show;
        if (show)
            this._today.set_text(this._('Today %s').format(formatHuman(todaySeconds)));
        this._report.accessible_name = show ? `${this._('Report')}, ${this._today.text}` : this._('Report');
    }
}
