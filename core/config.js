// Typed GSettings access, token storage (libsecret with GSettings fallback) and
// idempotent migrations. Shared by the Shell process, prefs and the report.
import Gio from 'gi://Gio';
import {policyFromLegacy, LOCK_POLICIES} from './lockPolicy.js';
import {serializeProject} from './gitlabClient.js';

export const SCHEMA_ID = 'org.gnome.shell.extensions.timelogs-extension';
export const SETTINGS_VERSION = 4;
const SECRET_SCHEMA_NAME = 'org.gnome.shell.extensions.timelogs-extension.Token';

export const PANEL_CONTENTS = ['time', 'issue-and-time', 'icon'];
export const IDLE_MINUTE_OPTIONS = [0, 5, 10, 15, 30];
export const LONG_TIMER_HOUR_OPTIONS = [0, 4, 6, 8, 10];
export const ROUNDING_MINUTE_OPTIONS = [0, 5, 6, 10, 15, 30];
const SUBMIT_LOG_DAYS = 31;

/** Local calendar date "YYYY-MM-DD" of an epoch-seconds timestamp. */
export function localDate(epochSeconds) {
    const date = new Date(epochSeconds * 1000);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseJson(text, fallback) {
    try {
        const value = JSON.parse(text);
        return value ?? fallback;
    } catch (e) {
        return fallback;
    }
}

function normalizeUrlKey(url) {
    return String(url ?? '').trim().replace(/\/+$/, '');
}

let secretModulePromise = null;
function loadSecret() {
    if (!secretModulePromise) {
        secretModulePromise = import('gi://Secret?version=1')
            .then(module => module.default)
            .catch(e => {
                console.debug(`Timelogs: libsecret unavailable: ${e.message}`);
                return null;
            });
    }
    return secretModulePromise;
}

/** Loads the extension schema from a directory for standalone processes. */
export function settingsFromDirectory(schemaDir) {
    const source = Gio.SettingsSchemaSource.new_from_directory(schemaDir,
        Gio.SettingsSchemaSource.get_default(), false);
    const schema = source.lookup(SCHEMA_ID, true);
    if (!schema)
        throw new Error(`Unable to load GSettings schema: ${SCHEMA_ID}`);
    return new Gio.Settings({settings_schema: schema});
}

export class Config {
    /** @param {Gio.Settings|object} settings */
    constructor(settings) {
        this._settings = settings;
        this._secretSchema = null;
        this.tokenStorageWarning = null;
    }

    get settings() {
        return this._settings;
    }

    // ---- plain keys --------------------------------------------------------

    get url() {
        return normalizeUrlKey(this._settings.get_string('gitlab-url'));
    }

    set url(value) {
        this._settings.set_string('gitlab-url', normalizeUrlKey(value));
    }

    get trackedProjects() {
        const list = parseJson(this._settings.get_string('tracked-projects'), []);
        return (Array.isArray(list) ? list : []).map(serializeProject).filter(project =>
            project && project.path_with_namespace);
    }

    set trackedProjects(list) {
        const projects = (list ?? []).map(serializeProject).filter(Boolean);
        this._settings.set_string('tracked-projects', JSON.stringify(projects));
    }

    get doingLabels() {
        return this._settings.get_string('doing-labels').trim();
    }

    set doingLabels(value) {
        this._settings.set_string('doing-labels', String(value ?? '').trim());
    }

    get lockBehaviour() {
        const value = this._settings.get_string('lock-behaviour');
        return LOCK_POLICIES.includes(value) ? value : 'pause';
    }

    set lockBehaviour(value) {
        this._settings.set_string('lock-behaviour', LOCK_POLICIES.includes(value) ? value : 'pause');
    }

    get panelContent() {
        const value = this._settings.get_string('panel-content');
        return PANEL_CONTENTS.includes(value) ? value : 'time';
    }

    set panelContent(value) {
        this._settings.set_string('panel-content', PANEL_CONTENTS.includes(value) ? value : 'time');
    }

    get idleMinutes() {
        return Math.max(0, this._settings.get_int('idle-minutes'));
    }

    set idleMinutes(value) {
        this._settings.set_int('idle-minutes', Math.max(0, Math.floor(Number(value) || 0)));
    }

    get longTimerHours() {
        return Math.max(0, this._settings.get_int('long-timer-hours'));
    }

    set longTimerHours(value) {
        this._settings.set_int('long-timer-hours', Math.max(0, Math.floor(Number(value) || 0)));
    }

    get roundingMinutes() {
        return Math.max(0, this._settings.get_int('rounding-minutes'));
    }

    set roundingMinutes(value) {
        this._settings.set_int('rounding-minutes', Math.max(0, Math.floor(Number(value) || 0)));
    }

    get lastStaleCheck() {
        return this._settings.get_string('last-stale-check');
    }

    set lastStaleCheck(value) {
        this._settings.set_string('last-stale-check', String(value ?? ''));
    }

    // ---- submit log (feeds the "Today" total) ------------------------------

    /** @returns {{key: string, seconds: number, at: number}[]} newest last, pruned to 31 days */
    getSubmitLog(now = Math.floor(Date.now() / 1000)) {
        const list = parseJson(this._settings.get_string('submit-log'), []);
        const cutoff = now - SUBMIT_LOG_DAYS * 86400;
        return (Array.isArray(list) ? list : []).filter(entry =>
            entry && typeof entry.key === 'string' && Number.isFinite(entry.seconds) && Number.isFinite(entry.at) && entry.at >= cutoff);
    }

    addSubmit({key, seconds, at = Math.floor(Date.now() / 1000)}) {
        const log = this.getSubmitLog(at);
        log.push({key, seconds: Math.max(0, Math.floor(seconds)), at});
        this._settings.set_string('submit-log', JSON.stringify(log));
    }

    /** Seconds submitted successfully on the local calendar day of `now`. */
    submittedTodaySeconds(now = Math.floor(Date.now() / 1000)) {
        const today = localDate(now);
        return this.getSubmitLog(now).filter(entry => localDate(entry.at) === today)
            .reduce((sum, entry) => sum + entry.seconds, 0);
    }

    get timerState() {
        return this._settings.get_string('timer-state');
    }

    set timerState(json) {
        this._settings.set_string('timer-state', json);
    }

    get reportTagsFilter() {
        return this._settings.get_string('report-tags-filter');
    }

    set reportTagsFilter(value) {
        this._settings.set_string('report-tags-filter', String(value ?? ''));
    }

    get reportView() {
        return this._settings.get_string('report-view') || 'categories';
    }

    set reportView(value) {
        this._settings.set_string('report-view', value);
    }

    /** '' = everyone, 'me' = the signed-in user, otherwise a username. */
    get reportUser() {
        return this._settings.get_string('report-user');
    }

    set reportUser(value) {
        this._settings.set_string('report-user', String(value ?? ''));
    }

    get reportExportFormat() {
        return this._settings.get_string('report-export-format') || 'csv';
    }

    set reportExportFormat(value) {
        this._settings.set_string('report-export-format', value);
    }

    getShortcut(key) {
        const value = this._settings.get_strv(key);
        return value.length > 0 ? value[0] : '';
    }

    setShortcut(key, accelerator) {
        this._settings.set_strv(key, accelerator ? [accelerator] : []);
    }

    // ---- caches (scoped to the server URL) ---------------------------------

    get cachedUser() {
        const user = parseJson(this._settings.get_string('cached-user'), {});
        return user?.id && user.url === this.url ? user : null;
    }

    set cachedUser(user) {
        this._settings.set_string('cached-user', user ? JSON.stringify({
            url: this.url, id: user.id, username: user.username, name: user.name,
        }) : '{}');
    }

    get queueCache() {
        const cache = parseJson(this._settings.get_string('queue-cache'), {});
        if (cache?.url !== this.url || !Array.isArray(cache.items))
            return null;
        return cache;
    }

    set queueCache(cache) {
        this._settings.set_string('queue-cache', cache ? JSON.stringify({url: this.url, ...cache}) : '{}');
    }

    get projectsCache() {
        const cache = parseJson(this._settings.get_string('projects-cache'), {});
        if (cache?.url !== this.url || !Array.isArray(cache.projects))
            return [];
        return cache.projects.map(serializeProject).filter(Boolean);
    }

    set projectsCache(projects) {
        this._settings.set_string('projects-cache', JSON.stringify({
            url: this.url,
            projects: (projects ?? []).map(serializeProject).filter(Boolean),
        }));
    }

    // ---- token -------------------------------------------------------------

    async _secret() {
        const Secret = await loadSecret();
        if (!Secret)
            return null;
        if (!this._secretSchema) {
            this._secretSchema = new Secret.Schema(SECRET_SCHEMA_NAME, Secret.SchemaFlags.NONE,
                {server: Secret.SchemaAttributeType.STRING});
        }
        return Secret;
    }

    /** Resolves the token for the current URL: libsecret first, then the GSettings fallback. */
    async getToken(url = this.url) {
        const fallback = this._settings.get_string('gitlab-token');
        if (!url)
            return fallback;
        try {
            const Secret = await this._secret();
            if (!Secret)
                throw new Error('libsecret not available');
            const stored = await new Promise((resolve, reject) => {
                Secret.password_lookup(this._secretSchema, {server: url}, null, (_source, result) => {
                    try {
                        resolve(Secret.password_lookup_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            if (stored) {
                this.tokenStorageWarning = null;
                return stored;
            }
        } catch (e) {
            this.tokenStorageWarning = e.message;
        }
        return fallback;
    }

    /** Stores the token; falls back to the gitlab-token key when libsecret fails. */
    async setToken(token, url = this.url) {
        const value = String(token ?? '').trim();
        try {
            const Secret = await this._secret();
            if (!Secret)
                throw new Error('libsecret not available');
            if (!url)
                throw new Error('Server URL is not set');
            await new Promise((resolve, reject) => {
                const done = (finish) => (_source, result) => {
                    try {
                        finish(result);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                };
                if (value) {
                    Secret.password_store(this._secretSchema, {server: url}, Secret.COLLECTION_DEFAULT,
                        `Timelogs Extension (${url})`, value, null, done(Secret.password_store_finish));
                } else {
                    Secret.password_clear(this._secretSchema, {server: url}, null, done(Secret.password_clear_finish));
                }
            });
            this.tokenStorageWarning = null;
            if (this._settings.get_string('gitlab-token'))
                this._settings.set_string('gitlab-token', '');
        } catch (e) {
            this.tokenStorageWarning = e.message;
            this._settings.set_string('gitlab-token', value);
        }
    }

    // ---- signals -----------------------------------------------------------

    connectChanged(keys, callback) {
        const ids = keys.map(key => this._settings.connect(`changed::${key}`, () => callback(key)));
        return ids;
    }

    disconnect(ids) {
        for (const id of ids ?? [])
            this._settings.disconnect(id);
    }

    // ---- migrations --------------------------------------------------------

    /** Idempotent; safe to run from Shell, prefs and the report process. */
    migrate() {
        const version = this._settings.get_int('settings-version');
        if (version >= SETTINGS_VERSION)
            return false;

        if (this.trackedProjects.length === 0) {
            const legacy = parseJson(this._settings.get_string('default-project'), null);
            const project = serializeProject(legacy);
            if (project?.path_with_namespace)
                this.trackedProjects = [project];
        }

        if (version < 3) {
            this.lockBehaviour = policyFromLegacy({
                resumeOnUnlock: this._settings.get_boolean('resume-on-unlock'),
                countTimeWhenLocked: this._settings.get_boolean('count-time-when-locked'),
            });
        }

        if (version < 4) {
            // show-panel-time=false → icon only; the report now defaults to the signed-in user.
            if (!this._settings.get_boolean('show-panel-time'))
                this.panelContent = 'icon';
            if (this._settings.get_string('report-user') === '')
                this.reportUser = 'me';
        }

        this._settings.set_int('settings-version', SETTINGS_VERSION);
        return true;
    }
}
