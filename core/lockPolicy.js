// What happens to a session that was running when the extension was disabled
// (lock screen, logout, crash, shutdown). `lastSeenAt` is the last heartbeat.

export const LOCK_POLICIES = ['pause', 'keep-counting', 'resume-on-unlock'];

/**
 * @param {object} session  session with runningSince !== null
 * @param {{policy: string, lastSeenAt: number|null, now: number}} params
 * @returns {object} a new session object
 */
export function restoreRunning(session, {policy, lastSeenAt, now}) {
    if (!session || session.runningSince === null || session.runningSince === undefined)
        return session;

    const stoppedAt = Number.isFinite(lastSeenAt) ? lastSeenAt : session.runningSince;
    const banked = Math.max(0, stoppedAt - session.runningSince);
    const accumulated = Math.max(0, session.accumulatedSeconds || 0);

    switch (policy) {
    case 'keep-counting':
        // Downtime counts; only guard against clock rollback producing negatives.
        return {...session, runningSince: Math.min(session.runningSince, now)};
    case 'resume-on-unlock':
        return {...session, accumulatedSeconds: accumulated + banked, runningSince: now};
    case 'pause':
    default:
        return {...session, accumulatedSeconds: accumulated + banked, runningSince: null};
    }
}

/** Migration from the two legacy booleans to the single policy string. */
export function policyFromLegacy({resumeOnUnlock, countTimeWhenLocked}) {
    if (!resumeOnUnlock)
        return 'pause';
    return countTimeWhenLocked ? 'keep-counting' : 'resume-on-unlock';
}
