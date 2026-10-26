// Reminders (§2.15): idle time, long timer, lock restore and stale sessions.
// All are transient MessageTray notifications with actions; none are modal.
import GLib from 'gi://GLib';

import {localDate} from '../core/config.js';
import {formatHuman, formatShort} from '../core/format.js';
import {notifyWithActions} from './notifications.js';

const LONG_TIMER_CHECK_SECONDS = 60;
const MIN_LOCK_REMINDER_SECONDS = 60;

const now = () => Math.floor(Date.now() / 1000);

export class Reminders {
    /**
     * @param {{store, config, actions, gettext, ngettext, openMenu: () => void, idleMonitor?: object}} params
     * `idleMonitor` defaults to the Shell's core Meta.IdleMonitor.
     */
    constructor({store, config, actions, gettext, ngettext, openMenu, idleMonitor = null}) {
        this._store = store;
        this._config = config;
        this._actions = actions;
        this._ = gettext;
        this._ngettext = ngettext ?? ((singular, plural, n) => n === 1 ? singular : plural);
        this._openMenu = openMenu;
        this._idleMonitor = idleMonitor ?? this._coreIdleMonitor();
        this._idleWatchId = 0;
        this._activeWatchId = 0;
        this._idleThresholdMs = 0;
        this._idleStart = null;
        this._idleKey = null;
        this._longTimerId = 0;
        this._longNotified = new Set();
        this._destroyed = false;
        this._storeChangedId = this._store.connect('changed', () => this.settingsChanged());
        this.settingsChanged();
    }

    _coreIdleMonitor() {
        try {
            return global.backend.get_core_idle_monitor();
        } catch (e) {
            console.debug(`Timelogs: idle monitor unavailable: ${e.message}`);
            return null;
        }
    }

    /** Re-arms watches after a store change or when idle/long-timer settings change. */
    settingsChanged() {
        if (this._destroyed)
            return;
        this._updateIdleWatch();
        this._updateLongTimer();
    }

    // ---- idle time ---------------------------------------------------------

    _updateIdleWatch() {
        const thresholdMs = this._config.idleMinutes * 60 * 1000;
        const wanted = this._idleMonitor && thresholdMs > 0 && this._store.hasRunning();
        if (wanted && this._idleWatchId && thresholdMs === this._idleThresholdMs)
            return;
        this._removeIdleWatch();
        if (!wanted)
            return;
        this._idleThresholdMs = thresholdMs;
        this._idleWatchId = this._idleMonitor.add_idle_watch(thresholdMs, () => this._onIdle());
    }

    _removeIdleWatch() {
        if (this._idleWatchId) {
            this._idleMonitor.remove_watch(this._idleWatchId);
            this._idleWatchId = 0;
        }
        if (this._activeWatchId) {
            this._idleMonitor.remove_watch(this._activeWatchId);
            this._activeWatchId = 0;
        }
    }

    _onIdle() {
        const active = this._store.snapshot().active;
        if (!active?.running || this._activeWatchId)
            return;
        this._idleStart = now() - Math.floor(this._idleThresholdMs / 1000);
        this._idleKey = active.key;
        this._activeWatchId = this._idleMonitor.add_user_active_watch(() => this._onUserActive());
    }

    _onUserActive() {
        const ngettext = this._ngettext;
        this._activeWatchId = 0; // user-active watches fire once
        const _ = this._;
        const awaySeconds = now() - (this._idleStart ?? now());
        const key = this._idleKey;
        this._idleStart = null;
        this._idleKey = null;
        const session = key ? this._store.get(key) : null;
        if (!session?.running || awaySeconds < 60)
            return;
        const minutes = Math.round(awaySeconds / 60);
        notifyWithActions(
            ngettext('You were away for %d minute', 'You were away for %d minutes', minutes).format(minutes),
            _('The timer on #%s kept running.').format(session.issue.iid),
            [
                {label: _('Remove %d min').format(minutes), callback: () => this._store.subtract(key, awaySeconds)},
                {label: _('Keep'), callback: () => {}},
            ]);
    }

    // ---- long timer --------------------------------------------------------

    _updateLongTimer() {
        for (const key of [...this._longNotified]) {
            if (!this._store.get(key))
                this._longNotified.delete(key);
        }
        const wanted = this._config.longTimerHours > 0 && this._store.hasRunning();
        if (wanted && !this._longTimerId) {
            this._longTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, LONG_TIMER_CHECK_SECONDS, () => {
                this._checkLongTimer();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!wanted && this._longTimerId) {
            GLib.source_remove(this._longTimerId);
            this._longTimerId = 0;
        }
        if (wanted)
            this._checkLongTimer();
    }

    _checkLongTimer() {
        const ngettext = this._ngettext;
        const _ = this._;
        const active = this._store.snapshot().active;
        const threshold = this._config.longTimerHours * 3600;
        if (!active?.running || threshold <= 0 || active.elapsedSeconds < threshold || this._longNotified.has(active.key))
            return;
        this._longNotified.add(active.key);
        const hours = Math.floor(active.elapsedSeconds / 3600);
        notifyWithActions(
            ngettext('Timer running for %d hour', 'Timer running for %d hours', hours).format(hours),
            `#${active.issue.iid} ${active.issue.title}`,
            [
                {label: _('Submit…'), callback: () => this._actions.submit(active.key)},
                {label: _('Pause'), callback: () => this._store.pause()},
                {label: _('Keep'), callback: () => {}},
            ]);
    }

    // ---- lock restore ------------------------------------------------------

    /** @param {{key: string, policy: string, awaySeconds: number}|null} restored result of applyLockPolicy */
    lockRestored(restored) {
        const ngettext = this._ngettext;
        const _ = this._;
        if (!restored || restored.policy !== 'pause' || restored.awaySeconds < MIN_LOCK_REMINDER_SECONDS)
            return;
        const session = this._store.get(restored.key);
        if (!session || session.running)
            return;
        const minutes = Math.round(restored.awaySeconds / 60);
        notifyWithActions(
            _('Paused while the screen was locked'),
            _('#%s · %s kept. Locked for %s.').format(session.issue.iid, formatShort(session.elapsedSeconds),
                ngettext('%d minute', '%d minutes', minutes).format(minutes)),
            [
                {label: _('Resume'), callback: () => this._store.switchTo(restored.key)},
                {label: _('Add %d min').format(minutes), callback: () => {
                    this._store.add(restored.key, restored.awaySeconds);
                    this._store.switchTo(restored.key);
                }},
            ]);
    }

    // ---- stale sessions ----------------------------------------------------

    /** Once per calendar day: paused sessions last touched before today. */
    checkStale() {
        const ngettext = this._ngettext;
        const _ = this._;
        const today = localDate(now());
        if (this._config.lastStaleCheck === today)
            return;
        this._config.lastStaleCheck = today;
        const snapshot = this._store.snapshot();
        const candidates = [...snapshot.paused, ...(snapshot.active && !snapshot.active.running ? [snapshot.active] : [])]
            .filter(session => !session.sending && localDate(session.updatedAt) < today);
        if (candidates.length === 0)
            return;
        const total = candidates.reduce((sum, session) => sum + session.elapsedSeconds, 0);
        const oldest = Math.min(...candidates.map(session => session.updatedAt));
        const yesterday = localDate(now() - 86400);
        const oldestText = localDate(oldest) === yesterday
            ? _('Oldest from yesterday.')
            : _('Oldest from %s.').format(GLib.DateTime.new_from_unix_local(oldest).format('%x'));
        notifyWithActions(
            ngettext('%d paused session, %s not submitted', '%d paused sessions, %s not submitted', candidates.length)
                .format(candidates.length, formatHuman(total)),
            oldestText,
            [{label: _('Review'), callback: () => this._openMenu()}]);
    }

    destroy() {
        this._destroyed = true;
        this._removeIdleWatch();
        if (this._longTimerId) {
            GLib.source_remove(this._longTimerId);
            this._longTimerId = 0;
        }
        if (this._storeChangedId) {
            this._store.disconnect(this._storeChangedId);
            this._storeChangedId = 0;
        }
    }
}
