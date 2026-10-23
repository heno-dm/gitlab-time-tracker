// Menu sections. Each keeps existing rows keyed by session/issue so focus and
// hover survive refreshes; only labels and visibility change in place.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {formatClock, formatShort} from '../core/format.js';
import {sessionKey} from '../core/sessionStore.js';

function ellipsized(label) {
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    label.clutter_text.line_wrap = false;
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

function isCtrlEnter(event) {
    const symbol = event.get_key_symbol();
    const enter = symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter || symbol === Clutter.KEY_ISO_Enter;
    return enter && Boolean(event.get_state() & Clutter.ModifierType.CONTROL_MASK);
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
        this.entry = new St.Entry({
            hint_text: gettext('Search issues or #number…'),
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'popup-menu-icon'}),
        });
        this.add_child(this.entry);
        this.entry.clutter_text.connect('text-changed', () => this.emit('text-changed', this.text));
        this.entry.clutter_text.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Down || symbol === Clutter.KEY_Tab) {
                this.emit('navigate-down');
                return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter || symbol === Clutter.KEY_ISO_Enter) {
                this.emit('activate-first');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    get text() {
        return this.entry.get_text().trim();
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
 * A row describing one issue: "#iid title", optional project line, optional elapsed, suffix buttons.
 * Sections react to `selected`, which fires after the menu has handled `activate` (and closed),
 * so a handler may destroy the row without skipping the close.
 */
export const IssueRow = GObject.registerClass({
    Signals: {'open-in-browser': {}, 'selected': {}},
}, class IssueRow extends PopupMenu.PopupBaseMenuItem {
    _init({project, issue, showProject = false, elapsedText = null, onActivate = null, hover = true}) {
        super._init({hover});
        this.project = project;
        this.issue = issue;
        this.key = sessionKey(project, issue);
        this._onActivate = onActivate;
        this._showProject = showProject;
        this._note = null;

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

        this._elapsed = new St.Label({text: elapsedText ?? '', y_align: Clutter.ActorAlign.CENTER, visible: elapsedText !== null});
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
     * @param {{project?, issue?, showProject?: boolean, elapsedText?: string|null, note?: string|null}} params
     * The secondary line shows the project path (when `showProject`) and/or a note such as "Sending…".
     */
    update({project, issue, showProject, elapsedText, note}) {
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
        const parts = [this._showProject ? this.project.path_with_namespace : null, this._note].filter(Boolean);
        this._subtitle.set_text(parts.join(' · '));
        this._subtitle.visible = parts.length > 0;
        if (elapsedText !== undefined) {
            this._elapsed.set_text(elapsedText ?? '');
            this._elapsed.visible = elapsedText !== null;
        }
    }

    activate(event) {
        if (this._onActivate) {
            // Active row: toggle without closing the menu.
            this._onActivate(event);
            return;
        }
        super.activate(event);
        this.emit('selected');
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
                if (children[position] !== row) {
                    this.section.box.set_child_at_index(row, position);
                }
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
        return this.section.box.get_children().find(child => child instanceof IssueRow) ?? null;
    }

    clear() {
        for (const row of this.rows.values())
            row.destroy();
        this.rows.clear();
    }
}

export class ActiveSection extends PopupMenu.PopupMenuSection {
    /**
     * @param {{gettext, onToggle, onSubmit, onOpen, onDiscard}} params
     */
    constructor({gettext, onToggle, onSubmit, onOpen, onDiscard}) {
        super();
        this._ = gettext;
        this._callbacks = {onToggle, onSubmit, onOpen, onDiscard};
        this._row = null;
        this._separator = new PopupMenu.PopupSeparatorMenuItem();
        this.addMenuItem(this._separator);
        this.actor.visible = false;
    }

    get row() {
        return this._row;
    }

    update(active, {showProject}) {
        if (!active) {
            this._row?.destroy();
            this._row = null;
            this.actor.visible = false;
            return;
        }
        const _ = this._;
        if (!this._row || this._row.key !== active.key) {
            this._row?.destroy();
            this._row = new IssueRow({
                project: active.project,
                issue: active.issue,
                showProject,
                elapsedText: formatClock(active.elapsedSeconds),
                onActivate: () => this._callbacks.onToggle(),
            });
            this._row.accessible_name = `#${active.issue.iid} ${active.issue.title}`;
            this._row.connect('open-in-browser', () => this._callbacks.onOpen(this._row.issue));
            this._toggleButton = this._row.addButton('media-playback-pause-symbolic', _('Pause'), () => this._callbacks.onToggle());
            this._submitButton = this._row.addButton('document-send-symbolic', _('Submit time…'), () => this._callbacks.onSubmit(this._row.key));
            this._openButton = this._row.addButton('web-browser-symbolic', _('Open in browser'), () => this._callbacks.onOpen(this._row.issue));
            this._discardButton = this._row.addButton('user-trash-symbolic', _('Discard'), () => this._callbacks.onDiscard(this._row.key));
            this.addMenuItem(this._row, 0);
        }
        this._row.update({
            project: active.project,
            issue: active.issue,
            showProject,
            elapsedText: formatClock(active.elapsedSeconds),
            note: active.sending ? _('Sending…') : null,
        });
        const icon = active.running ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._toggleButton.child.icon_name = icon;
        this._toggleButton.accessible_name = active.running ? _('Pause') : _('Resume');
        for (const button of [this._toggleButton, this._submitButton, this._discardButton]) {
            button.reactive = !active.sending;
            button.can_focus = !active.sending;
            if (active.sending)
                button.add_style_pseudo_class('insensitive');
            else
                button.remove_style_pseudo_class('insensitive');
        }
        this.actor.visible = true;
    }

    tick(active) {
        if (this._row && active && this._row.key === active.key)
            this._row.update({elapsedText: formatClock(active.elapsedSeconds)});
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
                row.connect('selected', () => this._callbacks.onSwitch(row.key));
                row.connect('open-in-browser', () => this._callbacks.onOpen(row.issue));
                row._submitButton = row.addButton('document-send-symbolic', _('Submit time…'), () => this._callbacks.onSubmit(row.key));
                return row;
            },
            update: (row, session) => {
                row.update({
                    project: session.project,
                    issue: session.issue,
                    showProject,
                    elapsedText: formatShort(session.elapsedSeconds),
                    note: session.sending ? _('Sending…') : null,
                });
                row.setSensitive(!session.sending);
                row._submitButton.reactive = !session.sending;
                row._submitButton.can_focus = !session.sending;
            },
        });
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
     * @param {{showProject: boolean, status: string|null, needsProjects: boolean, visible: boolean}} options
     */
    update(items, {showProject, status, needsProjects, visible}) {
        this._rows.sync(visible ? items : [], {
            create: item => {
                const row = new IssueRow({project: item.project, issue: item.issue, showProject});
                row.connect('selected', () => this._callbacks.onStart(row.project, row.issue));
                row.connect('open-in-browser', () => this._callbacks.onOpen(row.issue));
                return row;
            },
            update: (row, item) => row.update({project: item.project, issue: item.issue, showProject}),
        });
        this._chooseRow.visible = visible && needsProjects;
        this._status.visible = visible && Boolean(status);
        if (status)
            this._status.label.set_text(status);
        this._heading.visible = visible && (items.length > 0 || Boolean(status) || needsProjects);
        this.actor.visible = visible && (items.length > 0 || Boolean(status) || needsProjects);
    }

    get firstRow() {
        return this._rows.first();
    }
}

export class ResultsSection extends PopupMenu.PopupMenuSection {
    constructor({gettext, onStart, onOpen}) {
        super();
        this._ = gettext;
        this._callbacks = {onStart, onOpen};
        this._rows = new KeyedRows(this, 0);
        this._status = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        this._status.label.add_style_class_name('timelogs-subtitle');
        ellipsized(this._status.label);
        this.addMenuItem(this._status);
        this.actor.visible = false;
    }

    /**
     * @param {object[]} items  with key, project, issue, badge (e.g. "paused"), elapsedText
     * @param {{showProject: boolean, status: string|null, visible: boolean}} options
     */
    update(items, {showProject, status, visible}) {
        this._rows.sync(visible ? items : [], {
            create: item => {
                const row = new IssueRow({
                    project: item.project,
                    issue: item.issue,
                    showProject,
                    elapsedText: item.elapsedText ?? null,
                });
                row.connect('selected', () => this._callbacks.onStart(row.project, row.issue));
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
        this.actor.visible = visible;
    }

    get firstRow() {
        return this._rows.first();
    }
}

export class Footer extends PopupMenu.PopupMenuSection {
    constructor({gettext, onReport, onSettings}) {
        super();
        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const report = new PopupMenu.PopupMenuItem(gettext('Monthly Report'));
        report.connect('activate', () => onReport());
        this.addMenuItem(report);
        const settings = new PopupMenu.PopupMenuItem(gettext('Settings'));
        settings.connect('activate', () => onSettings());
        this.addMenuItem(settings);
    }
}
