// Panel button: icon + elapsed label, and the single menu that hosts search,
// the active session, paused sessions, the Doing queue and the footer.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {formatShort} from '../core/format.js';
import {filterLocal, mergeResults, visibleQueue} from '../core/issueSource.js';
import {sessionKey} from '../core/sessionStore.js';
import {describeError} from './actions.js';
import {ActiveSection, Footer, PausedSection, QueueSection, ResultsSection, SearchSection} from './menuSections.js';

const SEARCH_DEBOUNCE_MS = 300;

export const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    /**
     * @param {{store, issues, config, actions, gettext, iconPath, openPrefs, openReport}} params
     */
    _init({store, issues, config, actions, gettext, iconPath, openPrefs, openReport}) {
        super._init(0.0, 'Timelogs');
        this._store = store;
        this._issues = issues;
        this._config = config;
        this._actions = actions;
        this._ = gettext;
        this._iconPath = iconPath;
        this._openPrefs = openPrefs;
        this._openReport = openReport;
        this._destroyed = false;
        this._tickId = 0;
        this._searchTimeoutId = 0;
        this._focusIdleId = 0;
        this._queueStatus = null;
        this._authFailed = false;
        this._searchText = '';
        this._remoteResults = [];
        this._searchStatus = null;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        box.add_child(this._icon);
        this._panelLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER, visible: false});
        box.add_child(this._panelLabel);
        this.add_child(box);

        this._buildMenu();
        this._storeChangedId = this._store.connect('changed', () => this._render());
        this.menu.connect('open-state-changed', (_menu, open) => this._onOpenStateChanged(open));
        this._render();
    }

    _buildMenu() {
        const _ = this._;
        this._search = new SearchSection({gettext: _});
        this._search.connect('text-changed', (_section, text) => this._onSearchChanged(text));
        this._search.connect('activate-first', () => this._activateFirstResult());
        this._search.connect('navigate-down', () => this._focusFirstRow());
        this.menu.addMenuItem(this._search);

        this._setupRow = new PopupMenu.PopupMenuItem(_('Set up GitLab…'));
        this._setupRow.connect('activate', () => this._openPrefs());
        this.menu.addMenuItem(this._setupRow);

        this._active = new ActiveSection({
            gettext: _,
            onToggle: () => this._store.toggle(),
            onSubmit: key => this._closeThen(() => this._actions.submit(key)),
            onOpen: issue => this._closeThen(() => this._actions.openIssue(issue)),
            onDiscard: key => this._closeThen(() => this._actions.discard(key)),
        });
        this.menu.addMenuItem(this._active);

        // Scrollable middle: paused sessions, Doing queue and search results.
        this._scrollSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._scrollSection);
        this._scrollView = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._scrollInner = new PopupMenu.PopupMenuSection();
        this._scrollSection.addMenuItem(this._scrollInner);
        this._scrollSection.box.remove_child(this._scrollInner.actor);
        this._scrollView.set_child(this._scrollInner.actor);
        this._scrollSection.box.add_child(this._scrollView);

        this._paused = new PausedSection({
            gettext: _,
            onSwitch: key => this._store.switchTo(key),
            onSubmit: key => this._closeThen(() => this._actions.submit(key)),
            onOpen: issue => this._closeThen(() => this._actions.openIssue(issue)),
        });
        this._scrollInner.addMenuItem(this._paused);
        this._queue = new QueueSection({
            gettext: _,
            onStart: (project, issue) => this._store.start(project, issue),
            onOpen: issue => this._closeThen(() => this._actions.openIssue(issue)),
            onChooseProjects: () => this._openPrefs(),
        });
        this._scrollInner.addMenuItem(this._queue);
        this._results = new ResultsSection({
            gettext: _,
            onStart: (project, issue) => this._store.start(project, issue),
            onOpen: issue => this._closeThen(() => this._actions.openIssue(issue)),
        });
        this._scrollInner.addMenuItem(this._results);

        this._footer = new Footer({
            gettext: _,
            onReport: () => this._openReport(),
            onSettings: () => this._openPrefs(),
        });
        this.menu.addMenuItem(this._footer);

        // Escape with search text clears it instead of closing the menu. Connected
        // before the menu manager's handler so it runs first.
        this.menu.actor.connect('captured-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.KEY_PRESS || event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            if (this._search.text) {
                this._search.clear();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    // ---- public API used by keybindings -----------------------------------

    openWithSearch() {
        if (!this.menu.isOpen)
            this.menu.open(true);
        this._focusSearch();
    }

    /** Active → pause/resume; paused only → resume most recent; nothing → open menu. */
    toggleFromShortcut() {
        if (!this._store.toggle())
            this.openWithSearch();
    }

    credentialsChanged() {
        this._authFailed = false;
        this._queueStatus = null;
        this._remoteResults = [];
        this._render();
        this._refreshQueue();
    }

    get activeProjectId() {
        return this._store.snapshot().active?.project.id ?? null;
    }

    // ---- menu lifecycle ----------------------------------------------------

    _onOpenStateChanged(open) {
        if (open) {
            this._updateScrollHeight();
            this._render();
            this._refreshQueue();
            this._focusSearch();
        } else {
            this._search.clear();
            this._issues.cancelSearch();
            this._cancelSearchTimeout();
        }
    }

    _focusSearch() {
        if (this._focusIdleId)
            GLib.source_remove(this._focusIdleId);
        this._focusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusIdleId = 0;
            if (this.menu.isOpen && !this._destroyed)
                this._search.focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _closeThen(callback) {
        this.menu.close();
        callback();
    }

    _updateScrollHeight() {
        const monitor = Main.layoutManager.findMonitorForActor(this) ?? Main.layoutManager.primaryMonitor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const maxHeight = Math.floor((monitor.height * 0.6) / scale);
        this._scrollView.style = `max-height: ${maxHeight}px;`;
    }

    _focusFirstRow() {
        const row = this._search.text
            ? this._results.firstRow
            : this._active.row ?? this._paused.firstRow ?? this._queue.firstRow;
        if (row)
            row.grab_key_focus();
        else
            this.menu.box.navigate_focus(this._search, St.DirectionType.DOWN, false);
    }

    _activateFirstResult() {
        if (!this._search.text)
            return;
        const row = this._results.firstRow;
        if (row)
            row.activate(Clutter.get_current_event());
    }

    // ---- queue -------------------------------------------------------------

    _refreshQueue() {
        if (!this._issues.isConfigured || this._issues.trackedProjects.length === 0)
            return;
        this._issues.refreshQueue().then(items => {
            if (this._destroyed || items === null)
                return;
            this._queueStatus = null;
            this._authFailed = false;
            this._render();
        }).catch(error => {
            if (this._destroyed || error?.kind === 'cancelled')
                return;
            this._authFailed = error?.kind === 'auth';
            const hasCache = this._issues.getCachedQueue().length > 0;
            this._queueStatus = hasCache
                ? this._('Offline — showing last known queue')
                : describeError(error, this._);
            this._render();
        });
    }

    // ---- search ------------------------------------------------------------

    _onSearchChanged(text) {
        this._searchText = text;
        this._cancelSearchTimeout();
        if (!text) {
            this._remoteResults = [];
            this._searchStatus = null;
            this._issues.cancelSearch();
            this._render();
            return;
        }
        this._searchStatus = this._issues.isConfigured ? this._('Searching…') : null;
        this._render();
        this._searchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DEBOUNCE_MS, () => {
            this._searchTimeoutId = 0;
            this._runSearch(text);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelSearchTimeout() {
        if (this._searchTimeoutId) {
            GLib.source_remove(this._searchTimeoutId);
            this._searchTimeoutId = 0;
        }
    }

    _runSearch(text) {
        if (!this._issues.isConfigured) {
            this._searchStatus = null;
            this._render();
            return;
        }
        this._issues.search(text).then(items => {
            if (this._destroyed || items === null || !this.menu.isOpen || this._searchText !== text)
                return;
            this._remoteResults = items;
            this._searchStatus = null;
            this._render();
        }).catch(error => {
            if (this._destroyed || error?.kind === 'cancelled' || this._searchText !== text)
                return;
            this._remoteResults = [];
            this._searchStatus = describeError(error, this._);
            this._render();
        });
    }

    _localResults(snapshot, text) {
        const _ = this._;
        const local = [];
        if (snapshot.active) {
            local.push({...snapshot.active, badge: snapshot.active.running ? _('active') : _('paused'),
                elapsedText: formatShort(snapshot.active.elapsedSeconds)});
        }
        for (const session of snapshot.paused)
            local.push({...session, badge: _('paused'), elapsedText: formatShort(session.elapsedSeconds)});
        for (const item of visibleQueue(this._issues.getCachedQueue(), this._store, Infinity))
            local.push({...item, key: sessionKey(item.project, item.issue), badge: _('doing')});
        return filterLocal(local, text);
    }

    // ---- rendering ---------------------------------------------------------

    _render() {
        if (this._destroyed)
            return;
        const _ = this._;
        const snapshot = this._store.snapshot();
        const configured = this._issues.isConfigured && !this._authFailed;
        const trackedProjects = this._issues.trackedProjects;
        const showProject = trackedProjects.length > 1;
        const searching = Boolean(this._searchText);

        this._setupRow.visible = !configured && !searching;
        this._active.update(searching ? null : snapshot.active, {showProject});
        this._paused.update(searching ? [] : snapshot.paused, {showProject});

        const queueItems = visibleQueue(this._issues.getCachedQueue(), this._store)
            .map(item => ({...item, key: sessionKey(item.project, item.issue)}));
        this._queue.update(queueItems, {
            showProject,
            status: configured ? this._queueStatus : null,
            needsProjects: configured && trackedProjects.length === 0,
            visible: !searching && configured,
        });

        if (searching) {
            const merged = mergeResults(this._localResults(snapshot, this._searchText),
                this._remoteResults.map(item => ({...item, key: sessionKey(item.project, item.issue)})));
            let status = this._searchStatus;
            if (!status && merged.length === 0)
                status = configured ? _('No results') : _('Set up GitLab to search issues');
            this._results.update(merged, {showProject, status, visible: true});
        } else {
            this._results.update([], {showProject, status: null, visible: false});
        }

        this._updatePanel(snapshot);
        this._updateTick();
    }

    _updatePanel(snapshot) {
        const active = snapshot.active;
        let icon = 'timer-outline-symbolic.svg';
        if (active)
            icon = active.running ? 'timer-play-outline-symbolic.svg' : 'timer-pause-outline-symbolic.svg';
        if (this._iconName !== icon) {
            this._iconName = icon;
            this._icon.gicon = new Gio.FileIcon({file: Gio.File.new_for_path(`${this._iconPath}/${icon}`)});
        }
        const showTime = Boolean(active) && this._config.showPanelTime;
        this._panelLabel.visible = showTime;
        if (showTime)
            this._panelLabel.set_text(formatShort(active.elapsedSeconds));
    }

    _updateTick() {
        const needsTick = this._store.hasRunning();
        if (needsTick && !this._tickId) {
            this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                const snapshot = this._store.snapshot();
                this._updatePanel(snapshot);
                if (this.menu.isOpen)
                    this._active.tick(snapshot.active);
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!needsTick && this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    destroy() {
        this._destroyed = true;
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        if (this._focusIdleId) {
            GLib.source_remove(this._focusIdleId);
            this._focusIdleId = 0;
        }
        this._cancelSearchTimeout();
        if (this._storeChangedId) {
            this._store.disconnect(this._storeChangedId);
            this._storeChangedId = 0;
        }
        super.destroy();
    }
});
