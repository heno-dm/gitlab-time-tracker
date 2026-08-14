import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {AvatarLoader} from './avatarLoader.js';
import {getRecentIssues} from './state.js';

export const IssueSelectorDialog = GObject.registerClass(
class IssueSelectorDialog extends St.BoxLayout {
    _init(settings, gettext, currentProject, currentIssue, onSelected) {
        super._init({
            vertical: true,
            style_class: 'modal-dialog gitlab-issue-selector-dialog',
            reactive: true,
            can_focus: true,
        });

        this._settings = settings;
        this._ = gettext;
        this._onSelected = onSelected;
        this._preselectedProject = currentProject;
        this._preselectedIssue = currentIssue;
        this._httpSession = new Soup.Session();
        this._avatarLoader = new AvatarLoader(settings, this._httpSession);
        this._recentIssues = getRecentIssues(settings);
        this._projects = [];
        this._allIssues = [];
        this._selectedProject = null;
        this._issuePage = 1;
        this._issuePerPage = 100;
        this._issueHasMore = false;
        this._issueLoading = false;
        this._issueRequestSerial = 0;
        this._issueReloadId = null;
        this._currentUser = null;
        this._defaultButtonAction = null;
        this._escapeButtonAction = null;
        this._dragging = false;
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._dragActorX = 0;
        this._dragActorY = 0;
        this._maximized = false;
        this._restoreGeometry = null;

        this.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Escape && this._escapeButtonAction) {
                this._escapeButtonAction();
                return Clutter.EVENT_STOP;
            }
            if ((symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) && this._defaultButtonAction) {
                this._defaultButtonAction();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._buildUI();
        this._loadCurrentUser();
        this._loadProjects();
    }

    _buildUI() {
        this._buildTitleBar();

        // Main container
        this._content = new St.BoxLayout({
            vertical: true,
            style_class: 'gitlab-selector-content',
            style: 'min-width: 600px; min-height: 500px;'
        });

        // Title
        let title = new St.Label({
            text: this._('Select a project and an issue'),
            style_class: 'gitlab-selector-title',
            style: 'font-size: 16px; font-weight: bold; margin-bottom: 10px;'
        });
        this._content.add_child(title);

        // Project section
        let projectBox = new St.BoxLayout({
            vertical: true,
            style: 'margin-bottom: 20px;'
        });

        let projectLabel = new St.Label({
            text: this._('Project'),
            style: 'font-weight: bold; margin-bottom: 5px;'
        });
        projectBox.add_child(projectLabel);

        // Project search
        this._projectSearchEntry = new St.Entry({
            hint_text: this._('Search project...'),
            can_focus: true,
            track_hover: true,
            style: 'margin-bottom: 5px;'
        });
        this._projectSearchEntry.clutter_text.connect('text-changed', () => {
            this._updateProjectList();
        });
        projectBox.add_child(this._projectSearchEntry);

        // Project list container with overlay support
        let projectContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'popup-menu-content gitlab-list-container',
            x_expand: true,
            clip_to_allocation: true
        });

        let projectScrollView = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true
        });

        this._projectList = new St.BoxLayout({
            vertical: true,
            style_class: 'gitlab-project-list'
        });
        projectScrollView.add_child(this._projectList);
        projectContainer.add_child(projectScrollView);

        this._projectLoadingOverlay = this._createLoadingOverlay();
        projectContainer.add_child(this._projectLoadingOverlay);

        projectBox.add_child(projectContainer);

        this._content.add_child(projectBox);

        // Issue section
        let issueBox = new St.BoxLayout({
            vertical: true,
            style: 'margin-bottom: 20px;'
        });

        let issueLabel = new St.Label({
            text: this._('Issue'),
            style: 'font-weight: bold; margin-bottom: 5px;'
        });
        issueBox.add_child(issueLabel);

        this._recentIssueBox = new St.BoxLayout({
            vertical: true,
            style: 'margin-bottom: 10px;',
        });
        issueBox.add_child(this._recentIssueBox);
        this._updateRecentIssueList();

        // Issue filters are sent to GitLab; do not filter locally because large projects may exceed one page.
        this._issueSearchEntry = new St.Entry({
            hint_text: this._('Search issues on GitLab...'),
            can_focus: true,
            track_hover: true,
            style: 'margin-bottom: 5px;'
        });
        this._issueSearchEntry.set_text(this._settings.get_string('issue-filter-search'));
        this._issueSearchEntry.clutter_text.connect('text-changed', () => {
            this._settings.set_string('issue-filter-search', this._issueSearchEntry.get_text());
            this._scheduleIssueReload();
        });
        issueBox.add_child(this._issueSearchEntry);

        let filterBox = new St.BoxLayout({
            vertical: false,
            style: 'margin-bottom: 5px; spacing: 8px;'
        });

        this._issueStateButton = new St.Button({
            style_class: 'popup-menu-item',
            can_focus: true,
            track_hover: true,
            style: 'padding: 6px 10px;'
        });
        this._issueStateLabel = new St.Label({ text: this._stateLabel(this._getIssueState()) });
        this._issueStateButton.set_child(this._issueStateLabel);
        this._issueStateMenu = new PopupMenu.PopupMenu(this._issueStateButton, 0.0, St.Side.TOP);
        Main.uiGroup.add_child(this._issueStateMenu.actor);
        this._issueStateMenu.actor.hide();
        for (const state of ['opened', 'closed', 'all']) {
            const item = new PopupMenu.PopupMenuItem(this._stateLabel(state));
            item.connect('activate', () => this._setIssueState(state));
            this._issueStateMenu.addMenuItem(item);
        }
        this._issueStateButton.connect('clicked', () => this._issueStateMenu.toggle());
        filterBox.add_child(this._issueStateButton);

        this._issueAssigneeEntry = new St.Entry({
            hint_text: this._('Assignee: username, me, or None'),
            can_focus: true,
            track_hover: true,
            x_expand: true
        });
        this._issueAssigneeEntry.set_text(this._settings.get_string('issue-filter-assignee'));
        this._issueAssigneeEntry.clutter_text.connect('text-changed', () => {
            this._settings.set_string('issue-filter-assignee', this._issueAssigneeEntry.get_text().trim());
            this._scheduleIssueReload();
        });
        filterBox.add_child(this._issueAssigneeEntry);

        this._issueLabelsEntry = new St.Entry({
            hint_text: this._('Labels, comma-separated'),
            can_focus: true,
            track_hover: true,
            x_expand: true
        });
        this._issueLabelsEntry.set_text(this._settings.get_string('issue-filter-labels'));
        this._issueLabelsEntry.clutter_text.connect('text-changed', () => {
            this._settings.set_string('issue-filter-labels', this._issueLabelsEntry.get_text().trim());
            this._scheduleIssueReload();
        });
        filterBox.add_child(this._issueLabelsEntry);

        issueBox.add_child(filterBox);

        // Issue list container with overlay support
        let issueContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'popup-menu-content gitlab-list-container',
            x_expand: true,
            clip_to_allocation: true
        });

        let issueScrollView = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true
        });

        this._issueList = new St.BoxLayout({
            vertical: true,
            style_class: 'gitlab-issue-list'
        });
        issueScrollView.add_child(this._issueList);
        issueContainer.add_child(issueScrollView);

        this._issueLoadingOverlay = this._createLoadingOverlay();
        issueContainer.add_child(this._issueLoadingOverlay);

        issueBox.add_child(issueContainer);

        this._loadMoreButton = new St.Button({
            label: this._('Load more issues'),
            style_class: 'popup-menu-item',
            can_focus: true,
            track_hover: true,
            x_expand: true,
            style: 'margin-top: 5px; padding: 8px;'
        });
        this._loadMoreButton.connect('clicked', () => this._loadMoreIssues());
        this._loadMoreButton.hide();
        issueBox.add_child(this._loadMoreButton);

        this._content.add_child(issueBox);

        this.add_child(this._content);

        // Buttons
        this.setButtons([
            {
                label: this._('Cancel'),
                action: () => this.close(),
                key: Clutter.KEY_Escape
            },
            {
                label: this._('Select'),
                action: () => this._onSelect(),
                default: true
            }
        ]);

        this._selectedProjectWidget = null;
        this._selectedIssueWidget = null;
    }

    _buildTitleBar() {
        const titleBar = new St.BoxLayout({
            vertical: false,
            reactive: true,
            style_class: 'gitlab-selector-titlebar',
            style: 'padding: 6px 8px; spacing: 8px; background-color: rgba(255,255,255,0.08);',
            x_expand: true,
        });

        const title = new St.Label({
            text: this._('Issue selector'),
            style: 'font-weight: bold;',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        titleBar.add_child(title);

        const minimizeButton = this._createTitleButton('_', () => this._toggleMinimized());
        const maximizeButton = this._createTitleButton('[]', () => this._toggleMaximized());
        const closeButton = this._createTitleButton('x', () => this.close());

        titleBar.add_child(minimizeButton);
        titleBar.add_child(maximizeButton);
        titleBar.add_child(closeButton);

        titleBar.connect('button-press-event', (_actor, event) => {
            if (this._maximized)
                return Clutter.EVENT_PROPAGATE;

            const [stageX, stageY] = event.get_coords();
            const [actorX, actorY] = this.get_position();
            this._dragging = true;
            this._dragStartX = stageX;
            this._dragStartY = stageY;
            this._dragActorX = actorX;
            this._dragActorY = actorY;
            this.raise_top();
            return Clutter.EVENT_STOP;
        });

        titleBar.connect('motion-event', (_actor, event) => {
            if (!this._dragging)
                return Clutter.EVENT_PROPAGATE;

            const [stageX, stageY] = event.get_coords();
            this.set_position(
                Math.floor(this._dragActorX + stageX - this._dragStartX),
                Math.floor(this._dragActorY + stageY - this._dragStartY)
            );
            return Clutter.EVENT_STOP;
        });

        titleBar.connect('button-release-event', () => {
            if (!this._dragging)
                return Clutter.EVENT_PROPAGATE;

            this._dragging = false;
            return Clutter.EVENT_STOP;
        });

        this.add_child(titleBar);
    }

    _createTitleButton(label, action) {
        const button = new St.Button({
            label,
            style_class: 'button',
            can_focus: true,
            style: 'min-width: 24px; min-height: 22px; padding: 2px 6px;',
        });
        button.connect('clicked', action);
        return button;
    }

    _toggleMinimized() {
        if (!this._content.visible) {
            this._content.show();
            this._buttonBox.show();
            this._positionOnPrimaryMonitor();
            return;
        }

        this._content.hide();
        this._buttonBox.hide();
        this._maximized = false;
        this.set_size(-1, -1);
    }

    _toggleMaximized() {
        const monitor = Main.layoutManager.primaryMonitor;

        if (this._maximized) {
            this._maximized = false;
            if (this._restoreGeometry) {
                this.set_position(this._restoreGeometry.x, this._restoreGeometry.y);
                this.set_size(this._restoreGeometry.width, this._restoreGeometry.height);
            } else {
                this.set_size(-1, -1);
                this._positionOnPrimaryMonitor();
            }
            return;
        }

        const [x, y] = this.get_position();
        this._restoreGeometry = {
            x,
            y,
            width: this.get_width(),
            height: this.get_height(),
        };
        this._content.show();
        this._buttonBox.show();
        this._maximized = true;
        this.set_position(monitor.x + 24, monitor.y + 24);
        this.set_size(monitor.width - 48, monitor.height - 48);
    }

    setButtons(buttons) {
        this._buttonBox = new St.BoxLayout({
            vertical: false,
            style: 'spacing: 8px; padding-top: 10px;',
            x_align: Clutter.ActorAlign.END,
        });

        for (const buttonInfo of buttons) {
            const button = new St.Button({
                label: buttonInfo.label,
                style_class: 'modal-dialog-button button',
                can_focus: true,
                x_expand: false,
            });
            button.connect('clicked', buttonInfo.action);
            this._buttonBox.add_child(button);

            if (buttonInfo.default)
                this._defaultButtonAction = buttonInfo.action;
            if (buttonInfo.key === Clutter.KEY_Escape)
                this._escapeButtonAction = buttonInfo.action;
        }

        this.add_child(this._buttonBox);
    }

    open() {
        if (!this.get_parent())
            Main.layoutManager.uiGroup.add_child(this);

        this._positionOnPrimaryMonitor();
        this.show();
        this.raise_top();
        this.grab_key_focus();
    }

    close() {
        this.destroy();
    }

    _positionOnPrimaryMonitor() {
        const monitor = Main.layoutManager.primaryMonitor;
        const width = this.get_width() || 640;
        const height = this.get_height() || 620;
        this.set_position(
            Math.floor(monitor.x + (monitor.width - width) / 2),
            Math.floor(monitor.y + (monitor.height - height) / 2)
        );
    }

    _apiGet(path, overlay, loadingText, onSuccess, onError = null) {
        if (overlay)
            this._showOverlay(overlay, loadingText);

        const url = this._settings.get_string('gitlab-url');
        const token = this._settings.get_string('gitlab-token');

        const message = Soup.Message.new('GET', `${url}/api/v4${path}`);
        message.request_headers.append('PRIVATE-TOKEN', token);

        this._httpSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const decoder = new TextDecoder('utf-8');
                    const response = decoder.decode(bytes.get_data());

                    if (message.status_code === 200) {
                        onSuccess(JSON.parse(response));
                        if (overlay)
                            this._hideOverlay(overlay);
                    } else if (message.status_code === 401 || message.status_code === 403) {
                        if (overlay)
                            this._showOverlay(overlay, this._('Please configure the server URL and token in preferences'));
                        if (onError)
                            onError(message.status_code);
                    } else {
                        if (overlay)
                            this._showOverlay(overlay, `${this._('Error')}: ${message.status_code}`);
                        if (onError)
                            onError(message.status_code);
                    }
                } catch (e) {
                    if (overlay)
                        this._showOverlay(overlay, `${this._('Error')}: ${e.message}`);
                    if (onError)
                        onError(e);
                }
            }
        );
    }

    _loadCurrentUser() {
        this._apiGet('/user', null, '', (data) => {
            this._currentUser = data;
            if (this._selectedProject && this._settings.get_string('issue-filter-assignee').trim().toLowerCase() === 'me')
                this._reloadIssues();
        });
    }

    _loadProjects() {
        this._apiGet(
            '/projects?membership=true&per_page=100&order_by=last_activity_at',
            this._projectLoadingOverlay,
            this._('Loading projects...'),
            (data) => {
                this._projects = data;
                this._updateProjectList();

                // Auto-select preselected project
                if (this._preselectedProject) {
                    const sorted = [...this._projects].sort((a, b) =>
                        a.path_with_namespace.localeCompare(b.path_with_namespace));
                    const index = sorted.findIndex(p => p.id === this._preselectedProject.id);
                    if (index >= 0) {
                        const widgets = this._projectList.get_children();
                        if (widgets[index])
                            this._selectProject(sorted[index], widgets[index]);
                    }
                }
            }
        );
    }

    _updateProjectList() {
        this._selectedProjectWidget = null;
        this._projectList.destroy_all_children();

        const searchText = this._projectSearchEntry.get_text().toLowerCase();
        const searchWords = searchText.split(/\s+/).filter(w => w.length > 0);
        let filteredProjects = searchWords.length > 0
            ? this._projects.filter(p => {
                const haystack = `${p.name} ${p.path_with_namespace}`.toLowerCase();
                return searchWords.every(word => haystack.includes(word));
            })
            : this._projects;

        filteredProjects = filteredProjects.sort((a, b) =>
            a.path_with_namespace.localeCompare(b.path_with_namespace)
        );

        for (let project of filteredProjects) {
            let item = new St.Button({
                style_class: 'popup-menu-item',
                can_focus: true,
                track_hover: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL
            });

            // Create horizontal box for icon + text
            let box = new St.BoxLayout({
                vertical: false,
                x_align: Clutter.ActorAlign.START,
                x_expand: true,
            });

            // Add project/group icon
            let icon = new St.Icon({
                icon_name: 'folder-symbolic',
                icon_size: 24,
                style: 'width: 24px; height: 24px; border-radius: 3px;'
            });

            // Load project avatar using shared loader
            const namespace = project.namespace || null;
            this._avatarLoader.loadProjectAvatar(project.id, namespace, icon);

            box.add_child(icon);

            let label = new St.Label({
                text: project.path_with_namespace,
                style: 'margin-left: 8px;',
                y_align: Clutter.ActorAlign.CENTER
            });
            box.add_child(label);

            item.set_child(box);

            item.connect('clicked', () => {
                this._selectProject(project, item);
            });

            this._projectList.add_child(item);
        }
    }

    _selectProject(project, widget) {
        this._selectedProject = project;

        // Highlight selected project
        if (this._selectedProjectWidget)
            this._selectedProjectWidget.remove_style_pseudo_class('active');
        this._selectedProjectWidget = widget;
        widget.add_style_pseudo_class('active');

        // Load issues for this project
        this._loadIssues(project.id);
    }

    _loadIssues(projectId) {
        this._issuePage = 1;
        this._issueHasMore = false;
        this._allIssues = [];
        this._selectedIssue = null;
        this._selectedIssueWidget = null;
        this._updateIssueList();
        this._loadIssuesPage(projectId, 1, false);
    }

    _reloadIssues() {
        if (!this._selectedProject)
            return;

        this._issuePage = 1;
        this._allIssues = [];
        this._selectedIssueWidget = null;
        this._updateIssueList();
        this._loadIssuesPage(this._selectedProject.id, 1, false);
    }

    _scheduleIssueReload() {
        if (this._issueReloadId) {
            GLib.source_remove(this._issueReloadId);
            this._issueReloadId = null;
        }

        this._issueReloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._issueReloadId = null;
            this._reloadIssues();
            return GLib.SOURCE_REMOVE;
        });
    }

    _loadMoreIssues() {
        if (!this._selectedProject || this._issueLoading || !this._issueHasMore)
            return;

        this._loadIssuesPage(this._selectedProject.id, this._issuePage + 1, true);
    }

    _loadIssuesPage(projectId, page, append) {
        const requestSerial = ++this._issueRequestSerial;
        this._issueLoading = true;
        this._loadMoreButton.hide();

        const query = this._buildIssueQuery(page);
        this._apiGet(
            `/projects/${projectId}/issues?${query}`,
            this._issueLoadingOverlay,
            this._('Loading issues...'),
            (data) => {
                if (requestSerial !== this._issueRequestSerial)
                    return;

                this._issueLoading = false;
                this._issuePage = page;
                this._issueHasMore = data.length === this._issuePerPage;
                this._allIssues = append ? this._allIssues.concat(data) : data;
                this._updateIssueList();

                // Auto-select preselected issue when it is present in the server-filtered result.
                if (this._preselectedIssue) {
                    const index = this._allIssues.findIndex(i => i.iid === this._preselectedIssue.iid);
                    if (index >= 0) {
                        const widgets = this._issueList.get_children();
                        if (widgets[index])
                            this._selectIssue(this._allIssues[index], widgets[index]);
                    }
                }
            },
            () => {
                if (requestSerial !== this._issueRequestSerial)
                    return;

                this._issueLoading = false;
                this._updateIssueList();
            }
        );
    }

    _buildIssueQuery(page) {
        const params = [
            ['state', this._getIssueState()],
            ['per_page', String(this._issuePerPage)],
            ['page', String(page)],
        ];

        const search = this._settings.get_string('issue-filter-search').trim();
        if (search) {
            params.push(['search', search]);
            params.push(['in', 'title,description']);
        }

        const assignee = this._settings.get_string('issue-filter-assignee').trim();
        if (assignee) {
            const normalized = assignee.toLowerCase();
            if (normalized === 'none' || normalized === 'unassigned') {
                params.push(['assignee_id', 'None']);
            } else if (normalized === 'me') {
                if (this._currentUser?.username)
                    params.push(['assignee_username', this._currentUser.username]);
            } else {
                params.push(['assignee_username', assignee.replace(/^@/, '')]);
            }
        }

        const labels = this._settings.get_string('issue-filter-labels').trim();
        if (labels)
            params.push(['labels', labels]);

        return params
            .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
            .join('&');
    }

    _getIssueState() {
        const state = this._settings.get_string('issue-filter-state');
        return ['opened', 'closed', 'all'].includes(state) ? state : 'opened';
    }

    _setIssueState(state) {
        this._settings.set_string('issue-filter-state', state);
        this._issueStateLabel.text = this._stateLabel(state);
        this._reloadIssues();
    }

    _stateLabel(state) {
        switch (state) {
        case 'closed':
            return this._('Closed issues');
        case 'all':
            return this._('All issues');
        default:
            return this._('Open issues');
        }
    }

    _updateIssueList() {
        this._selectedIssueWidget = null;
        this._issueList.destroy_all_children();

        for (let issue of this._allIssues) {
            let item = new St.Button({
                style_class: 'popup-menu-item',
                can_focus: true,
                track_hover: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL
            });

            let label = new St.Label({
                text: `#${issue.iid} - ${issue.title}`,
                x_align: Clutter.ActorAlign.START,
                x_expand: true
            });
            item.set_child(label);

            item.connect('clicked', () => {
                this._selectIssue(issue, item);
            });

            this._issueList.add_child(item);
        }

        if (this._allIssues.length === 0 && !this._issueLoading) {
            let emptyLabel = new St.Label({
                text: this._('No issues found'),
                style_class: 'gitlab-empty-label'
            });
            this._issueList.add_child(emptyLabel);
        }

        if (this._issueHasMore && !this._issueLoading)
            this._loadMoreButton.show();
        else
            this._loadMoreButton.hide();
    }

    _updateRecentIssueList() {
        this._recentIssueBox.destroy_all_children();

        if (this._recentIssues.length === 0)
            return;

        this._recentIssueBox.add_child(new St.Label({
            text: this._('Recently worked issues'),
            style: 'font-weight: bold; margin-bottom: 5px;',
        }));

        for (const recent of this._recentIssues) {
            const item = new St.Button({
                style_class: 'popup-menu-item',
                can_focus: true,
                track_hover: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
            });

            const box = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });

            box.add_child(new St.Label({
                text: `#${recent.issue.iid} - ${recent.issue.title}`,
                x_align: Clutter.ActorAlign.START,
                x_expand: true,
            }));

            box.add_child(new St.Label({
                text: recent.project.path_with_namespace,
                style: 'font-size: 11px; opacity: 170;',
                x_align: Clutter.ActorAlign.START,
                x_expand: true,
            }));

            item.set_child(box);
            item.connect('clicked', () => {
                this._onSelected(recent.project, recent.issue);
                this.close();
            });

            this._recentIssueBox.add_child(item);
        }
    }

    _selectIssue(issue, widget) {
        this._selectedIssue = issue;

        // Highlight selected issue
        if (this._selectedIssueWidget)
            this._selectedIssueWidget.remove_style_pseudo_class('active');
        this._selectedIssueWidget = widget;
        widget.add_style_pseudo_class('active');
    }

    _createLoadingOverlay() {
        // Wrapper: fills the list area, holds both the bg overlay and the spinner
        let wrapper = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Background overlay
        wrapper._bg = new St.Widget({
            style_class: 'popup-menu-content',
            opacity: 200,
            x_expand: true,
            y_expand: true,
        });
        wrapper.add_child(wrapper._bg);

        // Spinner + label centered on top
        let content = new St.BoxLayout({
            vertical: false,
            style: 'padding: 8px;',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        wrapper._spinner = new Animation.Spinner(16);
        content.add_child(wrapper._spinner);

        wrapper._label = new St.Label({
            style: 'font-style: italic; margin-left: 8px;',
            y_align: Clutter.ActorAlign.CENTER
        });
        content.add_child(wrapper._label);

        wrapper.add_child(content);

        wrapper.hide();
        return wrapper;
    }

    _showOverlay(overlay, text) {
        overlay._label.text = text;
        // If already visible, just update the text
        if (overlay.visible) return;
        if (overlay._delayId) {
            GLib.source_remove(overlay._delayId);
            overlay._delayId = null;
        }
        overlay._delayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            overlay._delayId = null;
            overlay.show();
            overlay._spinner.play();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hideOverlay(overlay) {
        if (overlay._delayId) {
            GLib.source_remove(overlay._delayId);
            overlay._delayId = null;
        }
        overlay._spinner.stop();
        overlay.hide();
    }

    _onSelect() {
        if (!this._selectedProject || !this._selectedIssue) {
            Main.notify(this._('GitLab Time Tracking'), this._('Please select a project and an issue'));
            return;
        }

        this._onSelected(this._selectedProject, this._selectedIssue);
        this.close();
    }

    destroy() {
        if (this._issueReloadId) {
            GLib.source_remove(this._issueReloadId);
            this._issueReloadId = null;
        }
        this._hideOverlay(this._projectLoadingOverlay);
        this._hideOverlay(this._issueLoadingOverlay);
        if (this._issueStateMenu) {
            this._issueStateMenu.destroy();
            this._issueStateMenu = null;
        }
        this._httpSession.abort();
        super.destroy();
    }
});
