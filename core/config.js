// Typed GSettings access, token storage (libsecret with GSettings fallback) and
// idempotent migrations. Shared by the Shell process, prefs and the report.
import Gio from 'gi://Gio';
import {policyFromLegacy, LOCK_POLICIES} from './lockPolicy.js';
import {serializeProject} from './gitlabClient.js';

export const SCHEMA_ID = 'org.gnome.shell.extensions.timelogs-extension';
export const SETTINGS_VERSION = 3;
const SECRET_SCHEMA_NAME = 'org.gnome.shell.extensions.timelogs-extension.Token';

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

    get showPanelTime() {
        return this._settings.get_boolean('show-panel-time');
    }

    set showPanelTime(value) {
        this._settings.set_boolean('show-panel-time', Boolean(value));
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

        this._settings.set_int('settings-version', SETTINGS_VERSION);
        return true;
    }
}
