// The only place that builds GitLab URLs, sets PRIVATE-TOKEN, paginates and maps
// errors. Imports only GLib/Gio/Soup so Shell, prefs, the report process and
// headless tests can share it.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

export class GitLabError extends Error {
    /**
     * @param {'auth'|'not-found'|'network'|'http'|'config'|'cancelled'|'graphql'} kind
     * @param {string} message
     * @param {number} [status]
     */
    constructor(kind, message, status = 0) {
        super(message);
        this.name = 'GitLabError';
        this.kind = kind;
        this.status = status;
    }
}

/** Trim, strip trailing slashes, require http(s). Throws GitLabError('config'). */
export function normalizeUrl(url) {
    const trimmed = String(url ?? '').trim().replace(/\/+$/, '');
    if (!trimmed)
        throw new GitLabError('config', 'Server URL is not set');
    if (!/^https?:\/\/[^/\s]+/i.test(trimmed))
        throw new GitLabError('config', 'Server URL must start with https://');
    return trimmed;
}

export function encodeParams(params) {
    const entries = Array.isArray(params) ? params : Object.entries(params ?? {});
    return entries
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');
}

function statusToError(status, body) {
    let detail = '';
    try {
        const parsed = JSON.parse(body);
        detail = parsed?.message ?? parsed?.error ?? '';
        if (detail && typeof detail !== 'string')
            detail = JSON.stringify(detail);
    } catch (e) {
        detail = '';
    }
    const suffix = detail ? `: ${detail}` : '';
    if (status === 401 || status === 403)
        return new GitLabError('auth', `HTTP ${status}${suffix}`, status);
    if (status === 404)
        return new GitLabError('not-found', `HTTP ${status}${suffix}`, status);
    return new GitLabError('http', `HTTP ${status}${suffix}`, status);
}

export class GitLabClient {
    /**
     * @param {{url?: string, token?: string, timeoutSeconds?: number, session?: object}} params
     * `session` lets tests inject a fake Soup.Session.
     */
    constructor({url = '', token = '', timeoutSeconds = 15, session = null} = {}) {
        this._session = session ?? new Soup.Session({timeout: timeoutSeconds});
        this._cancellable = new Gio.Cancellable();
        this.setCredentials({url, token});
    }

    get url() {
        return this._url;
    }

    get isConfigured() {
        return Boolean(this._url && this._token);
    }

    /** Aborts in-flight requests; a bad URL leaves the client unconfigured. */
    setCredentials({url, token}) {
        this.abort();
        try {
            this._url = normalizeUrl(url);
        } catch (e) {
            this._url = '';
        }
        this._token = String(token ?? '').trim();
    }

    abort() {
        this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
    }

    _requireConfig() {
        if (!this._url)
            throw new GitLabError('config', 'Server URL is not set');
        if (!this._token)
            throw new GitLabError('config', 'Access token is not set');
    }

    _send(method, fullUrl, {body = null, contentType = null, cancellable = null} = {}) {
        return new Promise((resolve, reject) => {
            let message;
            try {
                this._requireConfig();
                message = Soup.Message.new(method, fullUrl);
                if (!message)
                    throw new GitLabError('config', `Invalid URL: ${fullUrl}`);
                message.request_headers.append('PRIVATE-TOKEN', this._token);
                if (body !== null)
                    message.set_request_body_from_bytes(contentType, new GLib.Bytes(new TextEncoder().encode(body)));
            } catch (e) {
                reject(e instanceof GitLabError ? e : new GitLabError('config', e.message));
                return;
            }

            const combined = new Gio.Cancellable();
            const links = [this._cancellable, cancellable].filter(Boolean).map(source =>
                [source, source.connect(() => combined.cancel())]);
            if (links.some(([source]) => source.is_cancelled()))
                combined.cancel();

            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, combined, (session, result) => {
                for (const [source, id] of links)
                    source.disconnect(id);
                let bytes;
                try {
                    bytes = session.send_and_read_finish(result);
                } catch (e) {
                    if (combined.is_cancelled() || e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        reject(new GitLabError('cancelled', 'Request cancelled'));
                    else
                        reject(new GitLabError('network', e.message));
                    return;
                }
                const status = message.get_status?.() ?? message.status_code;
                const text = bytes ? new TextDecoder('utf-8').decode(bytes.get_data() ?? new Uint8Array()) : '';
                if (status < 200 || status >= 300) {
                    reject(statusToError(status, text));
                    return;
                }
                const headers = message.get_response_headers?.() ?? message.response_headers;
                resolve({status, text, headers});
            });
        });
    }

    _apiUrl(path) {
        return `${this._url}/api/v4${path.startsWith('/') ? path : `/${path}`}`;
    }

    /** GET /api/v4<path>; resolves with parsed JSON. */
    async get(path, {cancellable = null} = {}) {
        const {text} = await this._send('GET', this._apiUrl(path), {cancellable});
        return text ? JSON.parse(text) : null;
    }

    /** Follows X-Next-Page and concatenates array responses. */
    async getAllPages(path, {maxPages = 20, cancellable = null} = {}) {
        const items = [];
        let page = null;
        for (let count = 0; count < maxPages; count++) {
            const separator = path.includes('?') ? '&' : '?';
            const pagePath = page ? `${path}${separator}page=${page}` : path;
            const {text, headers} = await this._send('GET', this._apiUrl(pagePath), {cancellable});
            const data = text ? JSON.parse(text) : [];
            items.push(...(Array.isArray(data) ? data : [data]));
            page = headers?.get_one?.('X-Next-Page') || '';
            if (!page)
                break;
        }
        return items;
    }

    /** POST /api/v4<path>?<params>; GitLab accepts form params in the query string. */
    async post(path, params = {}, {cancellable = null} = {}) {
        const query = encodeParams(params);
        const url = this._apiUrl(path) + (query ? `${path.includes('?') ? '&' : '?'}${query}` : '');
        const {text} = await this._send('POST', url, {body: '', contentType: 'application/x-www-form-urlencoded', cancellable});
        return text ? JSON.parse(text) : null;
    }

    /** POST /api/graphql; throws GitLabError('graphql') when errors[] is present. */
    async graphql(query, variables = {}, {cancellable = null} = {}) {
        const {text} = await this._send('POST', `${this._url}/api/graphql`, {
            body: JSON.stringify({query, variables}),
            contentType: 'application/json',
            cancellable,
        });
        const payload = JSON.parse(text);
        if (payload.errors?.length)
            throw new GitLabError('graphql', payload.errors.map(item => item.message).join('; '));
        return payload.data;
    }
}

/** Query string for the Doing queue of one project. */
export function queueQuery({userId, labels}) {
    return encodeParams([
        ['state', 'opened'],
        ['assignee_id', userId],
        ['labels', labels],
        ['order_by', 'relative_position'],
        ['sort', 'asc'],
        ['per_page', 50],
    ]);
}

/** Query string for text or #iid search within one project. */
export function searchQuery(text) {
    const trimmed = String(text ?? '').trim();
    if (/^#?\d+$/.test(trimmed))
        return encodeParams([['iids[]', trimmed.replace(/^#/, '')], ['per_page', 10]]);
    return encodeParams([
        ['search', trimmed],
        ['in', 'title,description'],
        ['state', 'opened'],
        ['order_by', 'updated_at'],
        ['sort', 'desc'],
        ['per_page', 10],
    ]);
}

export function serializeProject(project) {
    if (!project?.id)
        return null;
    return {
        id: project.id,
        path_with_namespace: project.path_with_namespace,
        name: project.name ?? project.path_with_namespace,
        web_url: project.web_url ?? null,
    };
}

export function serializeIssue(issue) {
    if (!issue || issue.iid === undefined || issue.iid === null)
        return null;
    return {
        id: issue.id ?? null,
        iid: issue.iid,
        title: String(issue.title ?? ''),
        project_id: issue.project_id ?? null,
        web_url: issue.web_url ?? null,
        state: issue.state ?? null,
    };
}
