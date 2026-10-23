// Optional GTK smoke test: requires a graphical display, never uses real settings or GitLab.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import {getDefaultProject, getWorkSessions, serializeProject, serializeIssue} from '../state.js';

Gtk.init();
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const [path] = GLib.filename_from_uri(import.meta.url);
const root = GLib.path_get_dirname(GLib.path_get_dirname(path));
const [, bytes] = Gio.File.new_for_path(`${root}/selectorWindow.js`).load_contents(null);
const source = new TextDecoder().decode(bytes);
const start = source.indexOf('class SelectorWindow extends');
const end = source.indexOf('\n});', start);
const project = {id: 1, path_with_namespace: 'team/project', name: 'Project'};
const values = {'default-project': JSON.stringify(project), 'issue-filter-state': 'opened',
    'issue-filter-assignee': 'me', 'issue-filter-labels': 'doing', 'timer-state': '{}'};
const settings = {
    get_string: key => values[key] || '',
    set_string(key, value) { values[key] = value; },
};
const dependencies = {Gtk, Gdk, GObject, GLib, Gio,
    Soup: {Session: class { abort() {} }}, _: text => text,
    getSettings: () => settings, getDefaultProject, getWorkSessions,
    getProjectsCache: () => [], setProjectsCache() {}, serializeProject, serializeIssue,
};
const keys = Object.keys(dependencies);
const Class = Function(...keys, `return GObject.registerClass(${source.slice(start, end + 2)});`)(
    ...keys.map(key => dependencies[key]));
const requested = [];
Class.prototype._apiGet = (apiPath, onSuccess) => {
    requested.push(apiPath);
    if (apiPath === '/user')
        onSuccess({id: 42, username: 'alice'});
    else if (apiPath.startsWith('/projects?'))
        onSuccess([project]);
    else
        onSuccess([{iid: 9, title: 'First by board position'}, {iid: 3, title: 'Second by board position'}]);
};
const app = new Gtk.Application({application_id: 'io.github.heno_dm.SelectorSmokeTest', flags: Gio.ApplicationFlags.NON_UNIQUE});
app.register(null);
const window = new Class(app);
assert(!window._projectPane.visible, 'Default project should hide the project chooser');
assert(!requested.some(item => item.startsWith('/projects?')), 'Opening search should not load every project');
assert(window._selectedIssue.iid === 9, 'First result must be keyboard-selectable');
assert(window._selectButton.sensitive, 'Switch button should be enabled for the selected result');
window._issueSearchEntry.set_text('#142');
assert(!window._selectedIssue, 'Typing must invalidate the old result immediately');
assert(window._buildIssueQuery(1).includes('iids%5B%5D=142'), 'Number search should match IID');
window._reloadIssues();
window._issueList.select_row(window._issueList.get_row_at_index(1));
window._issueSearchEntry.emit('activate');
assert(JSON.parse(values['selection-state']).issue.iid === 3, 'Enter must send the highlighted issue');
assert(window._closed, 'Selection should close the window');

values['default-project'] = '{}';
const setup = new Class(app);
assert(setup._projectPane.visible, 'First use should show the project chooser');
setup._projectList.select_row(setup._projectList.get_row_at_index(0));
assert(!setup._projectPane.visible && setup._selectedProject.id === 1, 'Choosing a project should enter issue search');
setup.emit('close-request');
assert(setup._closed, 'Window-manager close requests must clean up pending work');

values['default-project'] = JSON.stringify(project);
values['timer-state'] = JSON.stringify({pausedSessions: [
    {project, issue: {iid: 7, title: 'Interrupted work'}, elapsedSeconds: 1800},
]});
const resume = new Class(app);
assert(resume._workBox.visible, 'Paused work should be accessible in the search window');
const scroll = resume._workBox.get_last_child();
const viewport = scroll.get_child();
const list = viewport instanceof Gtk.ListBox ? viewport : viewport.get_child();
list.get_row_at_index(0).emit('activate');
assert(JSON.parse(values['selection-state']).issue.iid === 7, 'Clicking paused work must resume that issue');
assert(resume._closed, 'Resuming paused work should close the window');
print('PASS GTK search window: setup, default project, immediate invalidation, keyboard selection, paused work and close cleanup');
