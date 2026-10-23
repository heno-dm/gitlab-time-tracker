// Shell ModalDialog for editing the duration and comment before sending time.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {isValidGitLabDuration} from '../core/format.js';

export const SubmitDialog = GObject.registerClass(
class SubmitDialog extends ModalDialog.ModalDialog {
    /**
     * @param {{gettext: Function, project: object, issue: object, duration: string, comment?: string,
     *          onSubmit: (duration: string, comment: string) => void}} params
     */
    _init({gettext, project, issue, duration, comment = '', onSubmit}) {
        super._init({styleClass: 'timelogs-submit-dialog', destroyOnClose: true});
        const _ = gettext;
        this._onSubmit = onSubmit;

        const content = new Dialog.MessageDialogContent({
            title: _('Submit time'),
            description: `#${issue.iid} ${issue.title} · ${project.path_with_namespace}`,
        });
        this.contentLayout.add_child(content);

        const form = new St.BoxLayout({vertical: true, style_class: 'timelogs-submit-form'});
        content.add_child(form);

        this._durationEntry = new St.Entry({
            text: duration,
            hint_text: _('For example: 1h 30m'),
            can_focus: true,
            x_expand: true,
        });
        form.add_child(this._row(_('Time spent'), this._durationEntry));

        this._durationError = new St.Label({
            text: _('Enter a duration such as 1h 30m'),
            style_class: 'timelogs-error-label',
            visible: false,
        });
        form.add_child(this._durationError);

        this._commentEntry = new St.Entry({
            text: comment,
            hint_text: _('What did you do?'),
            can_focus: true,
            x_expand: true,
        });
        form.add_child(this._row(_('Comment'), this._commentEntry));

        this.setButtons([
            {label: _('Cancel'), action: () => this.close(), key: Clutter.KEY_Escape},
            {label: _('Submit'), action: () => this._submit(), default: true},
        ]);
        this._submitButton = this.buttonLayout.get_last_child();

        // Typing in the duration field replaces the prefilled value.
        this._durationEntry.clutter_text.connect('key-focus-in', () => {
            this._durationEntry.clutter_text.set_selection(0, -1);
        });
        this._durationEntry.clutter_text.connect('text-changed', () => this._validate());
        for (const entry of [this._durationEntry, this._commentEntry])
            entry.clutter_text.connect('activate', () => this._submit());

        this._validate();
        this.setInitialKeyFocus(this._commentEntry);
    }

    _row(labelText, entry) {
        const row = new St.BoxLayout({style_class: 'timelogs-submit-row', x_expand: true});
        const label = new St.Label({text: labelText, y_align: Clutter.ActorAlign.CENTER, style_class: 'timelogs-submit-label'});
        row.add_child(label);
        row.add_child(entry);
        entry.label_actor = label;
        return row;
    }

    _validate() {
        const valid = isValidGitLabDuration(this._durationEntry.get_text());
        this._durationError.visible = !valid;
        this._submitButton.reactive = valid;
        this._submitButton.can_focus = valid;
        if (valid)
            this._submitButton.remove_style_pseudo_class('insensitive');
        else
            this._submitButton.add_style_pseudo_class('insensitive');
        return valid;
    }

    _submit() {
        if (!this._validate()) {
            this._durationEntry.grab_key_focus();
            return;
        }
        const duration = this._durationEntry.get_text().trim();
        const comment = this._commentEntry.get_text().trim();
        this.close();
        this._onSubmit(duration, comment);
    }
});
