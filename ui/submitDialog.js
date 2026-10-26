// Shell ModalDialog for editing the duration and comment before submitting time
// (§2.5, §2.14): live amount on the button, quick-adjust chips, inline validation.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {adjustDuration, formatHuman, parseGitLabDuration, roundToStep, toEditableDuration} from '../core/format.js';

const DEFAULT_STEP_MINUTES = 15;

export const SubmitDialog = GObject.registerClass(
class SubmitDialog extends ModalDialog.ModalDialog {
    /**
     * @param {{gettext: Function, project: object, issue: object, duration: string, comment?: string,
     *          roundingMinutes?: number, onSubmit: (duration: string, comment: string) => void}} params
     */
    _init({gettext, project, issue, duration, comment = '', roundingMinutes = DEFAULT_STEP_MINUTES, onSubmit}) {
        super._init({styleClass: 'timelogs-submit-dialog', destroyOnClose: true});
        const _ = gettext;
        this._ = gettext;
        this._onSubmit = onSubmit;
        this._rounding = Math.max(0, Math.floor(roundingMinutes));
        this._step = this._rounding > 0 ? this._rounding : DEFAULT_STEP_MINUTES;

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
            style_class: 'timelogs-numeric',
        });
        form.add_child(this._row(_('Time spent'), this._durationEntry));

        // Chips: "Round to 15m → 1h 30m", "−15m", "+15m".
        const chips = new St.BoxLayout({style_class: 'timelogs-chips'});
        this._roundChip = this._chip('', () => this._applyChip(seconds => roundToStep(seconds, this._step)));
        chips.add_child(this._roundChip);
        this._minusChip = this._chip(`−${this._step}m`, () => this._applyChip(seconds => adjustDuration(seconds, -this._step * 60)));
        chips.add_child(this._minusChip);
        this._plusChip = this._chip(`+${this._step}m`, () => this._applyChip(seconds => adjustDuration(seconds, this._step * 60)));
        chips.add_child(this._plusChip);
        form.add_child(this._indented(chips));

        const error = new St.BoxLayout({style_class: 'timelogs-error-row', visible: false});
        error.add_child(new St.Icon({icon_name: 'dialog-error-symbolic', style_class: 'popup-menu-icon', y_align: Clutter.ActorAlign.CENTER}));
        this._durationErrorLabel = new St.Label({text: _('Use a format like 1h 30m, 45m or 2h'), style_class: 'timelogs-error-label',
            y_align: Clutter.ActorAlign.CENTER});
        error.add_child(this._durationErrorLabel);
        this._durationError = this._indented(error);
        this._durationError.visible = false;
        form.add_child(this._durationError);

        this._commentEntry = new St.Entry({
            text: comment,
            hint_text: _('What did you do? (optional)'),
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

    /** Aligns a widget under the entry column (past the label column). */
    _indented(child) {
        const row = new St.BoxLayout({style_class: 'timelogs-submit-row', x_expand: true});
        row.add_child(new St.Widget({style_class: 'timelogs-submit-label'}));
        row.add_child(child);
        return row;
    }

    _chip(text, onClick) {
        const chip = new St.Button({label: text, style_class: 'button timelogs-chip', can_focus: true, accessible_name: text});
        chip.connect('clicked', () => onClick());
        return chip;
    }

    _applyChip(transform) {
        const seconds = parseGitLabDuration(this._durationEntry.get_text());
        if (seconds === null)
            return;
        this._durationEntry.set_text(toEditableDuration(transform(seconds)));
    }

    _validate() {
        const _ = this._;
        const seconds = parseGitLabDuration(this._durationEntry.get_text());
        const valid = seconds !== null;
        this._durationError.visible = !valid;
        this._submitButton.reactive = valid;
        this._submitButton.can_focus = valid;
        if (valid)
            this._submitButton.remove_style_pseudo_class('insensitive');
        else
            this._submitButton.add_style_pseudo_class('insensitive');
        this._submitButton.label = valid ? _('Submit %s').format(formatHuman(seconds)) : _('Submit');

        const stepSeconds = this._step * 60;
        const showRound = valid && this._rounding > 0 && seconds % stepSeconds !== 0;
        this._roundChip.visible = showRound;
        if (showRound) {
            const rounded = formatHuman(roundToStep(seconds, this._step));
            this._roundChip.label = _('Round to %dm → %s').format(this._step, rounded);
            this._roundChip.accessible_name = this._roundChip.label;
        }
        for (const chip of [this._minusChip, this._plusChip]) {
            chip.reactive = valid;
            chip.can_focus = valid;
            if (valid)
                chip.remove_style_pseudo_class('insensitive');
            else
                chip.add_style_pseudo_class('insensitive');
        }
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
