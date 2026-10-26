// Panel button: icon + state badge + elapsed label, and the single menu that
// hosts the banner, search, the active block, paused sessions, the Doing queue
// and the footer (§2.12, §2.13).
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
import {ActiveSection, BannerSection, Footer, PausedSection, QueueSection, ResultsSection, SearchSection} from './menuSections.js';

const SEARCH_DEBOUNCE_MS = 300;

function hostOf(url) {
    try {
        return GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host() || url;
    } catch (e) {
        return url;
    }
}

export const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    /**
     * @param {{store, issues, config, actions, gettext, ngettext, iconPath, openPrefs, openReport}} params
     */
    _init({store, issues, config, actions, gettext, ngettext = null, iconPath, openPrefs, openReport}) {
        super._init(0.0, 'Timelogs');
        this._store = store;
        this._issues = issues;
        this._config = config;
        this._actions = actions;
        this._ = gettext;
        this._ngettext = ngettext ?? ((singular, plural, n) => n === 1 ? singular : plural);
        this._iconPath = iconPath;
        this._openPrefs = openPrefs;
        this._openReport = openReport;
        this._destroyed = false;
        this._tickId = 0;
        this._searchTimeoutId = 0;
        this._focusIdleId = 0;
        this._queueStatus = null;
        this._authFailed = false;
        this._offline = false;
        this._searchText = '';
        this._includeClosed = false;
        this._remoteResults = [];
        this._searchStatus = null;
        this._searchPending = false;
        this._accessibleKey = null;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        const iconBin = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        iconBin.add_child(this._icon);
        this._warningDot = new St.Widget({style_class: 'timelogs-warning-dot', visible: false,
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START, x_expand: true, y_expand: true});
        iconBin.add_child(this._warningDot);
        box.add_child(iconBin);
        this._panelLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER, visible: false, style_class: 'timelogs-numeric'});
        box.add_child(this._panelLabel);
        this.add_child(box);

        this._buildMenu();
        this._storeChangedId = this._store.connect('changed', () => this._render());
        this.menu.connect('open-state-changed', (_menu, open) => this._onOpenStateChanged(open));
        this._render();
    }

    _buildMenu() {
        const _ = this._;
        this._banner = new BannerSection();
        this.menu.addMenuItem(this._banner);

        this._setupRow = new PopupMenu.PopupMenuItem(_('Set up GitLab…'));
        this._setupRow.connect('activate', () => this._openPrefs());
        this.menu.addMenuItem(this._setupRow);

        this._search = new SearchSection({gettext: _});
        this._search.connect('text-changed', (_section, text) => this._onSearchChanged(text));
        this._search.connect('activate-first', () => this._activateFirstResult());
        this._search.connect('navigate-down', () => this._focusFirstRow());
        this.menu.addMenuItem(this._search);

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
            onIncludeClosed: () => this._includeClosedIssues(),
            onSearchOnGitLab: () => this._searchOnGitLab(),
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

    // ---- public API used by keybindings and reminders ----------------------

    openWithSearch() {
        if (!this.menu.isOpen)
            this.menu.open(true);
        this._focusSearch();
    }

    /** Opens the menu without stealing focus into the search (stale-session "Review"). */
    openMenu() {
        if (!this.menu.isOpen)
            this.menu.open(true);
    }

    /** Open-menu shortcut: opens the menu with the search focused, or closes it when already open. */
    toggleMenuFromShortcut() {
        if (this.menu.isOpen)
            this.menu.close();
        else
            this.openWithSearch();
    }

    /** Active → pause/resume; paused only → resume most recent; nothing → open menu. */
    toggleFromShortcut() {
        if (!this._store.toggle())
            this.openWithSearch();
    }

    credentialsChanged() {
        this._authFailed = false;
        this._offline = false;
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
            this._offline = false;
            this._render();
        }).catch(error => {
            if (this._destroyed || error?.kind === 'cancelled')
                return;
            this._authFailed = error?.kind === 'auth';
            this._offline = error?.kind === 'network';
            const hasCache = this._issues.getCachedQueue().length > 0;
            this._queueStatus = hasCache ? null : describeError(error, this._);
            this._render();
        });
    }

    // ---- search ------------------------------------------------------------

    _onSearchChanged(text) {
        this._searchText = text;
        this._includeClosed = false;
        this._remoteResults = []; // never show another query's remote rows
        this._cancelSearchTimeout();
        if (!text) {
            this._searchStatus = null;
            this._searchPending = false;
            this._issues.cancelSearch();
            this._render();
            return;
        }
        this._searchPending = this._canSearchRemote();
        this._searchStatus = this._searchPending ? this._('Searching…') : null;
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

    _canSearchRemote() {
        return this._issues.isConfigured && !this._authFailed && !this._offline && this._issues.trackedProjects.length > 0;
    }

    _runSearch(text, {includeClosed = false} = {}) {
        if (!this._canSearchRemote()) {
            this._searchStatus = null;
            this._searchPending = false;
            this._render();
            return;
        }
        this._searchPending = true;
        this._issues.search(text, {includeClosed}).then(items => {
            if (this._destroyed || items === null || !this.menu.isOpen || this._searchText !== text)
                return;
            this._remoteResults = items;
            this._searchStatus = null;
            this._searchPending = false;
            this._render();
        }).catch(error => {
            if (this._destroyed || error?.kind === 'cancelled' || this._searchText !== text)
                return;
            this._remoteResults = [];
            this._searchPending = false;
            if (error?.kind === 'auth')
                this._authFailed = true;
            if (error?.kind === 'network')
                this._offline = true;
            this._searchStatus = describeError(error, this._);
            this._render();
        });
    }

    _includeClosedIssues() {
        if (!this._searchText)
            return;
        this._includeClosed = true;
        this._cancelSearchTimeout();
        this._searchStatus = this._('Searching…');
        this._render();
        this._runSearch(this._searchText, {includeClosed: true});
    }

    _searchOnGitLab() {
        const query = encodeURIComponent(this._searchText);
        const projects = this._issues.trackedProjects;
        const url = projects.length === 1 && projects[0].web_url
            ? `${projects[0].web_url}/-/issues/?search=${query}`
            : `${this._config.url}/search?scope=issues&search=${query}`;
        this._closeThen(() => this._actions.openUrl(url));
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

        this._banner.update(this._bannerState());
        // Missing URL/token → the setup row replaces the banner; an auth error shows the banner only.
        this._setupRow.visible = !this._issues.isConfigured && !searching;
        this._search.setOffline(this._offline && this._issues.isConfigured);
        this._active.update(searching ? null : snapshot.active, {showProject});
        this._paused.update(searching ? [] : snapshot.paused, {showProject});

        const cachedQueue = this._issues.getCachedQueue();
        const queueItems = visibleQueue(cachedQueue, this._store)
            .map(item => ({...item, key: sessionKey(item.project, item.issue)}));
        const stale = this._offline && cachedQueue.length > 0 ? this._issues.queueCachedAt : null;
        this._queue.update(queueItems, {
            showProject,
            status: configured ? this._queueStatus : null,
            needsProjects: configured && trackedProjects.length === 0,
            visible: !searching && configured,
            idle: !snapshot.active,
            staleSince: stale ? GLib.DateTime.new_from_unix_local(stale).format('%H:%M') : null,
        });

        if (searching) {
            const merged = mergeResults(this._localResults(snapshot, this._searchText),
                this._remoteResults.map(item => ({...item, key: sessionKey(item.project, item.issue)})));
            let status = this._searchStatus;
            let empty = null;
            if (!status && merged.length === 0) {
                if (!this._issues.isConfigured) {
                    status = _('Set up GitLab to search issues');
                } else {
                    empty = {
                        query: this._searchText,
                        projects: this._canSearchRemote() ? trackedProjects.map(project => project.path_with_namespace) : [],
                        closedIncluded: this._includeClosed,
                        canSearchRemote: this._canSearchRemote(),
                    };
                }
            }
            this._results.update(merged, {showProject, status, visible: true, empty});
        } else {
            this._results.update([], {showProject, status: null, visible: false});
        }

        this._footer.update({todaySeconds: this._config.submittedTodaySeconds()});
        this._updatePanel(snapshot);
        this._updateTick();
    }

    _bannerState() {
        const _ = this._;
        if (!this._issues.isConfigured)
            return null; // the "Set up GitLab…" row replaces the banner
        if (this._authFailed)
            return {text: _('GitLab rejected the token'), action: _('Settings'), onAction: () => this._closeThen(() => this._openPrefs())};
        if (this._offline)
            return {text: _("Can't reach %s").format(hostOf(this._config.url)), action: _('Retry'), onAction: () => this.credentialsChanged()};
        return null;
    }

    _updatePanel(snapshot) {
        const _ = this._;
        const active = snapshot.active;
        const configured = this._issues.isConfigured;
        const submitting = this._store.isBusy();
        const sendingSession = submitting ? [active, ...snapshot.paused].find(session => session?.sending) : null;

        let gicon;
        let iconKey;
        if (submitting) {
            iconKey = 'submitting';
            gicon = new Gio.ThemedIcon({name: 'document-send-symbolic'});
        } else {
            iconKey = !active ? 'timer-outline-symbolic.svg'
                : active.running ? 'timer-play-outline-symbolic.svg' : 'timer-pause-outline-symbolic.svg';
            gicon = new Gio.FileIcon({file: Gio.File.new_for_path(`${this._iconPath}/${iconKey}`)});
        }
        if (this._iconKey !== iconKey) {
            this._iconKey = iconKey;
            this._icon.gicon = gicon;
        }
        this._warningDot.visible = !configured || this._authFailed || this._offline;

        const content = this._config.panelContent;
        const showLabel = Boolean(active) && content !== 'icon';
        this._panelLabel.visible = showLabel;
        if (showLabel) {
            const time = formatShort(active.elapsedSeconds);
            this._panelLabel.set_text(content === 'issue-and-time' ? `#${active.issue.iid} · ${time}` : time);
            if (active.running)
                this._panelLabel.remove_style_class_name('timelogs-dim');
            else
                this._panelLabel.add_style_class_name('timelogs-dim');
        }

        // Accessible name: state + issue + whole minutes, so ticks don't re-announce.
        const minutes = active ? Math.floor(active.elapsedSeconds / 60) : 0;
        const suffix = this._authFailed ? `, ${_('GitLab rejected the token')}`
            : this._offline ? `, ${_('GitLab not reachable')}` : '';
        const key = `${iconKey}:${active?.key ?? ''}:${minutes}:${configured}:${suffix}:${sendingSession?.key ?? ''}`;
        if (key !== this._accessibleKey) {
            this._accessibleKey = key;
            let name;
            if (sendingSession)
                name = _('Submitting time for #%s').format(sendingSession.issue.iid);
            else if (!configured)
                name = _('Time tracking, not set up');
            else if (!active)
                name = _('Time tracking, idle');
            else if (active.running)
                name = _('Tracking #%s, %s').format(active.issue.iid, this._durationWords(active.elapsedSeconds));
            else
                name = _('Paused #%s at %s').format(active.issue.iid, this._durationWords(active.elapsedSeconds));
            this.accessible_name = name + suffix;
        }
    }

    _durationWords(seconds) {
        const ngettext = this._ngettext;
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const parts = [];
        if (hours > 0)
            parts.push(ngettext('%d hour', '%d hours', hours).format(hours));
        if (minutes > 0 || hours === 0)
            parts.push(ngettext('%d minute', '%d minutes', minutes).format(minutes));
        return parts.join(' ');
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
