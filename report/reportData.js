// GraphQL fetch + pure aggregation for the report. The aggregation,
// summary and calendar helpers have no GI imports so they can be tested headlessly.

const TIMELOGS_QUERY = `query ReportTimelogs($projectId: ProjectID!, $startDate: Time, $endDate: Time, $after: String) {
    timelogs(projectId: $projectId, startDate: $startDate, endDate: $endDate, first: 100, after: $after) {
        count
        nodes {
            id
            spentAt
            timeSpent
            summary
            user { username name }
            issue { id iid title webUrl labels { nodes { title } } }
        }
        pageInfo { hasNextPage endCursor }
    }
}`;

// 100 entries per page; enough for a whole project history.
const MAX_PAGES = 1000;

export function monthRange(year, month) {
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    const lastDay = new Date(year, month + 1, 0).getDate();
    return {startDate: `${prefix}-01`, endDate: `${prefix}-${String(lastDay).padStart(2, '0')}`};
}

/** {year, month} of the month before the given one (month is 0-based). */
export function previousMonth(year, month) {
    const date = new Date(year, month - 1, 1);
    return {year: date.getFullYear(), month: date.getMonth()};
}

/** Maps GraphQL timelog nodes to the flat entry shape used by aggregate(). */
export function entriesFromNodes(nodes) {
    const entries = [];
    for (const node of nodes ?? []) {
        if (!node?.issue)
            continue;
        entries.push({
            issue: {
                id: node.issue.id,
                iid: node.issue.iid,
                title: node.issue.title,
                web_url: node.issue.webUrl,
                labels: (node.issue.labels?.nodes ?? []).map(label => label.title),
            },
            timelog: {
                id: node.id,
                spent_at: node.spentAt,
                time_spent: node.timeSpent,
                summary: node.summary ?? null,
                user: node.user ? {username: node.user.username, name: node.user.name ?? null} : null,
            },
        });
    }
    return entries;
}

/**
 * @param {object} client GitLabClient (needs graphql())
 * @param {number} projectId
 * @param {number} year
 * @param {number} month 0-based
 * @param {{cancellable?: object, onProgress?: ({loaded: number, total: number|null}) => void}} [options]
 */
export function fetchTimelogs(client, projectId, year, month, options = {}) {
    return fetchTimelogsInRange(client, projectId, monthRange(year, month), options);
}

/**
 * Like fetchTimelogs() for an arbitrary period. `startDate`/`endDate` are
 * inclusive 'YYYY-MM-DD' strings; leave both null for the project's whole history.
 */
export async function fetchTimelogsInRange(client, projectId, {startDate = null, endDate = null} = {},
    {cancellable = null, onProgress = null} = {}) {
    const entries = [];
    let loaded = 0;
    let after = null;
    for (let page = 0; page < MAX_PAGES; page++) {
        const data = await client.graphql(TIMELOGS_QUERY, {
            projectId: `gid://gitlab/Project/${projectId}`,
            startDate,
            endDate,
            after,
        }, {cancellable});
        const connection = data?.timelogs;
        if (!connection)
            break;
        loaded += (connection.nodes ?? []).length;
        entries.push(...entriesFromNodes(connection.nodes));
        onProgress?.({loaded, total: Number.isFinite(connection.count) ? connection.count : null});
        if (!connection.pageInfo?.hasNextPage)
            break;
        after = connection.pageInfo.endCursor;
    }
    return entries;
}

/** "Bug,^Feature.*$" → [{type:'literal'}, {type:'regex'}] (unchanged from the old window). */
export function parseTagFilters(text) {
    const filterString = String(text ?? '').trim();
    if (!filterString)
        return [];
    return filterString.split(',').map(filter => filter.trim()).filter(Boolean).map(filter => {
        if (filter.startsWith('^') || filter.endsWith('$') || filter.includes('.*') || filter.includes('.+')) {
            try {
                return {type: 'regex', pattern: new RegExp(filter)};
            } catch (e) {
                return {type: 'literal', value: filter};
            }
        }
        return {type: 'literal', value: filter};
    });
}

export function labelMatchesFilters(label, tagFilters) {
    return tagFilters.some(filter => filter.type === 'regex' ? filter.pattern.test(label) : filter.value === label);
}

/** Distinct timelog authors of the loaded month, sorted by display name. */
export function authorsOf(entries) {
    const authors = new Map();
    for (const entry of entries ?? []) {
        const user = entry.timelog?.user;
        if (!user?.username || authors.has(user.username))
            continue;
        authors.set(user.username, {username: user.username, name: user.name || user.username});
    }
    return [...authors.values()].sort((a, b) =>
        a.name.localeCompare(b.name) || a.username.localeCompare(b.username));
}

/**
 * @param {object[]} entries
 * @param {{author?: string, tagFilters?: object[], year?: number, month?: number, labels?: {other: string, none: string, unknown: string}}} options
 * @returns {object} totals by label, user×label, issue per label, day (seconds and entries)
 */
export function aggregate(entries, {author = '', tagFilters = [], year = null, month = null, labels = {}} = {}) {
    const otherLabel = labels.other ?? 'Other';
    const noneLabel = labels.none ?? 'No label';
    const unknownUser = labels.unknown ?? 'Unknown user';
    const timeByLabel = {};
    const timeByUserAndLabel = {};
    const issuesByLabel = {};
    const timeByLabelAndIssue = {};
    const timeByDay = new Map();
    const entriesByDay = new Map();
    const issues = new Set();
    let totalSeconds = 0;
    let firstSpentAt = null;

    for (const entry of entries ?? []) {
        const user = entry.timelog.user?.username || unknownUser;
        if (author && user !== author)
            continue;
        const seconds = entry.timelog.time_spent || 0;
        if (seconds <= 0)
            continue;

        totalSeconds += seconds;
        issues.add(entry.issue.iid);
        const spentAt = entry.timelog.spent_at ? new Date(entry.timelog.spent_at) : null;
        if (spentAt && !Number.isNaN(spentAt.getTime()) && (firstSpentAt === null || spentAt < firstSpentAt))
            firstSpentAt = spentAt;
        if (spentAt && (year === null || (spentAt.getFullYear() === year && spentAt.getMonth() === month))) {
            const day = spentAt.getDate();
            timeByDay.set(day, (timeByDay.get(day) || 0) + seconds);
            if (!entriesByDay.has(day))
                entriesByDay.set(day, []);
            entriesByDay.get(day).push(entry);
        }
        const issueLabels = entry.issue.labels || [];
        const matched = tagFilters.length > 0 ? issueLabels.filter(label => labelMatchesFilters(label, tagFilters)) : issueLabels;
        const categories = matched.length > 0 ? matched : [tagFilters.length > 0 ? otherLabel : noneLabel];

        for (const label of categories) {
            timeByLabel[label] = (timeByLabel[label] || 0) + seconds;
            timeByUserAndLabel[user] ??= {};
            timeByUserAndLabel[user][label] = (timeByUserAndLabel[user][label] || 0) + seconds;
            issuesByLabel[label] ??= new Map();
            issuesByLabel[label].set(entry.issue.iid, entry.issue);
            timeByLabelAndIssue[label] ??= new Map();
            timeByLabelAndIssue[label].set(entry.issue.iid, (timeByLabelAndIssue[label].get(entry.issue.iid) || 0) + seconds);
        }
    }

    for (const list of entriesByDay.values())
        list.sort((a, b) => String(a.timelog.spent_at).localeCompare(String(b.timelog.spent_at)));

    return {
        timeByLabel,
        timeByUserAndLabel,
        issuesByLabel,
        timeByLabelAndIssue,
        timeByDay,
        entriesByDay,
        totalSeconds,
        firstSpentAt,
        issueCount: issues.size,
        categoryCount: Object.keys(timeByLabel).length,
        tagFilters,
        neutralLabels: [otherLabel, noneLabel],
    };
}

/** Issues of one category sorted by time, [{issue, seconds}]. */
export function issuesInCategory(reportData, label) {
    const seconds = reportData.timeByLabelAndIssue[label] ?? new Map();
    const issues = reportData.issuesByLabel[label] ?? new Map();
    return [...seconds.entries()]
        .map(([iid, total]) => ({issue: issues.get(iid), seconds: total}))
        .sort((a, b) => b.seconds - a.seconds || a.issue.iid - b.issue.iid);
}

/**
 * Mon–Fri days of the month up to and including `today` when it falls in that
 * month, otherwise all working days of the month (future months: 0).
 */
export function workingDays(year, month, today = new Date()) {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const isCurrent = today.getFullYear() === year && today.getMonth() === month;
    const isFuture = today.getFullYear() < year || (today.getFullYear() === year && today.getMonth() < month);
    if (isFuture)
        return 0;
    const lastDay = isCurrent ? today.getDate() : daysInMonth;
    let count = 0;
    for (let day = 1; day <= lastDay; day++) {
        const weekday = new Date(year, month, day).getDay();
        if (weekday !== 0 && weekday !== 6)
            count++;
    }
    return count;
}

/**
 * Summary card figures. `previousTotalSeconds` is null until the previous
 * month has loaded; `changeRatio` is null then, or when there is no baseline.
 */
export function summarize(reportData, {year, month, today = new Date(), previousTotalSeconds = null}) {
    const days = workingDays(year, month, today);
    const change = previousTotalSeconds === null ? null
        : previousTotalSeconds > 0 ? (reportData.totalSeconds - previousTotalSeconds) / previousTotalSeconds
            : reportData.totalSeconds > 0 ? Infinity : 0;
    return {
        totalSeconds: reportData.totalSeconds,
        issueCount: reportData.issueCount,
        workingDays: days,
        averagePerWorkingDay: days > 0 ? reportData.totalSeconds / days : 0,
        previousTotalSeconds,
        changeRatio: change,
    };
}

/** 'YYYY-MM-DD' → local midnight Date, or null when the text is not a real date. */
export function parseIsoDate(text) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? ''));
    if (!match)
        return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) ? date : null;
}

export function toIsoDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Mon–Fri days from `start` to `end`, both inclusive (local dates). */
export function workingDaysBetween(start, end) {
    const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    let count = 0;
    for (let day = new Date(start.getFullYear(), start.getMonth(), start.getDate()); day <= last; day.setDate(day.getDate() + 1)) {
        if (day.getDay() !== 0 && day.getDay() !== 6)
            count++;
    }
    return count;
}

/**
 * Summary figures for a free period. `start` null means "since the first
 * entry"; `end` null means today. Days after `today` never count.
 */
export function summarizeRange(reportData, {start = null, end = null, today = new Date()} = {}) {
    const from = start ?? reportData.firstSpentAt;
    const to = end && end < today ? end : today;
    const days = from ? workingDaysBetween(from, to) : 0;
    return {
        totalSeconds: reportData.totalSeconds,
        issueCount: reportData.issueCount,
        workingDays: days,
        averagePerWorkingDay: days > 0 ? reportData.totalSeconds / days : 0,
        previousTotalSeconds: null,
        changeRatio: null,
    };
}

/**
 * Calendar rows for a Monday-first month grid.
 * @returns {{days: ({day: number, seconds: number, weekend: boolean, future: boolean}|null)[], totalSeconds: number}[]}
 */
export function calendarWeeks(year, month, timeByDay, today = new Date()) {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // Monday = 0
    const todayKey = today.getFullYear() * 10000 + today.getMonth() * 100 + today.getDate();
    const weeks = [];
    let week = {days: Array(firstWeekday).fill(null), totalSeconds: 0};
    for (let day = 1; day <= daysInMonth; day++) {
        const weekday = new Date(year, month, day).getDay();
        const key = year * 10000 + month * 100 + day;
        const seconds = timeByDay.get(day) || 0;
        week.days.push({day, seconds, weekend: weekday === 0 || weekday === 6, future: key > todayKey, today: key === todayKey});
        week.totalSeconds += seconds;
        if (week.days.length === 7) {
            weeks.push(week);
            week = {days: [], totalSeconds: 0};
        }
    }
    if (week.days.length > 0) {
        while (week.days.length < 7)
            week.days.push(null);
        weeks.push(week);
    }
    return weeks;
}
