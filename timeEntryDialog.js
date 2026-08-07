import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

export const TimeEntryDialog = GObject.registerClass(
class TimeEntryDialog extends ModalDialog.ModalDialog {
    _init(gettext, project, issue, duration, onSend) {
        super._init({ styleClass: 'gitlab-time-entry-dialog' });

        this._ = gettext;
        this._onSend = onSend;

        const content = new St.BoxLayout({
            vertical: true,
            style: 'min-width: 460px; padding: 6px;',
        });

        content.add_child(new St.Label({
            text: this._('Stop and send time'),
            style_class: 'gitlab-selector-title',
            style: 'font-size: 16px; font-weight: bold; margin-bottom: 10px;',
        }));

        content.add_child(new St.Label({
            text: `${duration} ${this._('on issue')} #${issue.iid} - ${issue.title}`,
            style: 'margin-bottom: 10px;',
        }));

        content.add_child(new St.Label({
            text: this._('Comment about what you did'),
            style: 'font-weight: bold; margin-bottom: 5px;',
        }));

        this._commentEntry = new St.Entry({
            hint_text: this._('What did you do?'),
            can_focus: true,
            track_hover: true,
            style: 'margin-bottom: 10px;',
        });
        content.add_child(this._commentEntry);

        this.contentLayout.add_child(content);

        this.setButtons([
            {
                label: this._('Cancel'),
                action: () => this.close(),
                key: Clutter.KEY_Escape,
            },
            {
                label: this._('Send'),
                action: () => {
                    this._onSend(this._commentEntry.get_text().trim());
                    this.close();
                },
                default: true,
            },
        ]);

        this._commentEntry.grab_key_focus();
    }
});
