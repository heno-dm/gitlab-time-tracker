// Run with: gjs -m tests/run.js  (or `make test`).
// Imports the pure core/report modules directly; no GNOME Shell or GTK needed.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {formatClock, formatShort, isValidGitLabDuration, toGitLabDuration} from '../core/format.js';
import {GitLabClient, GitLabError, encodeParams, normalizeUrl, queueQuery, searchQuery} from '../core/gitlabClient.js';
import {Config} from '../core/config.js';
import {SessionStore, migrateState} from '../core/sessionStore.js';
import {policyFromLegacy, restoreRunning} from '../core/lockPolicy.js';
import {IssueSource, filterLocal, mergeResults, visibleQueue} from '../core/issueSource.js';
import {aggregate, authorsOf, entriesFromNodes, monthRange, parseTagFilters} from '../report/reportData.js';
import {exportFileName, toCsv, toMarkdown} from '../report/exporters.js';

const tests = [];
const test = (name, run) => tests.push({name, run});
const assert = (condition, message = 'Assertion failed') => {
    if (!condition)
        throw new Error(message);
};
const equal = (actual, expected, label = '') => assert(JSON.stringify(actual) === JSON.stringify(expected),
    `${label ? `${label}: ` : ''}Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const rejects = async (promise, predicate = () => true) => {
    try {
        await promise;
    } catch (e) {
        assert(predicate(e), `Unexpected rejection: ${e.message}`);
        return e;
    }
    throw new Error('Expected a rejection');
};

// ---- fakes -----------------------------------------------------------------

const PROJECT = {id: 1, path_with_namespace: 'team/project', name: 'Project', web_url: 'https://g/team/project'};
const OTHER = {id: 3, path_with_namespace: 'other/project', name: 'Other', web_url: 'https://g/other/project'};
const issue = (iid, title = `Issue ${iid}`, project = PROJECT) =>
    ({id: iid * 100, iid, title, project_id: project.id, web_url: `${project.web_url}/-/issues/${iid}`});

function fakeSettings(values = {}) {
    const defaults = {
        'settings-version': 0, 'gitlab-url': 'https://gitlab.example', 'gitlab-token': 'token',
        'tracked-projects': '[]', 'doing-labels': 'doing', 'lock-behaviour': 'pause', 'show-panel-time': true,
        'timer-state': '{}', 'queue-cache': '{}', 'cached-user': '{}', 'projects-cache': '{}',
        'report-tags-filter': '', 'report-view': 'categories', 'report-user': '', 'report-export-format': 'csv',
        'default-project': '{}', 'resume-on-unlock': false, 'count-time-when-locked': false,
    };
    const store = {...defaults, ...values};
    const handlers = [];
    return {
        values: store,
        get_string: key => String(store[key] ?? ''),
        set_string(key, value) { store[key] = value; this._emit(key); },
        get_boolean: key => Boolean(store[key]),
        set_boolean(key, value) { store[key] = value; this._emit(key); },
        get_int: key => Number(store[key] ?? 0),
        set_int(key, value) { store[key] = value; this._emit(key); },
        get_strv: key => store[key] ?? [],
        set_strv(key, value) { store[key] = value; this._emit(key); },
        connect(signal, callback) { handlers.push({signal, callback}); return handlers.length; },
        disconnect() {},
        _emit(key) { handlers.filter(h => h.signal === `changed::${key}`).forEach(h => h.callback()); },
    };
}

function storeWith(values = {}, timerState = null) {
    const settings = fakeSettings(timerState ? {...values, 'timer-state': JSON.stringify(timerState)} : values);
    const clock = {now: 10000};
    const changes = [];
    const store = new SessionStore({
        load: () => settings.get_string('timer-state'),
        save: json => settings.set_string('timer-state', json),
        clock: () => clock.now,
    });
    store.connect('changed', () => changes.push(store.snapshot()));
    const saved = () => JSON.parse(settings.get_string('timer-state'));
    return {store, clock, settings, changes, saved};
}

/** Fake GitLabClient: queued requests resolved manually, in any order. */
function fakeClient() {
    const pending = [];
    const client = {
        isConfigured: true,
        get(path, options = {}) {
            return new Promise((resolve, reject) => pending.push({method: 'GET', path, options, resolve, reject}));
        },
        post(path, params, options = {}) {
            return new Promise((resolve, reject) => pending.push({method: 'POST', path, params, options, resolve, reject}));
        },
        getAllPages(path, options = {}) {
            return new Promise((resolve, reject) => pending.push({method: 'GET', path, options, resolve, reject}));
        },
        graphql(query, variables, options = {}) {
            return new Promise((resolve, reject) => pending.push({method: 'GQL', variables, options, resolve, reject}));
        },
    };
    const respond = (index, data) => pending[index].resolve(data);
    const fail = (index, kind = 'http', status = 500) => pending[index].reject(new GitLabError(kind, `HTTP ${status}`, status));
    return {client, pending, respond, fail};
}

/** Fake Soup session for GitLabClient: records messages, lets tests answer them. */
function fakeSoup() {
    const sent = [];
    const session = {
        send_and_read_async(message, _priority, cancellable, callback) {
            sent.push({message, cancellable, callback});
        },
        send_and_read_finish(result) {
            if (result.error)
                throw result.error;
            return {get_data: () => new TextEncoder().encode(result.text)};
        },
    };
    const answer = (index, {status = 200, text = '{}', nextPage = '', error = null} = {}) => {
        const {message, callback} = sent[index];
        const responseHeaders = {get_one: name => name === 'X-Next-Page' ? nextPage : ''};
        message.get_status = () => status;
        message.get_response_headers = () => responseHeaders;
        callback(session, {text, error});
    };
    return {session, sent, answer};
}

const flush = async (rounds = 5) => {
    for (let i = 0; i < rounds; i++)
        await Promise.resolve();
};

// ---- format ----------------------------------------------------------------

test('format: clock, short and GitLab durations', () => {
    equal(formatClock(5025), '1:23:45');
    equal(formatClock(0), '0:00:00');
    equal(formatShort(5025), '1:23');
    equal(formatShort(59), '0:00');
    equal(toGitLabDuration(5025), '1h23m');
    equal(toGitLabDuration(3600), '1h');
    equal(toGitLabDuration(59), '1m');
    equal(toGitLabDuration(0), '1m');
    assert(isValidGitLabDuration('1h 30m') && isValidGitLabDuration('2d4h') && isValidGitLabDuration('45m'));
    assert(!isValidGitLabDuration('') && !isValidGitLabDuration('1.5h') && !isValidGitLabDuration('h'));
});

// ---- client ----------------------------------------------------------------

test('client: URL normalisation and query helpers', () => {
    equal(normalizeUrl(' https://gitlab.example/// '), 'https://gitlab.example');
    for (const bad of ['', 'gitlab.example', 'ftp://x'])
        assert((() => { try { normalizeUrl(bad); return false; } catch (e) { return e.kind === 'config'; } })(), bad);
    equal(encodeParams([['a', 'x y'], ['b', ''], ['c', null], ['labels', 'workflow::Doing,team A']]),
        'a=x%20y&labels=workflow%3A%3ADoing%2Cteam%20A');
    const queue = queueQuery({userId: 42, labels: 'workflow::Doing,team A'});
    assert(queue.includes('assignee_id=42') && queue.includes('state=opened'));
    assert(queue.includes('order_by=relative_position&sort=asc'));
    assert(queue.includes('labels=workflow%3A%3ADoing%2Cteam%20A'));
    assert(!queueQuery({userId: 1, labels: ''}).includes('labels='));
    assert(searchQuery('#142').includes('iids%5B%5D=142') && !searchQuery('#142').includes('search='));
    assert(!searchQuery('142').includes('state='), 'iid lookup is any-state');
    const text = searchQuery('fix & test');
    assert(text.includes('search=fix%20%26%20test') && text.includes('in=title%2Cdescription') && text.includes('state=opened'));
});

test('client: headers, pagination and error mapping', async () => {
    const {session, sent, answer} = fakeSoup();
    const client = new GitLabClient({url: 'https://gitlab.example/', token: 'tok', session});
    const headers = [];
    const pages = client.getAllPages('/projects?membership=true');
    await flush();
    assert(sent[0].message.get_uri().to_string().startsWith('https://gitlab.example/api/v4/projects?membership=true'));
    sent[0].message.request_headers.foreach((name, value) => headers.push([name, value]));
    assert(headers.some(([name, value]) => name === 'PRIVATE-TOKEN' && value === 'tok'));
    answer(0, {text: '[{"id":1}]', nextPage: '2'});
    await flush();
    assert(sent[1].message.get_uri().to_string().endsWith('&page=2'));
    answer(1, {text: '[{"id":2}]'});
    equal(await pages, [{id: 1}, {id: 2}]);

    const auth = client.get('/user');
    await flush();
    answer(2, {status: 401, text: '{"message":"401 Unauthorized"}'});
    const authError = await rejects(auth);
    equal([authError.kind, authError.status], ['auth', 401]);

    const missing = client.get('/x');
    await flush();
    answer(3, {status: 404, text: ''});
    equal((await rejects(missing)).kind, 'not-found');

    const offline = client.get('/user');
    await flush();
    answer(4, {error: new Error('Could not connect')});
    equal((await rejects(offline)).kind, 'network');

    const post = client.post('/projects/1/issues/2/add_spent_time', {duration: '1h 5m', summary: 'a&b'});
    await flush();
    const url = sent[5].message.get_uri().to_string();
    assert(url.includes('/projects/1/issues/2/add_spent_time?duration=1h%205m&summary=a%26b'), url);
    answer(5, {status: 201, text: '{"human_total_time_spent":"1h 5m"}'});
    equal((await post).human_total_time_spent, '1h 5m');

    const gql = client.graphql('query {}', {a: 1});
    await flush();
    answer(6, {text: '{"errors":[{"message":"bad"}]}'});
    equal((await rejects(gql)).kind, 'graphql');

    client.setCredentials({url: 'not a url', token: ''});
    equal((await rejects(client.get('/user'))).kind, 'config');
});

test('client: changing credentials cancels in-flight requests', async () => {
    const {session, sent, answer} = fakeSoup();
    const client = new GitLabClient({url: 'https://gitlab.example', token: 'tok', session});
    const request = client.get('/user');
    await flush();
    client.setCredentials({url: 'https://other.example', token: 'tok2'});
    assert(sent[0].cancellable.is_cancelled());
    answer(0, {error: new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'cancelled')});
    equal((await rejects(request)).kind, 'cancelled');
});

// ---- session store ---------------------------------------------------------

test('store: starting an issue runs it and pauses the previous active session', () => {
    const {store, clock, saved} = storeWith();
    store.start(PROJECT, issue(2));
    clock.now += 3600;
    store.start(PROJECT, issue(3, 'Interruption'));
    let snap = store.snapshot();
    equal([snap.active.issue.iid, snap.active.elapsedSeconds, snap.active.running], [3, 0, true]);
    equal(snap.paused.map(s => [s.issue.iid, s.elapsedSeconds, s.running]), [[2, 3600, false]]);
    clock.now += 300;
    store.start(PROJECT, issue(2));
    snap = store.snapshot();
    equal([snap.active.issue.iid, snap.active.elapsedSeconds], [2, 3600]);
    equal(snap.paused.map(s => [s.issue.iid, s.elapsedSeconds]), [[3, 300]]);
    equal(saved().version, 3);
    equal(saved().sessions.length, 2);
});

test('store: same issue resumes without duplicating; same IID in other project is independent', () => {
    const {store, clock} = storeWith();
    store.start(PROJECT, issue(2));
    clock.now += 100;
    store.pause();
    store.start(PROJECT, issue(2));
    let snap = store.snapshot();
    assert(snap.active.running && snap.paused.length === 0);
    equal(snap.active.elapsedSeconds, 100);
    store.start(OTHER, issue(2, 'Other issue', OTHER));
    snap = store.snapshot();
    equal([snap.active.project.id, snap.active.elapsedSeconds], [3, 0]);
    equal(snap.paused.map(s => [s.project.id, s.issue.iid]), [[1, 2]]);
    equal(store.size, 2);
});

test('store: only one running session; elapsed is timestamp-based across suspend', () => {
    const {store, clock} = storeWith();
    store.start(PROJECT, issue(1));
    store.start(PROJECT, issue(2));
    store.switchTo('1#1');
    const saved = JSON.parse(JSON.stringify(store.snapshot()));
    equal(saved.paused.filter(s => s.running).length, 0);
    clock.now += 86400; // laptop suspended for a day
    equal(store.snapshot().active.elapsedSeconds, 86400);
});

test('store: toggle pauses/resumes the active session or resumes the most recent paused one', () => {
    const {store, clock} = storeWith();
    equal(store.toggle(), false);
    store.start(PROJECT, issue(1));
    store.start(PROJECT, issue(2));
    assert(store.toggle());
    assert(!store.snapshot().active.running);
    assert(store.toggle());
    assert(store.snapshot().active.running);
    clock.now += 10;
    equal(store.beginSubmit('1#2').elapsedSeconds, 10);
    store.completeSubmit('1#2', true);
    equal(store.snapshot().active, null);
    assert(store.toggle());
    equal([store.snapshot().active.issue.iid, store.snapshot().active.running], [1, true]);
});

test('store: submit keeps the timer running, failure never loses time, success removes the session', () => {
    for (const status of [400, 401, 403, 500]) {
        const {store, clock} = storeWith();
        store.start(PROJECT, issue(2));
        clock.now += 3600;
        const submit = store.beginSubmit('1#2');
        equal(submit.elapsedSeconds, 3600);
        equal(store.beginSubmit('1#2'), null, 'second submit while sending');
        assert(store.isBusy() && store.snapshot().active.sending && store.snapshot().active.running);
        clock.now += 60;
        equal(store.discard('1#2'), null, 'sending session cannot be discarded');
        equal(store.switchTo('1#2'), false);
        store.completeSubmit('1#2', false);
        assert(!store.isBusy());
        equal(store.snapshot().active.elapsedSeconds, 3660, `after failure ${status}`);
        store.beginSubmit('1#2');
        store.completeSubmit('1#2', true);
        equal(store.size, 0);
        equal(store.snapshot().active, null);
    }
});

test('store: submitting a paused session leaves the running one alone; other sessions still switchable', () => {
    const {store, clock} = storeWith();
    store.start(PROJECT, issue(7));
    clock.now += 1200;
    store.start(PROJECT, issue(2));
    clock.now += 3600;
    const submit = store.beginSubmit('1#7');
    equal(submit.elapsedSeconds, 1200);
    assert(store.snapshot().active.running);
    store.start(OTHER, issue(9, 'Elsewhere', OTHER));
    equal(store.snapshot().active.key, '3#9', 'starting is not blocked by an unrelated submit');
    clock.now += 10;
    store.completeSubmit('1#7', true);
    equal(store.snapshot().paused.map(s => [s.key, s.elapsedSeconds]), [['1#2', 3600]]);
    equal(store.snapshot().active.elapsedSeconds, 10);
});

test('store: discard returns the session and undo restores it exactly', () => {
    const {store, clock} = storeWith();
    store.start(PROJECT, issue(1));
    clock.now += 100;
    store.start(PROJECT, issue(2));
    clock.now += 50;
    const discarded = store.discard('1#2');
    equal([discarded.key, discarded.accumulatedSeconds, discarded.runningSince], ['1#2', 0, 10100]);
    equal(store.snapshot().active, null);
    equal(store.snapshot().paused.map(s => s.key), ['1#1']);
    store.switchTo('1#1');
    clock.now += 25;
    assert(store.restoreDiscarded(discarded));
    const snap = store.snapshot();
    equal([snap.active.key, snap.active.running, snap.active.elapsedSeconds], ['1#2', true, 75], 'gap counts as running');
    equal(snap.paused.map(s => [s.key, s.running, s.elapsedSeconds]), [['1#1', false, 125]]);
    assert(!store.restoreDiscarded(discarded), 'cannot restore twice');
    // paused discard restores paused and keeps the active one running
    const pausedDiscard = store.discard('1#1');
    assert(pausedDiscard.runningSince === null);
    store.restoreDiscarded(pausedDiscard);
    equal(store.snapshot().active.key, '1#2');
    equal(store.snapshot().paused.map(s => s.key), ['1#1']);
});

test('store: v2 and v1 states migrate without losing time; invalid/duplicate entries are dropped', () => {
    const v2 = {version: 2, running: true, paused: true, elapsedSeconds: 1234, savedAt: 9000,
        project: PROJECT, issue: issue(2, 'Legacy'), pausedSessions: [
            null, {}, {project: {id: 4}, issue: {iid: 7, title: 'Paused'}, elapsedSeconds: 1200},
            {project: {id: 4}, issue: {iid: 7, title: 'Paused'}, elapsedSeconds: 1200},
            {project: {id: 4}, issue: {iid: 8, title: 'Bad'}, elapsedSeconds: -1},
            {project: PROJECT, issue: {iid: 2, title: 'Duplicate current'}, elapsedSeconds: 5},
        ]};
    const {store, saved} = storeWith({}, v2);
    const snap = store.snapshot();
    equal([snap.active.key, snap.active.elapsedSeconds, snap.active.running], ['1#2', 1234, false]);
    equal(snap.paused.map(s => [s.key, s.elapsedSeconds]), [['4#7', 1200]]);
    equal(saved().version, 2, 'nothing saved until a transition');
    store.pause();
    store.resume();
    equal(saved().version, 3);

    const v1 = storeWith({}, {running: true, paused: false, elapsedSeconds: 600, startTimestamp: 100,
        project: PROJECT, issue: issue(2)});
    equal([v1.store.snapshot().active.elapsedSeconds, v1.store.snapshot().active.running], [600, true]);
    const stopped = storeWith({}, {running: false, project: PROJECT, issue: issue(2), pausedSessions: [
        {project: {id: 4}, issue: {iid: 7, title: 'Paused'}, elapsedSeconds: 1200}]});
    equal(stopped.store.snapshot().active, null);
    equal(stopped.store.snapshot().paused.map(s => s.key), ['4#7']);
    const garbage = storeWith({'timer-state': 'not json'});
    equal(garbage.store.size, 0);
});

test('store: v3 restore enforces the single-running invariant and ignores unknown activeKey', () => {
    const {store} = storeWith({}, {version: 3, activeKey: 'nope', lastSeenAt: 9990, sessions: [
        {key: '1#1', project: PROJECT, issue: issue(1), accumulatedSeconds: 10, runningSince: 9900},
        {key: '1#2', project: PROJECT, issue: issue(2), accumulatedSeconds: 20, runningSince: null},
    ]});
    const snap = store.snapshot();
    equal(snap.active, null);
    equal(snap.paused.map(s => [s.key, s.running, s.elapsedSeconds]), [['1#1', false, 110], ['1#2', false, 20]]);
});

test('lock policy: pause, resume-on-unlock and keep-counting use lastSeenAt', () => {
    const session = {accumulatedSeconds: 600, runningSince: 9000};
    const pause = restoreRunning(session, {policy: 'pause', lastSeenAt: 9100, now: 10000});
    equal([pause.accumulatedSeconds, pause.runningSince], [700, null]);
    const resume = restoreRunning(session, {policy: 'resume-on-unlock', lastSeenAt: 9100, now: 10000});
    equal([resume.accumulatedSeconds, resume.runningSince], [700, 10000]);
    const keep = restoreRunning(session, {policy: 'keep-counting', lastSeenAt: 9100, now: 10000});
    equal([keep.accumulatedSeconds, keep.runningSince], [600, 9000]);
    const rollback = restoreRunning({accumulatedSeconds: 600, runningSince: 11000}, {policy: 'keep-counting', lastSeenAt: 11000, now: 10000});
    equal(rollback.runningSince, 10000, 'clock rollback never produces negative elapsed');
    const paused = restoreRunning({accumulatedSeconds: 5, runningSince: null}, {policy: 'resume-on-unlock', lastSeenAt: 1, now: 2});
    equal(paused.runningSince, null, 'paused sessions are never altered by restore');
    equal([policyFromLegacy({resumeOnUnlock: false, countTimeWhenLocked: true}),
        policyFromLegacy({resumeOnUnlock: true, countTimeWhenLocked: false}),
        policyFromLegacy({resumeOnUnlock: true, countTimeWhenLocked: true})],
    ['pause', 'resume-on-unlock', 'keep-counting']);
});

test('store: restore after lock/logout follows the policy; paused sessions untouched', () => {
    for (const [policy, expectedElapsed, running] of [['pause', 300, false], ['resume-on-unlock', 300, true], ['keep-counting', 1300, true]]) {
        const first = storeWith();
        first.store.start(PROJECT, issue(1));
        first.clock.now += 100;
        first.store.start(PROJECT, issue(2));
        first.clock.now += 300;
        first.store.heartbeat();
        first.clock.now += 1000; // downtime
        const second = storeWith({'timer-state': first.settings.get_string('timer-state')});
        second.clock.now = first.clock.now;
        second.store.applyLockPolicy(policy);
        const snap = second.store.snapshot();
        equal([snap.active.key, snap.active.elapsedSeconds, snap.active.running], ['1#2', expectedElapsed, running], policy);
        equal(snap.paused.map(s => [s.key, s.elapsedSeconds]), [['1#1', 100]], policy);
    }
});

test('store: v2 running timer uses savedAt as lastSeenAt and never gains phantom downtime', () => {
    for (const [state, policy, expected] of [
        [{paused: true, savedAt: 9000}, 'keep-counting', 600],
        [{paused: false}, 'keep-counting', 600],
        [{paused: false, savedAt: 11000}, 'keep-counting', 600],
        [{paused: false, savedAt: 9940}, 'keep-counting', 660],
        [{paused: false, savedAt: 9940}, 'resume-on-unlock', 600],
        [{paused: false, savedAt: 9940}, 'pause', 600],
    ]) {
        const {store} = storeWith({}, {running: true, elapsedSeconds: 600, startTimestamp: 100,
            project: PROJECT, issue: issue(2), ...state});
        store.applyLockPolicy(policy);
        equal(store.snapshot().active.elapsedSeconds, expected, JSON.stringify([state, policy]));
        if (state.paused)
            assert(!store.snapshot().active.running, 'explicitly paused work must not auto-resume');
    }
});

test('store: changed signal fires on transitions and heartbeat only saves', () => {
    const {store, changes, saved, clock} = storeWith();
    store.start(PROJECT, issue(1));
    equal(changes.length, 1);
    clock.now += 70;
    store.heartbeat();
    equal(changes.length, 1);
    equal(saved().lastSeenAt, 10070);
});

// ---- config ----------------------------------------------------------------

test('config: migration seeds tracked projects and lock behaviour, idempotently', () => {
    for (const [legacy, expected] of [
        [{'resume-on-unlock': false, 'count-time-when-locked': false}, 'pause'],
        [{'resume-on-unlock': false, 'count-time-when-locked': true}, 'pause'],
        [{'resume-on-unlock': true, 'count-time-when-locked': false}, 'resume-on-unlock'],
        [{'resume-on-unlock': true, 'count-time-when-locked': true}, 'keep-counting'],
    ]) {
        const settings = fakeSettings({...legacy, 'default-project': JSON.stringify(PROJECT)});
        const config = new Config(settings);
        assert(config.migrate());
        equal(config.lockBehaviour, expected);
        equal(config.trackedProjects.map(p => p.id), [1]);
        equal(settings.get_int('settings-version'), 3);
        config.lockBehaviour = 'keep-counting';
        config.trackedProjects = [OTHER];
        assert(!config.migrate(), 'second run is a no-op');
        equal(config.lockBehaviour, 'keep-counting');
        equal(config.trackedProjects.map(p => p.id), [3]);
    }
    const empty = new Config(fakeSettings({'default-project': '{}'}));
    empty.migrate();
    equal(empty.trackedProjects, []);
    const broken = new Config(fakeSettings({'default-project': 'garbage', 'tracked-projects': 'garbage'}));
    broken.migrate();
    equal(broken.trackedProjects, []);
});

test('config: caches are scoped to the server URL', () => {
    const settings = fakeSettings();
    const config = new Config(settings);
    config.cachedUser = {id: 5, username: 'jane', name: 'Jane'};
    config.queueCache = {user_id: 5, items: [{project: PROJECT, issue: issue(1)}]};
    config.projectsCache = [PROJECT, {bogus: true}];
    equal(config.cachedUser.username, 'jane');
    equal(config.queueCache.items.length, 1);
    equal(config.projectsCache.map(p => p.id), [1]);
    settings.set_string('gitlab-url', 'https://elsewhere.example/');
    equal(config.url, 'https://elsewhere.example');
    equal(config.cachedUser, null);
    equal(config.queueCache, null);
    equal(config.projectsCache, []);
});

test('config: token falls back to GSettings when libsecret cannot be used', async () => {
    const settings = fakeSettings({'gitlab-token': 'fallback', 'gitlab-url': ''});
    const config = new Config(settings);
    equal(await config.getToken(), 'fallback');
    config._secret = async () => null;
    await config.setToken('new-token');
    equal(settings.get_string('gitlab-token'), 'new-token');
    assert(config.tokenStorageWarning);
});

// ---- issue source ----------------------------------------------------------

function source(values = {}) {
    const settings = fakeSettings({'tracked-projects': JSON.stringify([PROJECT, OTHER]), ...values});
    const config = new Config(settings);
    const network = fakeClient();
    const issues = new IssueSource({client: network.client, config});
    return {issues, config, settings, ...network};
}

test('issues: queue query uses labels, assignee and board order per tracked project', async () => {
    const {issues, pending, respond, config} = source({'doing-labels': 'workflow::Doing,team A'});
    const refresh = issues.refreshQueue();
    await flush();
    equal(pending[0].path, '/user');
    respond(0, {id: 42, username: 'jane', name: 'Jane'});
    await flush();
    equal(pending.length, 3);
    for (const [index, project] of [[1, PROJECT], [2, OTHER]]) {
        const path = pending[index].path;
        assert(path.startsWith(`/projects/${project.id}/issues?`), path);
        assert(path.includes('assignee_id=42') && path.includes('order_by=relative_position&sort=asc'));
        assert(path.includes('labels=workflow%3A%3ADoing%2Cteam%20A') && path.includes('per_page=50'));
    }
    respond(2, [issue(9, 'Other first', OTHER)]);
    respond(1, [issue(2, 'Active'), issue(3, 'Second')]);
    const items = await refresh;
    equal(items.map(i => [i.project.id, i.issue.iid]), [[1, 2], [1, 3], [3, 9]], 'tracked-project order');
    equal(config.cachedUser.username, 'jane');
    equal(config.queueCache.items.length, 3);
    equal(issues.getCachedQueue().map(i => i.issue.iid), [2, 3, 9]);
    const fresh = source();
    equal(fresh.issues.getCachedQueue(), [], 'no cache before the first refresh');
    fresh.settings.set_string('queue-cache', config.settings.get_string('queue-cache'));
    equal(fresh.issues.getCachedQueue().map(i => i.issue.iid), [2, 3, 9], 'persisted cache survives restart');
});

test('issues: stale queue responses and failures never overwrite the latest queue', async () => {
    const {issues, pending, respond, fail} = source({'tracked-projects': JSON.stringify([PROJECT])});
    const first = issues.refreshQueue();
    await flush();
    respond(0, {id: 42});
    await flush();
    const second = issues.refreshQueue();
    await flush();
    assert(pending[1].options.cancellable.is_cancelled(), 'previous request cancelled');
    respond(2, [issue(9, 'Latest')]);
    respond(1, [issue(1, 'Stale')]);
    equal(await first, null);
    equal((await second).map(i => i.issue.iid), [9]);
    const third = issues.refreshQueue();
    await flush();
    fail(3, 'auth', 401);
    equal((await rejects(third)).kind, 'auth');
    equal(issues.getCachedQueue().map(i => i.issue.iid), [9], 'cache kept after failure');
});

test('issues: visible queue excludes tracked sessions and caps rows', () => {
    const {store} = storeWith();
    store.start(PROJECT, issue(2));
    const items = Array.from({length: 20}, (_, i) => ({project: PROJECT, issue: issue(i + 1), source: 'queue'}));
    const visible = visibleQueue(items, store);
    equal(visible.length, 15);
    assert(!visible.some(i => i.issue.iid === 2));
});

test('issues: search by text and #iid across projects, local matches first', async () => {
    const {issues, pending, respond, fail} = source();
    const text = issues.search('login');
    await flush();
    assert(pending[0].path.includes('search=login') && pending[0].path.includes('state=opened'));
    const stale = issues.search('login redirect');
    await flush();
    respond(2, [issue(203, 'Login redirect loop')]);
    respond(3, [issue(204, 'Login redirect', OTHER)]);
    respond(0, [issue(1, 'Stale')]);
    respond(1, []);
    equal(await text, null);
    equal((await stale).map(i => [i.project.id, i.issue.iid]), [[1, 203], [3, 204]]);

    const byIid = issues.search('#142');
    await flush();
    assert(pending[4].path.includes('iids%5B%5D=142') && !pending[4].path.includes('state='));
    respond(4, [issue(142)]);
    fail(5, 'not-found', 404);
    equal((await byIid).map(i => i.issue.iid), [142], 'partial failures still return results');
    const allFail = issues.search('zzz');
    await flush();
    fail(6);
    fail(7);
    equal((await rejects(allFail)).kind, 'http');
    equal(await issues.search('   '), []);

    const local = [{project: PROJECT, issue: issue(98, 'Update docs'), source: 'paused'},
        {project: PROJECT, issue: issue(150, 'API pagination'), source: 'queue'}];
    equal(filterLocal(local, 'doc').map(i => i.issue.iid), [98]);
    equal(filterLocal(local, '#150').map(i => i.issue.iid), [150]);
    equal(filterLocal(local, '15').map(i => i.issue.iid), []);
    equal(mergeResults(local, [{project: PROJECT, issue: issue(98)}, {project: PROJECT, issue: issue(7)}]).map(i => i.issue.iid),
        [98, 150, 7]);
});

test('issues: invalidate drops the cached user and projects after credential changes', async () => {
    const {issues, pending, respond, config} = source();
    const user = issues.currentUser();
    await flush();
    respond(0, {id: 1, username: 'a', name: 'A'});
    equal((await user).username, 'a');
    equal((await issues.currentUser()).username, 'a');
    equal(pending.length, 1, 'user is fetched once');
    issues.invalidate();
    const again = issues.currentUser();
    await flush();
    equal(pending.length, 2);
    respond(1, {id: 2, username: 'b', name: 'B'});
    equal((await again).username, 'b');
    // offline start uses the persisted user, but not after an auth failure
    const offline = source({'cached-user': JSON.stringify({url: config.url, id: 9, username: 'cached', name: 'C'})});
    const cached = offline.issues.currentUser();
    await flush();
    offline.fail(0, 'network', 0);
    equal((await cached).username, 'cached');
    const denied = source({'cached-user': JSON.stringify({url: config.url, id: 9, username: 'cached', name: 'C'})});
    const auth = denied.issues.currentUser();
    await flush();
    denied.fail(0, 'auth', 401);
    equal((await rejects(auth)).kind, 'auth');
});

test('issues: member projects come from the cache unless refreshed', async () => {
    const {issues, pending, respond} = source({'projects-cache': JSON.stringify({url: 'https://gitlab.example', projects: [PROJECT]})});
    equal((await issues.listMemberProjects()).map(p => p.id), [1]);
    equal(pending.length, 0);
    const refreshed = issues.listMemberProjects({refresh: true});
    await flush();
    assert(pending[0].path.includes('membership=true') && pending[0].path.includes('simple=true'));
    respond(0, [PROJECT, OTHER]);
    equal((await refreshed).map(p => p.id), [1, 3]);
});

// ---- report ----------------------------------------------------------------

const ENTRIES = entriesFromNodes([
    {id: 'gid://1', spentAt: '2026-10-03T10:00:00Z', timeSpent: 3600, user: {username: 'alice', name: 'Alice'},
        issue: {id: 'i1', iid: 1, title: 'Bug one', webUrl: 'u1', labels: {nodes: [{title: 'Bug'}, {title: 'Feature A'}]}}},
    {id: 'gid://2', spentAt: '2026-10-03T12:00:00Z', timeSpent: 1800, user: {username: 'bob', name: 'Bob'},
        issue: {id: 'i2', iid: 2, title: 'Chore', webUrl: 'u2', labels: {nodes: []}}},
    {id: 'gid://3', spentAt: '2026-10-20T12:00:00Z', timeSpent: 7200, user: {username: 'alice', name: 'Alice'},
        issue: {id: 'i3', iid: 3, title: 'Feature', webUrl: 'u3', labels: {nodes: [{title: 'Feature B'}]}}},
    {id: 'gid://4', spentAt: '2026-10-21T12:00:00Z', timeSpent: -600, user: null, issue: {id: 'i3', iid: 3, title: 'Feature', webUrl: 'u3', labels: {nodes: []}}},
    {id: 'gid://5', spentAt: '2026-10-21T12:00:00Z', timeSpent: 60, user: {username: 'bob', name: 'Bob'}, issue: null},
]);

test('report: tag filters, aggregation and authors', () => {
    equal(parseTagFilters(' Bug , ^Feature.*$ ,,').map(f => f.type), ['literal', 'regex']);
    equal(parseTagFilters(''), []);
    const all = aggregate(ENTRIES, {year: 2026, month: 9});
    equal(all.totalSeconds, 12600);
    equal(all.timeByLabel, {Bug: 3600, 'Feature A': 3600, 'No label': 1800, 'Feature B': 7200});
    equal([...all.timeByDay.entries()], [[3, 5400], [20, 7200]]);
    equal([all.issueCount, all.categoryCount], [3, 4]);
    const filtered = aggregate(ENTRIES, {tagFilters: parseTagFilters('Bug,^Feature.*$')});
    equal(filtered.timeByLabel, {Bug: 3600, 'Feature A': 3600, Other: 1800, 'Feature B': 7200});
    const alice = aggregate(ENTRIES, {author: 'alice', tagFilters: parseTagFilters('^Feature.*$')});
    equal(alice.timeByUserAndLabel, {alice: {'Feature A': 3600, 'Feature B': 7200}});
    equal(alice.totalSeconds, 10800);
    equal(authorsOf(ENTRIES), [{username: 'alice', name: 'Alice'}, {username: 'bob', name: 'Bob'}]);
    equal(monthRange(2026, 1), {startDate: '2026-02-01', endDate: '2026-02-28'});
});

test('report: CSV and Markdown exports are byte-compatible with the previous window', () => {
    const data = aggregate(ENTRIES, {tagFilters: parseTagFilters('Bug')});
    const options = {projectPath: 'team/project', monthLabel: 'October 2026'};
    equal(toCsv(data, options),
        '"Project","Month","User","Category","Time (hours)"\n' +
        '"team/project","October 2026","alice","Bug","1.00"\n' +
        '"team/project","October 2026","alice","Other","2.00"\n' +
        '"team/project","October 2026","bob","Other","0.50"\n' +
        '"team/project","October 2026","TOTAL","TOTAL","3.50"\n');
    equal(toMarkdown(data, options),
        '# Monthly Time Report - team/project\n\n' +
        '**Period:** October 2026\n' +
        '**Total time:** 3.50h\n\n' +
        '## Summary by category\n\n' +
        '- **Other:** 2.50h\n' +
        '- **Bug:** 1.00h\n\n' +
        '## Time by user and category\n\n' +
        '- **alice / Other:** 2.00h\n' +
        '- **alice / Bug:** 1.00h\n' +
        '- **bob / Other:** 0.50h\n');
    equal(exportFileName('team/project', 2026, 9, 'csv'), 'gitlab-report-team-project-2026-10.csv');
});

test('report: fetchTimelogs paginates with the cursor and skips nodes without issues', async () => {
    const {client, pending, respond} = fakeClient();
    const {fetchTimelogs} = await import('../report/reportData.js');
    const fetching = fetchTimelogs(client, 1, 2026, 9);
    await flush();
    equal(pending[0].variables, {projectId: 'gid://gitlab/Project/1', startDate: '2026-10-01', endDate: '2026-10-31', after: null});
    respond(0, {timelogs: {nodes: [{id: 'a', spentAt: 'x', timeSpent: 1, user: null, issue: {iid: 1, labels: {nodes: []}}}],
        pageInfo: {hasNextPage: true, endCursor: 'c1'}}});
    await flush();
    equal(pending[1].variables.after, 'c1');
    respond(1, {timelogs: {nodes: [{id: 'b', issue: null}], pageInfo: {hasNextPage: false}}});
    equal((await fetching).map(e => e.timelog.id), ['a']);
});

// ---- runner ----------------------------------------------------------------

const loop = new GLib.MainLoop(null, false);
let failures = 0;
(async () => {
    for (const {name, run} of tests) {
        try {
            await run();
            print(`PASS ${name}`);
        } catch (error) {
            failures++;
            printerr(`FAIL ${name}: ${error.message}\n${error.stack}`);
        }
    }
    print(`${tests.length - failures}/${tests.length} checks passed`);
    loop.quit();
})();
loop.run();
if (failures)
    throw new Error(`${failures} checks failed`);
