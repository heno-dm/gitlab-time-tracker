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

/** Report figures: "38.0 h" (one decimal, space before the unit). */
export function formatReportHours(seconds, digits = 1) {
    return `${((Number(seconds) || 0) / 3600).toFixed(digits)} h`;
}

/** "1h 23m" / "45m" / "2h" — submit dialog, notifications and the Today total. */
export function formatHuman(seconds) {
    const {hours, minutes} = split(seconds);
    const parts = [];
    if (hours > 0)
        parts.push(`${hours}h`);
    if (minutes > 0 || hours === 0)
        parts.push(`${minutes}m`);
    return parts.join(' ');
}

const UNIT_SECONDS = {mo: 4 * 7 * 8 * 3600, w: 5 * 8 * 3600, d: 8 * 3600, h: 3600, m: 60, s: 1};

/** Seconds for a valid GitLab duration ("1h 30m" → 5400); null when invalid. GitLab's 8h/5d calendar. */
export function parseGitLabDuration(text) {
    const trimmed = String(text ?? '').trim();
    if (!isValidGitLabDuration(trimmed))
        return null;
    let total = 0;
    for (const [, amount, unit] of trimmed.matchAll(/(\d+)(mo|w|d|h|m|s)/g))
        total += Number(amount) * UNIT_SECONDS[unit];
    return total;
}

/** Nearest multiple of `stepMinutes`, never below one step; used by the "Round to" chip. */
export function roundToStep(seconds, stepMinutes) {
    const step = Math.max(1, Math.floor(stepMinutes)) * 60;
    return Math.max(step, Math.round(Math.max(0, seconds) / step) * step);
}

/** Adds `deltaSeconds` (may be negative) and clamps to a minimum of one minute. */
export function adjustDuration(seconds, deltaSeconds) {
    return Math.max(60, Math.floor(seconds) + Math.floor(deltaSeconds));
}

/** Seconds → "1h 30m" in GitLab syntax with a space, rounded down to whole minutes. */
export function toEditableDuration(seconds) {
    return formatHuman(Math.max(60, seconds));
}
