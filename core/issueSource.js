// Everything that lists issues: Doing queue, search, current user and member
// projects. Hides HTTP, caching and stale-response handling from the UI.
import Gio from 'gi://Gio';
import {GitLabError, queueQuery, searchQuery, serializeIssue, serializeProject} from './gitlabClient.js';
import {sessionKey} from './sessionStore.js';

export const QUEUE_LIMIT = 15;

function itemKey(item) {
    return sessionKey(item.project, item.issue);
}

/** Local matches for a search text among sessions and cached queue items (instant). */
export function filterLocal(items, text) {
    const query = String(text ?? '').trim().toLowerCase();
    if (!query)
        return [];
    const iid = /^#?(\d+)$/.exec(query)?.[1];
    return items.filter(item => {
        if (iid)
            return String(item.issue.iid) === iid;
        return `#${item.issue.iid} ${item.issue.title}`.toLowerCase().includes(query);
    });
}

export class IssueSource {
    /**
     * @param {{client: object, config: object}} params
     * `config` provides url, trackedProjects, doingLabels, cachedUser, queueCache, projectsCache.
     */
    constructor({client, config}) {
        this._client = client;
        this._config = config;
        this._user = null;
        this._userPromise = null;
        this._queue = null;
        this._queueSerial = 0;
        this._queueCancellable = null;
        this._searchSerial = 0;
        this._searchCancellable = null;
        this._projects = null;
    }

    /** Call when URL or token changed: aborts requests and drops in-memory caches. */
    invalidate() {
        this._user = null;
        this._userPromise = null;
        this._queue = null;
        this._projects = null;
        this._queueCancellable?.cancel();
        this._searchCancellable?.cancel();
        this._queueSerial++;
        this._searchSerial++;
    }

    get isConfigured() {
        return Boolean(this._client.isConfigured);
    }

    get trackedProjects() {
        return this._config.trackedProjects;
    }

    // ---- current user ------------------------------------------------------

    /** Cached per (url, token); persisted for offline start. */
    currentUser() {
        if (this._user)
            return Promise.resolve(this._user);
        if (!this._userPromise) {
            this._userPromise = this._client.get('/user').then(user => {
                this._user = {id: user.id, username: user.username, name: user.name};
                this._config.cachedUser = this._user;
                return this._user;
            }).catch(error => {
                this._userPromise = null;
                const cached = this._config.cachedUser;
                if (cached && error.kind !== 'auth')
                    return {id: cached.id, username: cached.username, name: cached.name};
                throw error;
            });
        }
        return this._userPromise;
    }

    // ---- Doing queue -------------------------------------------------------

    getCachedQueue() {
        if (this._queue)
            return this._queue;
        const cache = this._config.queueCache;
        if (!cache)
            return [];
        this._queue = cache.items
            .filter(item => item?.project?.id && item?.issue?.iid !== undefined)
            .map(item => ({project: serializeProject(item.project), issue: serializeIssue(item.issue), source: 'queue'}));
        return this._queue;
    }

    /**
     * Supersedes previous refreshes; resolves `null` for superseded calls so the
     * caller can ignore stale results. Rejects with GitLabError on failure.
     */
    async refreshQueue() {
        const serial = ++this._queueSerial;
        this._queueCancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._queueCancellable = cancellable;
        const projects = this.trackedProjects;
        if (projects.length === 0) {
            this._queue = [];
            return [];
        }

        const user = await this.currentUser();
        if (serial !== this._queueSerial)
            return null;
        const query = queueQuery({userId: user.id, labels: this._config.doingLabels});
        const perProject = await Promise.all(projects.map(project =>
            this._client.get(`/projects/${project.id}/issues?${query}`, {cancellable})));
        if (serial !== this._queueSerial)
            return null;

        const items = [];
        projects.forEach((project, index) => {
            for (const issue of perProject[index] ?? [])
                items.push({project, issue: serializeIssue(issue), source: 'queue'});
        });
        this._queue = items;
        this._config.queueCache = {user_id: user.id, items: items.map(({project, issue}) => ({project, issue}))};
        return items;
    }

    // ---- search ------------------------------------------------------------

    /** Remote matches across tracked projects; resolves `null` when superseded. */
    async search(text) {
        const serial = ++this._searchSerial;
        this._searchCancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._searchCancellable = cancellable;
        const trimmed = String(text ?? '').trim();
        const projects = this.trackedProjects;
        if (!trimmed || projects.length === 0)
            return [];

        const query = searchQuery(trimmed);
        const results = await Promise.allSettled(projects.map(project =>
            this._client.get(`/projects/${project.id}/issues?${query}`, {cancellable})));
        if (serial !== this._searchSerial)
            return null;

        const items = [];
        let failure = null;
        projects.forEach((project, index) => {
            const result = results[index];
            if (result.status === 'fulfilled') {
                for (const issue of result.value ?? [])
                    items.push({project, issue: serializeIssue(issue), source: 'search'});
            } else if (!failure) {
                failure = result.reason;
            }
        });
        if (items.length === 0 && failure)
            throw failure;
        return items;
    }

    cancelSearch() {
        this._searchSerial++;
        this._searchCancellable?.cancel();
    }

    // ---- projects ----------------------------------------------------------

    async listMemberProjects({refresh = false} = {}) {
        if (!refresh) {
            if (this._projects)
                return this._projects;
            const cached = this._config.projectsCache;
            if (cached.length > 0) {
                this._projects = cached;
                return cached;
            }
        }
        const projects = await this._client.getAllPages(
            '/projects?membership=true&simple=true&order_by=last_activity_at&sort=desc&per_page=100', {maxPages: 10});
        this._projects = projects.map(serializeProject).filter(Boolean);
        this._config.projectsCache = this._projects;
        return this._projects;
    }
}

/** Removes items that already have a session and caps the queue for display. */
export function visibleQueue(items, store, limit = QUEUE_LIMIT) {
    return items.filter(item => !store.has(item.project, item.issue)).slice(0, limit);
}

/** Merges local and remote results, local first, de-duplicated by key. */
export function mergeResults(local, remote) {
    const seen = new Set(local.map(itemKey));
    const merged = [...local];
    for (const item of remote ?? []) {
        const key = itemKey(item);
        if (seen.has(key))
            continue;
        seen.add(key);
        merged.push(item);
    }
    return merged;
}

export {GitLabError};
