// Run with: gjs -m tests/regressions.js
// Exercise the production class methods without loading GNOME Shell or GTK UI.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const [testPath] = GLib.filename_from_uri(import.meta.url);
const root = GLib.path_get_dirname(GLib.path_get_dirname(testPath));
const tests = [];
const test = (name, run) => tests.push({name, run});
const assert = (condition, message = 'Assertion failed') => {
    if (!condition)
        throw new Error(message);
};
const equal = (actual, expected) => assert(JSON.stringify(actual) === JSON.stringify(expected),
    `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

function loadClass(filename, name, mocks = {}) {
    const [, bytes] = Gio.File.new_for_path(`${root}/${filename}`).load_contents(null);
    const source = new TextDecoder().decode(bytes);
    const start = source.indexOf('{', source.indexOf(`class ${name} extends`));
    const end = source.indexOf('\n});', start);
    assert(start >= 0 && end >= 0, `Cannot find ${name}`);
    // The class body is unchanged; only imports, inheritance and registration
    // are replaced so its control flow can be tested with deterministic mocks.
    const keys = Object.keys(mocks);
    return Function(...keys, `return (class ${name} ${source.slice(start, end + 2)});`)(...keys.map(key => mocks[key]));
}

function settings(values = {}) {
    return {
        values: {'gitlab-url': 'https://gitlab.example', 'gitlab-token': 'token',
            'issue-filter-assignee': '', 'issue-filter-search': '', 'issue-filter-labels': '',
            'issue-filter-state': 'opened', ...values},
        get_string(key) { return this.values[key] || ''; },
        set_string(key, value) { this.values[key] = value; },
        get_boolean(key) { return Boolean(this.values[key]); },
    };
}

function http() {
    const pending = [];
    const Soup = {Message: {new(method, url) {
        return {method, url, status_code: 200, request_headers: {append() {}},
            response_headers: {get_one() { return ''; }}};
    }}};
    const session = {
        send_and_read_async(message, _priority, _cancel, callback) {
            pending.push({message, callback});
        },
        send_and_read_finish(result) {
            if (result.error)
                throw result.error;
            return {get_data: () => new TextEncoder().encode(JSON.stringify(result.data))};
        },
    };
    const respond = (index, data, status = 200, nextPage = '') => {
        const {message, callback} = pending[index];
        message.status_code = status;
        message.response_headers.get_one = () => nextPage;
        callback(session, {data});
    };
    return {Soup, session, pending, respond};
}

function selector(values = {}) {
    const network = http();
    const timeouts = [];
    const Class = loadClass('selectorWindow.js', 'SelectorWindow', {
        _: text => text, Soup: network.Soup,
        GLib: {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, source_remove() {},
            timeout_add(_priority, _delay, callback) { timeouts.push(callback); return timeouts.length; }},
        getProjectsCache: () => [], setProjectsCache(_settings, projects) { network.cached = projects; },
    });
    const instance = Object.create(Class.prototype);
    Object.assign(instance, {_settings: settings(values), _httpSession: network.session,
        _closed: false, _issueRequestSerial: 0, _issuePerPage: 100, _issues: [],
        _currentUser: null, _currentUserError: null, _issueReloadId: null,
        _issueStatusLabel: {}, _projectStatusLabel: {}, _loadMoreButton: {}, _selectButton: {},
        _updateIssueList() { this._selectedIssue = null; this._selectButton.sensitive = false; },
        _updateProjectList() {}, _selectDefaultProject() {},
    });
    return {instance, ...network, timeouts, get cached() { return network.cached; }};
}

function indicator(values = {}) {
    const network = http();
    const clock = {seconds: 10000};
    const dialogs = [];
    const notices = [];
    const Class = loadClass('extension.js', 'GitLabIssuesIndicator', {
        Soup: network.Soup, GLib: {PRIORITY_DEFAULT: 0},
        Date: {now: () => clock.seconds * 1000},
        Main: {notify(...args) { notices.push(args); }},
        serializeProject: project => project, serializeIssue: issue => issue,
        getDefaultProject: () => ({id: 1}), addRecentIssue() {},
        TimeEntryDialog: class {
            constructor(_gettext, _project, _issue, duration, onSend) {
                this.duration = duration;
                this.send = onSend;
                dialogs.push(this);
            }
            connect(_signal, callback) { this.onClosed = callback; }
            open() { return true; }
            destroy() {}
        },
    });
    const instance = Object.create(Class.prototype);
    Object.assign(instance, {_settings: settings(values), _httpSession: network.session,
        _: text => text, _timerRunning: true, _timerPaused: false, _elapsedSeconds: 3600,
        _timerStartTimestamp: 6400, _sendingTime: false, _destroyed: false,
        _selectedProject: {id: 1}, _selectedIssue: {iid: 2},
        _pauseButton: {label: {set_text() {}}}, _timeEntryDialog: null,
        _updateButtonVisibility() {}, _updateIcon() {}, _updateTimerDisplay() {},
        _removeTimerSource() {}, _startTimerSource() {},
    });
    return {instance, ...network, clock, dialogs, notices};
}

test('failed sends retain the paused timer; retry resets only after success', () => {
    for (const status of [400, 401, 403, 500]) {
        const {instance: timer, dialogs, pending, respond} = indicator();
        timer._stopTimer();
        assert(timer._timerPaused);
        equal(dialogs[0].duration, '1h');
        timer._stopTimer();
        equal(dialogs.length, 1);
        dialogs[0].send('1h', 'work');
        dialogs[0].onClosed();
        assert(timer._sendingTime);
        timer._stopTimer();
        timer._pauseTimer();
        timer._cancelTimer();
        assert(timer._timerRunning && timer._timerPaused);
        equal(pending.length, 1);
        equal(timer._elapsedSeconds, 3600);
        respond(0, {}, status);
        assert(!timer._sendingTime && timer._timerRunning && timer._timerPaused);
        equal(JSON.parse(timer._settings.get_string('timer-state')).elapsedSeconds, 3600);
        timer._stopTimer();
        dialogs[1].send('1h', 'retry');
        respond(1, {}, 201);
        assert(!timer._timerRunning && !timer._sendingTime);
        equal(timer._elapsedSeconds, 0);
    }
});

test('network and synchronous setup failures keep the session retryable', () => {
    const {instance: timer, dialogs, session, pending} = indicator();
    timer._stopTimer();
    dialogs[0].send('1h', '');
    pending[0].callback(session, {error: new Error('offline')});
    assert(!timer._sendingTime && timer._timerPaused && timer._timerRunning);
    equal(timer._elapsedSeconds, 3600);
    session.send_and_read_async = () => { throw new Error('setup failed'); };
    timer._sendTimeToGitLab('1h', '');
    assert(!timer._sendingTime && timer._timerRunning);
    equal(timer._elapsedSeconds, 3600);
});

test('an entry dialog keeps the timer frozen and releases its guard on close', () => {
    const {instance: timer, dialogs} = indicator();
    timer._stopTimer();
    timer._pauseTimer();
    timer._cancelTimer();
    assert(timer._timerRunning && timer._timerPaused);
    dialogs[0].onClosed();
    timer._pauseTimer();
    assert(!timer._timerPaused);
});

test('a failed modal grab does not block future send dialogs', () => {
    const {instance: timer, dialogs} = indicator();
    timer._stopTimer();
    const prototype = Object.getPrototypeOf(dialogs[0]);
    prototype.open = () => false;
    dialogs[0].onClosed();
    timer._stopTimer();
    equal(timer._timeEntryDialog, null);
    assert(timer._timerPaused);
    prototype.open = () => true;
    timer._stopTimer();
    equal(dialogs.length, 3);
});

test('late submission callbacks do not mutate a destroyed indicator', () => {
    const {instance: timer, dialogs, respond} = indicator();
    timer._stopTimer();
    dialogs[0].send('1h', '');
    timer._destroyed = true;
    respond(0, {}, 201);
    equal(timer._elapsedSeconds, 3600);
});

test('active and paused sessions reject late issue selections', () => {
    for (const paused of [false, true]) {
        const {instance: timer, notices} = indicator();
        timer._timerPaused = paused;
        timer._setSelectedIssue({id: 3}, {iid: 4});
        timer._openIssueSelector();
        equal(timer._selectedProject.id, 1);
        equal(timer._selectedIssue.iid, 2);
        equal(timer._elapsedSeconds, 3600);
        equal(notices.length, 2);
    }
});

test('restore adds only saved active downtime, not earlier pauses', () => {
    const {instance: timer, clock} = indicator({'resume-on-unlock': true, 'count-time-when-locked': true});
    timer._pauseTimer();
    clock.seconds += 3600;
    timer._pauseTimer();
    timer._saveTimerState();
    clock.seconds += 60;
    timer._restoreTimerState();
    equal(timer._elapsedSeconds, 3660);
    timer._saveTimerState();
    clock.seconds += 60;
    timer._restoreTimerState();
    equal(timer._elapsedSeconds, 3720);
});

test('paused, legacy and clock-rollback states never gain phantom downtime', () => {
    for (const state of [
        {paused: true, savedAt: 9000}, {paused: false}, {paused: false, savedAt: 11000},
    ]) {
        const {instance: timer} = indicator({'resume-on-unlock': true, 'count-time-when-locked': true});
        timer._settings.set_string('timer-state', JSON.stringify({running: true, elapsedSeconds: 600,
            startTimestamp: 100, project: {id: 1}, issue: {iid: 2}, ...state}));
        timer._restoreTimerState();
        equal(timer._elapsedSeconds, 600);
    }
});

test('restore respects automatic resume and locked-time preferences', () => {
    for (const resume of [false, true]) {
        const {instance: timer, clock} = indicator({'resume-on-unlock': resume, 'count-time-when-locked': false});
        timer._saveTimerState();
        clock.seconds += 3600;
        timer._restoreTimerState();
        equal(timer._elapsedSeconds, 3600);
        equal(timer._timerPaused, !resume);
    }
});

test('out-of-order project and filter responses cannot overwrite current issues', () => {
    const {instance: picker, respond} = selector();
    picker._selectProject({id: 1});
    picker._selectProject({id: 2});
    respond(1, [{iid: 20, project_id: 2}]);
    respond(0, [{iid: 10, project_id: 1}]);
    equal(picker._issues, [{iid: 20, project_id: 2}]);
    picker._reloadIssues();
    picker._settings.set_string('issue-filter-search', 'new search');
    picker._reloadIssues();
    respond(3, [{iid: 30, project_id: 2}]);
    respond(2, [], 500);
    equal(picker._issues, [{iid: 30, project_id: 2}]);
    assert(!picker._issueLoading);
});

test('debouncing invalidates pending pagination immediately', () => {
    const {instance: picker, respond, timeouts} = selector();
    picker._selectProject({id: 1});
    respond(0, Array.from({length: 100}, (_unused, iid) => ({iid})));
    picker._loadMoreIssues();
    picker._scheduleIssueReload();
    respond(1, [{iid: 101}]);
    equal(picker._issues, []);
    assert(!picker._selectButton.sensitive && !picker._loadMoreButton.sensitive);
    timeouts[0]();
    respond(2, [{iid: 200}]);
    equal(picker._issues, [{iid: 200}]);
});

test('issue queries use ascending board position on every page and preserve filters', () => {
    const {instance: picker} = selector({'issue-filter-state': 'closed',
        'issue-filter-assignee': 'alice', 'issue-filter-search': 'fix & test',
        'issue-filter-labels': 'doing,bug'});
    for (const page of [1, 2]) {
        const params = Object.fromEntries(picker._buildIssueQuery(page).split('&').map(pair =>
            pair.split('=').map(value => decodeURIComponent(value))));
        equal(params, {state: 'closed', order_by: 'relative_position', sort: 'asc',
            per_page: '100', page: String(page), search: 'fix & test', in: 'title,description',
            assignee_username: 'alice', labels: 'doing,bug'});
    }
});

test('issue pagination preserves board order rather than sorting by issue ID', () => {
    const {instance: picker, pending, respond} = selector();
    picker._selectProject({id: 1});
    const firstPage = Array.from({length: 100}, (_unused, index) => ({iid: 500 - index}));
    respond(0, firstPage);
    picker._loadMoreIssues();
    for (const {message} of pending) {
        assert(message.url.includes('order_by=relative_position'));
        assert(message.url.includes('sort=asc'));
    }
    const secondPage = [{iid: 2}, {iid: 1000}, {iid: 1}];
    respond(1, secondPage);
    equal(picker._issues, firstPage.concat(secondPage));
});

test('project pagination caches all pages only after completion', () => {
    const network = selector();
    network.instance._loadProjects();
    network.respond(0, [{id: 1}], 200, '2');
    assert(!network.cached);
    assert(network.pending[1].message.url.endsWith('&page=2'));
    network.respond(1, [{id: 2}], 200, '3');
    assert(network.pending[2].message.url.endsWith('&page=3'));
    network.respond(2, [{id: 3}]);
    equal(network.cached, [{id: 1}, {id: 2}, {id: 3}]);
    equal(network.instance._projects, network.cached);
});

test('failed project pagination does not cache a partial list', () => {
    const network = selector();
    network.instance._loadProjects();
    network.respond(0, [{id: 1}], 200, '2');
    network.respond(1, {}, 500);
    assert(!network.cached);
});

test('me filter waits for user identity then reloads with the assignee', () => {
    const {instance: picker, pending, respond} = selector({'issue-filter-assignee': 'me'});
    picker._loadCurrentUser();
    picker._selectProject({id: 1});
    equal(pending.length, 1);
    equal(picker._issueStatusLabel.label, 'Loading current user...');
    respond(0, {username: 'alice'});
    equal(pending.length, 2);
    assert(pending[1].message.url.includes('assignee_username=alice'));
});

test('failed user lookup does not silently remove the me filter', () => {
    const {instance: picker, pending, respond} = selector({'issue-filter-assignee': 'me'});
    picker._loadCurrentUser();
    picker._selectProject({id: 1});
    respond(0, {}, 401);
    equal(pending.length, 1);
    equal(picker._issueStatusLabel.label, 'Error: 401');
    picker._settings.set_string('issue-filter-assignee', '');
    picker._reloadIssues();
    equal(pending.length, 2);
});

function report() {
    const Class = loadClass('reportWindow.js', 'ReportWindow', {_: text => text});
    const instance = Object.create(Class.prototype);
    const pending = [];
    Object.assign(instance, {_reportRequestId: 0, _selectedProject: {id: 1},
        _currentYear: 2026, _currentMonth: 9, _reportData: {totalSeconds: 3600}, _reportReady: true,
        _exportButtons: [{sensitive: true}, {sensitive: true}], _chartBox: {}, _detailBox: {},
        _statusLabel: {}, _clearBox() {}, _resetLog() {}, _log() {},
        _graphql(_query, variables, success, error) { pending.push({variables, success, error}); },
        _selectedAuthor: '', _categoryEntry: {get_text: () => ''},
        _updateChart() {}, _updateDetails() {},
    });
    return {instance, pending};
}

test('report reload clears old export data and filters cannot expose partial pages', () => {
    const {instance: window, pending} = report();
    window._loadReportData();
    equal(window._reportData, null);
    assert(window._exportButtons.every(button => !button.sensitive));
    pending[0].success({timelogs: {nodes: [], pageInfo: {hasNextPage: true, endCursor: 'next'}}});
    window._processReportData();
    equal(window._reportData, null);
    pending[1].success({timelogs: {nodes: [], pageInfo: {hasNextPage: false}}});
    equal(window._reportData.totalSeconds, 0);
    assert(window._exportButtons.every(button => button.sensitive));
});

test('failed reports and stale callbacks cannot enable exports', () => {
    const {instance: window, pending} = report();
    window._loadReportData();
    window._currentMonth--;
    window._loadReportData();
    pending[0].success({timelogs: {nodes: [], pageInfo: {hasNextPage: false}}});
    equal(window._reportData, null);
    pending[1].error('offline');
    window._processReportData();
    window._exportMarkdown();
    window._exportCSV();
    equal(window._reportData, null);
    assert(window._exportButtons.every(button => !button.sensitive));
});

let failures = 0;
for (const {name, run} of tests) {
    try {
        run();
        print(`PASS ${name}`);
    } catch (error) {
        failures++;
        printerr(`FAIL ${name}: ${error.message}\n${error.stack}`);
    }
}
print(`${tests.length - failures}/${tests.length} regression checks passed`);
if (failures)
    throw new Error(`${failures} regression checks failed`);
