import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {getDefaultProject, setDefaultProject} from './state.js';

export default class GitLabIssuesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Create a preferences page
        const page = new Adw.PreferencesPage();
        window.add(page);

        // Create a preferences group
        const group = new Adw.PreferencesGroup({
            title: _('GitLab Configuration'),
            description: _('Configure your GitLab server and access token'),
        });
        page.add(group);

        // GitLab URL setting
        const urlRow = new Adw.EntryRow({
            title: _('GitLab Server URL'),
            text: settings.get_string('gitlab-url'),
        });
        urlRow.set_tooltip_text(_('Include the protocol, for example https://gitlab.com. HTTPS is recommended.'));
        urlRow.connect('changed', (widget) => {
            settings.set_string('gitlab-url', widget.get_text().trim().replace(/\/+$/, ''));
        });
        group.add(urlRow);

        // GitLab Token setting
        const tokenRow = new Adw.PasswordEntryRow({
            title: _('Access Token'),
        });
        tokenRow.set_text(settings.get_string('gitlab-token'));
        tokenRow.connect('changed', (widget) => {
            settings.set_string('gitlab-token', widget.get_text());
        });
        group.add(tokenRow);

        const defaultProjectGroup = new Adw.PreferencesGroup({
            title: _('Default Project'),
            description: _('The first selected project is used as the default project for issue selection.'),
        });
        page.add(defaultProjectGroup);

        const defaultProjectRow = new Adw.ActionRow({
            title: _('Default project'),
        });
        const updateDefaultProjectRow = () => {
            const project = getDefaultProject(settings);
            defaultProjectRow.set_subtitle(project?.path_with_namespace || _('Not set yet'));
        };
        updateDefaultProjectRow();

        const clearDefaultProjectButton = new Gtk.Button({
            label: _('Clear'),
            valign: Gtk.Align.CENTER,
        });
        clearDefaultProjectButton.connect('clicked', () => {
            setDefaultProject(settings, null);
            updateDefaultProjectRow();
        });
        defaultProjectRow.add_suffix(clearDefaultProjectButton);
        defaultProjectGroup.add(defaultProjectRow);

        // Timer configuration group
        const timerGroup = new Adw.PreferencesGroup({
            title: _('Timer Configuration'),
            description: _('Configure timer behavior after screen lock, logout or restart'),
        });
        page.add(timerGroup);

        // Resume on unlock setting
        const resumeOnUnlockRow = new Adw.SwitchRow({
            title: _('Resume automatically after unlock'),
            subtitle: _('Automatically resume the timer when the screen is unlocked'),
        });
        resumeOnUnlockRow.set_active(settings.get_boolean('resume-on-unlock'));
        timerGroup.add(resumeOnUnlockRow);

        // Count time when locked setting
        const countTimeWhenLockedRow = new Adw.SwitchRow({
            title: _('Count elapsed time when locked'),
            subtitle: _('Count time elapsed during lock, logout or shutdown'),
        });
        countTimeWhenLockedRow.set_active(settings.get_boolean('count-time-when-locked'));
        countTimeWhenLockedRow.set_sensitive(settings.get_boolean('resume-on-unlock'));
        timerGroup.add(countTimeWhenLockedRow);

        // Connect signals for interdependency
        resumeOnUnlockRow.connect('notify::active', (widget) => {
            const isActive = widget.get_active();
            settings.set_boolean('resume-on-unlock', isActive);
            countTimeWhenLockedRow.set_sensitive(isActive);
        });

        countTimeWhenLockedRow.connect('notify::active', (widget) => {
            settings.set_boolean('count-time-when-locked', widget.get_active());
        });

        // Keyboard shortcuts configuration group
        const shortcutsGroup = new Adw.PreferencesGroup({
            title: _('Keyboard Shortcuts'),
            description: _('Use accelerator syntax such as Super+Alt+T. Leave empty to disable a shortcut.'),
        });
        page.add(shortcutsGroup);

        this._addShortcutRow(shortcutsGroup, settings, 'toggle-timer-shortcut', _('Start, pause, or resume timer'));
        this._addShortcutRow(shortcutsGroup, settings, 'stop-send-shortcut', _('Stop and send time'));
        this._addShortcutRow(shortcutsGroup, settings, 'cancel-timer-shortcut', _('Cancel timer'));
        this._addShortcutRow(shortcutsGroup, settings, 'select-issue-shortcut', _('Select project and issue'));
        this._addShortcutRow(shortcutsGroup, settings, 'monthly-report-shortcut', _('Open monthly report'));

        // Reports configuration group
        const reportsGroup = new Adw.PreferencesGroup({
            title: _('Reports Configuration'),
            description: _('Configure filters for monthly reports'),
        });
        page.add(reportsGroup);

        // Report tags filter setting
        const tagsFilterRow = new Adw.EntryRow({
            title: _('Tags included in reports'),
        });
        tagsFilterRow.set_text(settings.get_string('report-tags-filter'));
        tagsFilterRow.connect('changed', (widget) => {
            settings.set_string('report-tags-filter', widget.get_text());
        });
        reportsGroup.add(tagsFilterRow);

        // Help text for tags filter
        const tagsInfoLabel = new Gtk.Label({
            label: _('Leave empty to display all tags.\n' +
                   'Otherwise, enter a comma-separated list of tags or regular expressions.\n' +
                   'Examples:\n' +
                   '  • "Corrective Maintenance,Preventive Maintenance"\n' +
                   '  • "^Maintenance.*$" (all tags starting with "Maintenance")\n' +
                   '  • "Bug,^Feature.*$"\n' +
                   '\nIssues without these tags will appear as "Other" in reports.'),
            wrap: true,
            xalign: 0,
        });
        tagsInfoLabel.add_css_class('dim-label');

        const tagsInfoRow = new Adw.ActionRow();
        tagsInfoRow.set_child(tagsInfoLabel);
        reportsGroup.add(tagsInfoRow);

        // Information group
        const infoGroup = new Adw.PreferencesGroup({
            title: _('Information'),
        });
        page.add(infoGroup);

        const infoLabel = new Gtk.Label({
            label: _('To create a personal access token:\n' +
                   '1. Go to your GitLab profile\n' +
                   '2. Settings → Access Tokens\n' +
                   '3. Create a new token with "api" permissions\n' +
                   '4. Copy the token and paste it above'),
            wrap: true,
            xalign: 0,
        });
        infoLabel.add_css_class('dim-label');

        const infoRow = new Adw.ActionRow();
        infoRow.set_child(infoLabel);
        infoGroup.add(infoRow);
    }

    _addShortcutRow(group, settings, key, title) {
        const row = new Adw.EntryRow({ title });
        const shortcuts = settings.get_strv(key);
        row.set_text(shortcuts.length > 0 ? shortcuts[0] : '');
        row.connect('changed', (widget) => {
            const value = widget.get_text().trim();
            if (value === '') {
                settings.set_strv(key, []);
            } else if (this._isValidShortcut(value)) {
                settings.set_strv(key, [value]);
            }
        });
        group.add(row);
    }

    _isValidShortcut(shortcut) {
        try {
            const parsed = Gtk.accelerator_parse(shortcut);
            let keyval;
            let modifiers;

            if (parsed.length === 3) {
                if (!parsed[0])
                    return false;
                keyval = parsed[1];
                modifiers = parsed[2];
            } else {
                keyval = parsed[0];
                modifiers = parsed[1];
            }

            return keyval !== 0 && Gtk.accelerator_valid(keyval, modifiers);
        } catch (e) {
            return false;
        }
    }
}
