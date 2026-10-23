// GraphQL fetch + pure aggregation for the monthly report. The aggregation and
// filter helpers have no GI imports so they can be tested headlessly.

const TIMELOGS_QUERY = `query ReportTimelogs($projectId: ProjectID!, $startDate: Time, $endDate: Time, $after: String) {
    timelogs(projectId: $projectId, startDate: $startDate, endDate: $endDate, first: 100, after: $after) {
        nodes {
            id
            spentAt
            timeSpent
            user { username name }
            issue { id iid title webUrl labels { nodes { title } } }
        }
        pageInfo { hasNextPage endCursor }
    }
}`;

export function monthRange(year, month) {
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    const lastDay = new Date(year, month + 1, 0).getDate();
    return {startDate: `${prefix}-01`, endDate: `${prefix}-${String(lastDay).padStart(2, '0')}`};
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
 * @param {{cancellable?: object}} [options]
 */
export async function fetchTimelogs(client, projectId, year, month, {cancellable = null} = {}) {
    const {startDate, endDate} = monthRange(year, month);
    const entries = [];
    let after = null;
    for (let page = 0; page < 200; page++) {
        const data = await client.graphql(TIMELOGS_QUERY, {
            projectId: `gid://gitlab/Project/${projectId}`,
            startDate,
            endDate,
            after,
        }, {cancellable});
        const connection = data?.timelogs;
        if (!connection)
            break;
        entries.push(...entriesFromNodes(connection.nodes));
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
 */
export function aggregate(entries, {author = '', tagFilters = [], year = null, month = null, labels = {}} = {}) {
    const otherLabel = labels.other ?? 'Other';
    const noneLabel = labels.none ?? 'No label';
    const unknownUser = labels.unknown ?? 'Unknown user';
    const timeByLabel = {};
    const timeByUserAndLabel = {};
    const issuesByLabel = {};
    const timeByDay = new Map();
    const issues = new Set();
    let totalSeconds = 0;

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
        if (spentAt && (year === null || (spentAt.getFullYear() === year && spentAt.getMonth() === month))) {
            const day = spentAt.getDate();
            timeByDay.set(day, (timeByDay.get(day) || 0) + seconds);
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
        }
    }

    return {
        timeByLabel,
        timeByUserAndLabel,
        issuesByLabel,
        timeByDay,
        totalSeconds,
        issueCount: issues.size,
        categoryCount: Object.keys(timeByLabel).length,
        tagFilters,
    };
}
