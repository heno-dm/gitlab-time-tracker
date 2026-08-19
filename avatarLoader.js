import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

/**
 * AvatarLoader - Shared utility for loading GitLab project/group/user avatars
 */
export class AvatarLoader {
    constructor(settings, httpSession) {
        this._settings = settings;
        this._httpSession = httpSession;
        this._avatarCache = new Map();
    }

    /**
     * Fetch a URL with authentication and return the response bytes
     * @param {string} url - The URL to fetch
     * @param {Function} callback - Called with (statusCode, bytes) on completion
     * @param {boolean} auth - Whether to add PRIVATE-TOKEN header (default: true)
     */
    _fetch(url, callback, auth = true) {
        const message = Soup.Message.new('GET', url);
        if (!message) {
            callback(-1, null);
            return;
        }
        if (auth)
            message.request_headers.append('PRIVATE-TOKEN', this._settings.get_string('gitlab-token'));

        this._httpSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    callback(message.status_code, bytes);
                } catch (e) {
                    console.debug(`GitLab AvatarLoader: Fetch error for ${url}: ${e.message}`);
                    callback(-1, null);
                }
            }
        );
    }

    /**
     * Load avatar for a project, with fallback to namespace avatar
     * @param {number} projectId - The project ID
     * @param {object|null} namespace - The project namespace (optional)
     * @param {St.Icon} iconWidget - The icon widget to update
     */
    loadProjectAvatar(projectId, namespace, iconWidget) {
        const cacheKey = `project-${projectId}`;

        if (this._avatarCache.has(cacheKey)) {
            const gicon = this._avatarCache.get(cacheKey);
            if (gicon)
                iconWidget.set_gicon(gicon);
            return;
        }

        const baseUrl = this._settings.get_string('gitlab-url');
        const apiUrl = `${baseUrl}/api/v4/projects/${projectId}/avatar`;

        this._fetch(apiUrl, (status, bytes) => {
            if (status === 200 && bytes && bytes.get_size() > 0) {
                const gicon = Gio.BytesIcon.new(bytes);
                this._avatarCache.set(cacheKey, gicon);
                try { iconWidget.set_gicon(gicon); } catch(e) { /* widget destroyed */ }
            } else if (namespace) {
                this._loadNamespaceAvatar(namespace, iconWidget, cacheKey);
            } else {
                this._avatarCache.set(cacheKey, null);
            }
        });
    }

    _loadNamespaceAvatar(namespace, iconWidget, cacheKey) {
        if (namespace.kind === 'user')
            this._loadUserAvatar(namespace.id, iconWidget, cacheKey);
        else
            this._loadGroupAvatar(namespace.id, iconWidget, cacheKey);
    }

    _loadUserAvatar(userId, iconWidget, cacheKey) {
        const baseUrl = this._settings.get_string('gitlab-url');
        const apiUrl = `${baseUrl}/api/v4/users/${userId}`;

        this._fetch(apiUrl, (status, bytes) => {
            if (status === 200) {
                const decoder = new TextDecoder('utf-8');
                const user = JSON.parse(decoder.decode(bytes.get_data()));

                if (user.avatar_url)
                    this._downloadAvatar(user.avatar_url, iconWidget, cacheKey);
                else
                    this._avatarCache.set(cacheKey, null);
            } else {
                this._avatarCache.set(cacheKey, null);
            }
        });
    }

    _downloadAvatar(avatarUrl, iconWidget, cacheKey) {
        let fullUrl = avatarUrl;
        if (avatarUrl.startsWith('/')) {
            const gitlabUrl = this._settings.get_string('gitlab-url');
            fullUrl = gitlabUrl + avatarUrl;
        }

        // Use auth header for private upload avatars
        const needsAuth = fullUrl.includes('/uploads/');

        this._fetch(fullUrl, (status, bytes) => {
            if (status === 200 && bytes && bytes.get_size() > 0) {
                const gicon = Gio.BytesIcon.new(bytes);
                this._avatarCache.set(cacheKey, gicon);
                try { iconWidget.set_gicon(gicon); } catch(e) { /* widget destroyed */ }
            } else {
                this._avatarCache.set(cacheKey, null);
            }
        }, needsAuth);
    }

    _loadGroupAvatar(groupId, iconWidget, cacheKey) {
        const baseUrl = this._settings.get_string('gitlab-url');
        const apiUrl = `${baseUrl}/api/v4/groups/${groupId}/avatar`;

        this._fetch(apiUrl, (status, bytes) => {
            if (status === 200 && bytes && bytes.get_size() > 0) {
                const gicon = Gio.BytesIcon.new(bytes);
                this._avatarCache.set(cacheKey, gicon);
                try { iconWidget.set_gicon(gicon); } catch(e) { /* widget destroyed */ }
            } else {
                this._avatarCache.set(cacheKey, null);
            }
        });
    }

    /**
     * Get cached avatar for a project
     * @param {number} projectId - The project ID
     * @returns {Gio.Icon|null} The cached icon or null
     */
    getCachedAvatar(projectId) {
        const cacheKey = `project-${projectId}`;
        return this._avatarCache.get(cacheKey) || null;
    }

    /**
     * Clear the avatar cache
     */
    clearCache() {
        this._avatarCache.clear();
    }
}
