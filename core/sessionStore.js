// Pure timer/session state machine. No GI UI imports; persistence and clock
// are injected so the logic is testable with gjs alone.
import {restoreRunning} from './lockPolicy.js';
import {serializeIssue, serializeProject} from './gitlabClient.js';

export const STATE_VERSION = 3;

export function sessionKey(project, issue) {
    return `${project.id}#${issue.iid}`;
}

function validSession(session) {
    return Boolean(session?.project?.id && session?.issue && session.issue.iid !== undefined &&
        session.issue.iid !== null && typeof session.issue.title === 'string');
}

function cleanSession(raw, now) {
    const project = serializeProject(raw.project);
    const issue = serializeIssue(raw.issue);
    const accumulated = Number.isFinite(raw.accumulatedSeconds) ? Math.max(0, Math.floor(raw.accumulatedSeconds)) : 0;
    const runningSince = Number.isFinite(raw.runningSince) ? Math.floor(raw.runningSince) : null;
    return {
        key: sessionKey(project, issue),
        project,
        issue,
        accumulatedSeconds: accumulated,
        runningSince,
        sending: false,
        updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
    };
}

/** v1/v2 → v3. Running current timers keep runningSince = savedAt so the lock policy decides. */
export function migrateState(raw, now) {
    const state = {version: STATE_VERSION, activeKey: null, sessions: [], lastSeenAt: null};
    if (!raw || typeof raw !== 'object')
        return state;

    if (raw.version === STATE_VERSION) {
        const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
        const seen = new Set();
        for (const entry of sessions) {
            if (!validSession(entry))
                continue;
            const session = cleanSession(entry, now);
            if (seen.has(session.key))
                continue;
            seen.add(session.key);
            state.sessions.push(session);
        }
        state.lastSeenAt = Number.isFinite(raw.lastSeenAt) ? raw.lastSeenAt : null;
        state.activeKey = state.sessions.some(session => session.key === raw.activeKey) ? raw.activeKey : null;
        return state;
    }

    // v1 (no version) and v2 share the current-timer fields; v2 adds pausedSessions.
    const savedAt = Number.isFinite(raw.savedAt) ? raw.savedAt : now;
    const seen = new Set();
    if (raw.running && validSession(raw) && Number.isFinite(raw.elapsedSeconds) && raw.elapsedSeconds >= 0) {
        const running = !raw.paused;
        const session = cleanSession({
            project: raw.project,
            issue: raw.issue,
            accumulatedSeconds: raw.elapsedSeconds,
            runningSince: running ? savedAt : null,
            updatedAt: savedAt,
        }, now);
        state.sessions.push(session);
        state.activeKey = session.key;
        state.lastSeenAt = savedAt;
        seen.add(session.key);
    }
    const paused = Array.isArray(raw.pausedSessions) ? raw.pausedSessions : [];
    for (const entry of paused) {
        if (!validSession(entry) || !Number.isFinite(entry.elapsedSeconds) || entry.elapsedSeconds < 0)
            continue;
        const session = cleanSession({
            project: entry.project,
            issue: entry.issue,
            accumulatedSeconds: entry.elapsedSeconds,
            runningSince: null,
            updatedAt: savedAt,
        }, now);
        if (seen.has(session.key))
            continue;
        seen.add(session.key);
        state.sessions.push(session);
    }
    return state;
}

export class SessionStore {
    /**
     * @param {{load: () => string, save: (json: string) => void, clock?: () => number}} params
     */
    constructor({load, save, clock = () => Math.floor(Date.now() / 1000)}) {
        this._load = load;
        this._save = save;
        this._clock = clock;
        this._listeners = new Map();
        this._nextListenerId = 1;
        this._restore();
    }

    _restore() {
        let raw = null;
        try {
            const json = this._load();
            raw = json ? JSON.parse(json) : null;
        } catch (e) {
            raw = null;
        }
        this._state = migrateState(raw, this._clock());
        // Enforce the "at most one running session, and it is the active one" invariant.
        for (const session of this._state.sessions) {
            if (session.runningSince !== null && session.key !== this._state.activeKey) {
                session.accumulatedSeconds += Math.max(0, this._clock() - session.runningSince);
                session.runningSince = null;
            }
        }
    }

    // ---- signals -----------------------------------------------------------

    connect(signal, callback) {
        const id = this._nextListenerId++;
        this._listeners.set(id, {signal, callback});
        return id;
    }

    disconnect(id) {
        this._listeners.delete(id);
    }

    _emit(signal, ...args) {
        for (const {signal: name, callback} of [...this._listeners.values()]) {
            if (name === signal)
                callback(...args);
        }
    }

    // ---- persistence -------------------------------------------------------

    _commit() {
        this._state.lastSeenAt = this._clock();
        this._persist();
        this._emit('changed');
    }

    _persist() {
        try {
            this._save(JSON.stringify(this._state));
        } catch (e) {
            console.debug(`Timelogs: unable to save timer state: ${e.message}`);
        }
    }

    /** Updates lastSeenAt and saves without emitting. Call every 60 s while something runs. */
    heartbeat() {
        this._state.lastSeenAt = this._clock();
        this._persist();
    }

    get lastSeenAt() {
        return this._state.lastSeenAt;
    }

    /**
     * Called once after restore; adjusts a session that was running when we were last seen.
     * @returns {{key: string, policy: string, awaySeconds: number}|null} what happened, for the lock reminder
     */
    applyLockPolicy(policy) {
        const now = this._clock();
        const active = this._active();
        if (!active || active.runningSince === null)
            return null;
        const stoppedAt = Number.isFinite(this._state.lastSeenAt) ? this._state.lastSeenAt : active.runningSince;
        const awaySeconds = Math.max(0, now - stoppedAt);
        const restored = restoreRunning(active, {policy, lastSeenAt: this._state.lastSeenAt, now});
        Object.assign(active, restored, {updatedAt: now});
        this._commit();
        return {key: active.key, policy, awaySeconds};
    }

    /** Adds banked time to a session (e.g. "Add 40 min" after a lock). */
    add(key, seconds) {
        const session = this._find(key);
        const amount = Math.floor(Number(seconds) || 0);
        if (!session || amount <= 0)
            return false;
        session.accumulatedSeconds += amount;
        session.updatedAt = this._clock();
        this._commit();
        return true;
    }

    /** Removes time from a session, clamping the total at zero (e.g. idle time). */
    subtract(key, seconds) {
        const session = this._find(key);
        const amount = Math.floor(Number(seconds) || 0);
        if (!session || amount <= 0)
            return false;
        const now = this._clock();
        const elapsed = this.elapsedOf(session);
        const remaining = Math.max(0, elapsed - amount);
        if (session.runningSince !== null) {
            session.accumulatedSeconds = remaining;
            session.runningSince = now;
        } else {
            session.accumulatedSeconds = remaining;
        }
        session.updatedAt = now;
        this._commit();
        return true;
    }

    // ---- queries -----------------------------------------------------------

    _active() {
        return this._state.sessions.find(session => session.key === this._state.activeKey) ?? null;
    }

    _find(key) {
        return this._state.sessions.find(session => session.key === key) ?? null;
    }

    elapsedOf(session) {
        const running = session.runningSince !== null ? Math.max(0, this._clock() - session.runningSince) : 0;
        return session.accumulatedSeconds + running;
    }

    _view(session) {
        return {
            key: session.key,
            project: session.project,
            issue: session.issue,
            elapsedSeconds: this.elapsedOf(session),
            running: session.runningSince !== null,
            sending: session.sending,
            updatedAt: session.updatedAt,
        };
    }

    /** @returns {{active: object|null, paused: object[]}} views include elapsedSeconds */
    snapshot() {
        const active = this._active();
        return {
            active: active ? this._view(active) : null,
            paused: this._state.sessions.filter(session => session !== active).map(session => this._view(session)),
        };
    }

    get(key) {
        const session = this._find(key);
        return session ? this._view(session) : null;
    }

    has(project, issue) {
        return Boolean(this._find(sessionKey(project, issue)));
    }

    hasRunning() {
        const active = this._active();
        return Boolean(active && active.runningSince !== null);
    }

    isBusy() {
        return this._state.sessions.some(session => session.sending);
    }

    get size() {
        return this._state.sessions.length;
    }

    // ---- transitions -------------------------------------------------------

    _pauseSession(session, now) {
        if (session.runningSince === null)
            return;
        session.accumulatedSeconds += Math.max(0, now - session.runningSince);
        session.runningSince = null;
        session.updatedAt = now;
    }

    _moveToFront(session) {
        const index = this._state.sessions.indexOf(session);
        if (index > 0) {
            this._state.sessions.splice(index, 1);
            this._state.sessions.unshift(session);
        }
    }

    /** Start tracking an issue; an existing session for it is resumed instead. */
    start(project, issue) {
        const key = sessionKey(project, issue);
        if (this._find(key))
            return this.switchTo(key);

        const now = this._clock();
        const active = this._active();
        if (active)
            this._pauseSession(active, now);
        const session = cleanSession({
            project: serializeProject(project),
            issue: serializeIssue(issue),
            accumulatedSeconds: 0,
            runningSince: now,
            updatedAt: now,
        }, now);
        this._state.sessions.unshift(session);
        this._state.activeKey = key;
        this._commit();
        return true;
    }

    /** Pause the active session and make `key` active and running. */
    switchTo(key) {
        const target = this._find(key);
        if (!target || target.sending)
            return false;
        const now = this._clock();
        const active = this._active();
        if (active && active !== target)
            this._pauseSession(active, now);
        if (target.runningSince === null)
            target.runningSince = now;
        target.updatedAt = now;
        this._state.activeKey = key;
        this._moveToFront(target);
        this._commit();
        return true;
    }

    pause() {
        const active = this._active();
        if (!active || active.runningSince === null)
            return false;
        this._pauseSession(active, this._clock());
        this._commit();
        return true;
    }

    resume() {
        const active = this._active();
        if (!active || active.runningSince !== null || active.sending)
            return false;
        active.runningSince = this._clock();
        active.updatedAt = active.runningSince;
        this._commit();
        return true;
    }

    /** Active: pause↔resume. None: resume most recent session. Returns false if nothing to do. */
    toggle() {
        const active = this._active();
        if (active)
            return active.runningSince !== null ? this.pause() : this.resume();
        const candidate = this._state.sessions.find(session => !session.sending);
        return candidate ? this.switchTo(candidate.key) : false;
    }

    /** Removes the session and returns it (with its position) for undo. */
    discard(key) {
        const session = this._find(key);
        if (!session || session.sending)
            return null;
        const index = this._state.sessions.indexOf(session);
        const wasActive = this._state.activeKey === key;
        this._state.sessions.splice(index, 1);
        if (wasActive)
            this._state.activeKey = null;
        this._commit();
        return {...session, index, wasActive};
    }

    /** Puts a discarded session back; a running one resumes and pauses the current active. */
    restoreDiscarded(discarded) {
        if (!discarded || this._find(discarded.key))
            return false;
        const now = this._clock();
        const {index, wasActive, ...fields} = discarded;
        const session = cleanSession(fields, now);
        session.runningSince = Number.isFinite(discarded.runningSince) ? discarded.runningSince : null;
        const active = this._active();
        if (session.runningSince !== null) {
            if (active)
                this._pauseSession(active, now);
            this._state.activeKey = session.key;
        } else if (wasActive && !active) {
            this._state.activeKey = session.key;
        }
        const position = Math.min(Math.max(0, index ?? 0), this._state.sessions.length);
        this._state.sessions.splice(position, 0, session);
        this._commit();
        return true;
    }

    /** Marks the session as sending (timer keeps running) and returns what to submit. */
    beginSubmit(key) {
        const session = this._find(key);
        if (!session || session.sending)
            return null;
        session.sending = true;
        this._commit();
        return {key, project: session.project, issue: session.issue, elapsedSeconds: this.elapsedOf(session)};
    }

    completeSubmit(key, ok) {
        const session = this._find(key);
        if (!session)
            return;
        session.sending = false;
        if (ok) {
            this._state.sessions.splice(this._state.sessions.indexOf(session), 1);
            if (this._state.activeKey === key)
                this._state.activeKey = null;
        }
        this._commit();
    }
}
