// Entry point: wires core state, the panel indicator, keybindings and the
// report launcher. All logic lives in core/ and ui/.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Config} from './core/config.js';
import {GitLabClient} from './core/gitlabClient.js';
import {IssueSource} from './core/issueSource.js';
import {SessionStore} from './core/sessionStore.js';
import {Actions} from './ui/actions.js';
import {Indicator} from './ui/indicator.js';
import {configureSource, notify} from './ui/notifications.js';

const HEARTBEAT_SECONDS = 60;

export default class TimelogsExtension extends Extension {
    enable() {
        const _ = this.gettext.bind(this);
        this._settings = this.getSettings();
        this._config = new Config(this._settings);
        this._config.migrate();

        this._client = new GitLabClient({url: this._config.url, token: this._settings.get_string('gitlab-token')});
        this._store = new SessionStore({
            load: () => this._config.timerState,
            save: json => {
                this._config.timerState = json;
            },
        });
        this._store.applyLockPolicy(this._config.lockBehaviour);
        this._issues = new IssueSource({client: this._client, config: this._config});
        this._actions = new Actions({
            store: this._store,
            client: this._client,
            gettext: _,
            openPrefs: () => this.openPreferences(),
        });
        configureSource({
            title: _('Timelogs'),
            gicon: new Gio.FileIcon({file: Gio.File.new_for_path(`${this.path}/icons/timer-outline-symbolic.svg`)}),
        });

        this._indicator = new Indicator({
            store: this._store,
            issues: this._issues,
            config: this._config,
            actions: this._actions,
            gettext: _,
            iconPath: `${this.path}/icons`,
            openPrefs: () => this.openPreferences(),
            openReport: () => this._openReport(),
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._keybindings = [
            ['toggle-timer-shortcut', () => this._indicator?.toggleFromShortcut()],
            ['stop-send-shortcut', () => this._submitActive()],
            ['cancel-timer-shortcut', () => this._discardActive()],
            ['select-issue-shortcut', () => this._indicator?.openWithSearch()],
            ['monthly-report-shortcut', () => this._openReport()],
        ];
        for (const [name, callback] of this._keybindings)
            Main.wm.addKeybinding(name, this._settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL, callback);

        this._heartbeatId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, HEARTBEAT_SECONDS, () => {
            if (this._store?.hasRunning())
                this._store.heartbeat();
            return GLib.SOURCE_CONTINUE;
        });

        this._settingsIds = this._config.connectChanged(
            ['gitlab-url', 'gitlab-token', 'cached-user'], () => this._reloadCredentials());
        this._settingsIds.push(...this._config.connectChanged(
            ['tracked-projects', 'doing-labels', 'show-panel-time'], () => this._indicator?.credentialsChanged()));
        this._reloadCredentials();
    }

    _reloadCredentials() {
        const generation = (this._credentialsGeneration = (this._credentialsGeneration ?? 0) + 1);
        const url = this._config.url;
        this._config.getToken(url).then(token => {
            if (!this._client || generation !== this._credentialsGeneration)
                return;
            this._client.setCredentials({url, token});
            this._issues.invalidate();
            this._indicator?.credentialsChanged();
        }).catch(e => console.debug(`Timelogs: unable to load token: ${e.message}`));
    }

    _submitActive() {
        const active = this._store?.snapshot().active;
        if (active)
            this._actions.submit(active.key);
    }

    _discardActive() {
        const active = this._store?.snapshot().active;
        if (active)
            this._actions.discard(active.key);
    }

    _openReport() {
        try {
            Gio.Subprocess.new(
                ['gjs', '-m', `${this.path}/report/main.js`, String(this._indicator?.activeProjectId ?? '')],
                Gio.SubprocessFlags.NONE);
        } catch (e) {
            notify(this.gettext('Timelogs'), `${this.gettext('Unable to open report')}: ${e.message}`);
        }
    }

    disable() {
        this._credentialsGeneration = (this._credentialsGeneration ?? 0) + 1;
        if (this._keybindings) {
            for (const [name] of this._keybindings)
                Main.wm.removeKeybinding(name);
            this._keybindings = null;
        }
        if (this._heartbeatId) {
            GLib.source_remove(this._heartbeatId);
            this._heartbeatId = 0;
        }
        this._config?.disconnect(this._settingsIds);
        this._settingsIds = null;
        // Record the moment tracking stopped so the lock policy can restore correctly.
        this._store?.heartbeat();
        Gio.Settings.sync();
        this._indicator?.destroy();
        this._indicator = null;
        this._actions?.destroy();
        this._actions = null;
        this._client?.abort();
        this._client = null;
        this._issues = null;
        this._store = null;
        this._config = null;
        this._settings = null;
    }
}
