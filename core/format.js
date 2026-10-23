// Pure duration formatting helpers. No GI imports so tests can load this directly.

const DURATION_PATTERN = /^(?:\d+(?:mo|w|d|h|m|s))(?:\s*\d+(?:mo|w|d|h|m|s))*$/;

function split(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    return {
        hours: Math.floor(total / 3600),
        minutes: Math.floor((total % 3600) / 60),
        seconds: total % 60,
    };
}

/** "1:23:45" — used for the active session row. */
export function formatClock(seconds) {
    const {hours, minutes, seconds: secs} = split(seconds);
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/** "1:23" — used for the panel label and paused rows. */
export function formatShort(seconds) {
    const {hours, minutes} = split(seconds);
    return `${hours}:${String(minutes).padStart(2, '0')}`;
}

/** "1h23m" with a minimum of "1m" (GitLab rejects empty durations). */
export function toGitLabDuration(seconds) {
    const {hours, minutes} = split(seconds);
    let duration = '';
    if (hours > 0)
        duration += `${hours}h`;
    if (minutes > 0)
        duration += `${minutes}m`;
    return duration || '1m';
}

/** Validates GitLab's human duration syntax (e.g. "1h 30m", "2d4h", "45m"). */
export function isValidGitLabDuration(text) {
    return DURATION_PATTERN.test(String(text ?? '').trim());
}

/** Hours with one decimal, e.g. "86.5h". */
export function formatHours(seconds, digits = 1) {
    return `${((Number(seconds) || 0) / 3600).toFixed(digits)}h`;
}
