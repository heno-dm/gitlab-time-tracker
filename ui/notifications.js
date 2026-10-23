// Transient notifications with optional action buttons (GNOME 46+ MessageTray API).
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

let source = null;
let sourceTitle = 'Timelogs';
let sourceIcon = null;

export function configureSource({title, gicon}) {
    sourceTitle = title ?? sourceTitle;
    sourceIcon = gicon ?? sourceIcon;
}

function getSource() {
    if (!source) {
        source = new MessageTray.Source({
            title: sourceTitle,
            icon: sourceIcon ?? new Gio.ThemedIcon({name: 'alarm-symbolic'}),
        });
        source.connect('destroy', () => {
            source = null;
        });
        Main.messageTray.add(source);
    }
    return source;
}

/**
 * @param {string} title
 * @param {string} body
 * @param {{label: string, callback: () => void}[]} actions
 */
export function notifyWithActions(title, body, actions = []) {
    try {
        const notification = new MessageTray.Notification({
            source: getSource(),
            title,
            body,
            isTransient: true,
        });
        for (const {label, callback} of actions)
            notification.addAction(label, callback);
        getSource().addNotification(notification);
        return notification;
    } catch (e) {
        console.debug(`Timelogs: falling back to Main.notify: ${e.message}`);
        Main.notify(title, body);
        return null;
    }
}

export function notify(title, body) {
    return notifyWithActions(title, body, []);
}
