// User-facing actions that combine the store, the client, dialogs and
// notifications: submit, discard with undo, open in browser.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {formatHuman, formatShort, parseGitLabDuration, toEditableDuration} from '../core/format.js';
import {SubmitDialog} from './submitDialog.js';
import {notify, notifyWithActions} from './notifications.js';

const UNDO_SECONDS = 30;

export function describeError(error, _) {
    switch (error?.kind) {
    case 'auth':
        return _('Invalid token or insufficient permissions');
    case 'network':
        return _('Server not reachable');
    case 'config':
        return _('GitLab is not configured');
    case 'not-found':
        return _('Not found');
    default:
        return error?.message ?? String(error);
    }
}

export class Actions {
    /**
     * @param {{store, client, config, gettext, openPrefs}} params
     */
    constructor({store, client, config, gettext, openPrefs}) {
        this._store = store;
        this._client = client;
        this._config = config;
        this._ = gettext;
        this._openPrefs = openPrefs;
        this._dialog = null;
        this._undo = null;
        this._undoTimeoutId = 0;
        this._destroyed = false;
    }

    /** Opens the submit dialog for a session; the timer keeps running meanwhile. */
    submit(key, {duration = null, comment = ''} = {}) {
        const session = this._store.get(key);
        if (!session || session.sending || this._dialog)
            return;
        const _ = this._;
        this._dialog = new SubmitDialog({
            gettext: _,
            project: session.project,
            issue: session.issue,
            duration: duration ?? toEditableDuration(session.elapsedSeconds),
            comment,
            roundingMinutes: this._config.roundingMinutes,
            onSubmit: (editedDuration, editedComment) => this._send(key, editedDuration, editedComment),
        });
        this._dialog.connect('closed', () => {
            this._dialog = null;
        });
        if (!this._dialog.open()) {
            this._dialog.destroy();
            this._dialog = null;
        }
    }

    _send(key, duration, comment) {
        const _ = this._;
        const submission = this._store.beginSubmit(key);
        if (!submission)
            return;
        const {project, issue} = submission;
        const seconds = parseGitLabDuration(duration) ?? submission.elapsedSeconds;
        this._client.post(`/projects/${project.id}/issues/${issue.iid}/add_spent_time`, {
            duration,
            summary: comment || undefined,
        }).then(() => {
            if (this._destroyed)
                return;
            // Log first: completeSubmit emits `changed`, which re-renders the "Today" total.
            this._config.addSubmit({key, seconds, at: Math.floor(Date.now() / 1000)});
            this._store.completeSubmit(key, true);
            notify(_('Submitted'), _('Submitted %s to #%s').format(formatHuman(seconds), issue.iid));
        }).catch(error => {
            if (this._destroyed)
                return;
            this._store.completeSubmit(key, false);
            const actions = [{label: _('Retry'), callback: () => this.submit(key, {duration, comment})}];
            if (error?.kind === 'auth' || error?.kind === 'config')
                actions.push({label: _('Open Settings'), callback: () => this._openPrefs()});
            notifyWithActions(_('Time not submitted'),
                _("Couldn't submit time to #%s: %s").format(issue.iid, describeError(error, _)), actions);
        });
    }

    /** Removes the session immediately and offers Undo for 30 seconds. */
    discard(key) {
        const _ = this._;
        const discarded = this._store.discard(key);
        if (!discarded)
            return;
        this._clearUndo();
        this._undo = discarded;
        this._undoTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, UNDO_SECONDS, () => {
            this._undoTimeoutId = 0;
            this._undo = null;
            return GLib.SOURCE_REMOVE;
        });
        const elapsed = discarded.accumulatedSeconds + (discarded.runningSince !== null
            ? Math.max(0, Math.floor(Date.now() / 1000) - discarded.runningSince) : 0);
        notifyWithActions(_('Discarded'),
            _('Discarded %s on #%s').format(formatShort(elapsed), discarded.issue.iid),
            [{label: _('Undo'), callback: () => this.undoDiscard()}]);
    }

    undoDiscard() {
        if (!this._undo)
            return false;
        const restored = this._store.restoreDiscarded(this._undo);
        this._clearUndo();
        return restored;
    }

    _clearUndo() {
        if (this._undoTimeoutId) {
            GLib.source_remove(this._undoTimeoutId);
            this._undoTimeoutId = 0;
        }
        this._undo = null;
    }

    openIssue(issue) {
        if (!issue?.web_url) {
            notify(this._('Timelogs'), this._('Issue URL not available'));
            return;
        }
        this.openUrl(issue.web_url);
    }

    openUrl(url) {
        try {
            Gio.AppInfo.launch_default_for_uri(url, null);
        } catch (e) {
            notify(this._('Timelogs'), `${this._('Unable to open browser')}: ${e.message}`);
        }
    }

    destroy() {
        this._destroyed = true;
        this._clearUndo();
        if (this._dialog) {
            this._dialog.close();
            this._dialog = null;
        }
    }
}
