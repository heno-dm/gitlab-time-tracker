const RECENT_ISSUE_LIMIT = 6;

export function serializeProject(project) {
    if (!project)
        return null;

    return {
        id: project.id,
        path_with_namespace: project.path_with_namespace,
        name: project.name,
        avatar_url: project.avatar_url || null,
        web_url: project.web_url || null,
        namespace: project.namespace || null,
    };
}

export function serializeIssue(issue) {
    if (!issue)
        return null;

    return {
        id: issue.id,
        iid: issue.iid,
        title: issue.title,
        project_id: issue.project_id,
        web_url: issue.web_url || null,
    };
}

export function getRecentIssues(settings) {
    try {
        const value = settings.get_string('recent-issues');
        if (!value)
            return [];

        const issues = JSON.parse(value);
        if (!Array.isArray(issues))
            return [];

        return issues.filter(item => item?.project?.id && item?.issue?.iid).slice(0, RECENT_ISSUE_LIMIT);
    } catch (e) {
        console.debug(`GitLab Timer: Unable to read recent issues: ${e.message}`);
        return [];
    }
}

export function addRecentIssue(settings, project, issue) {
    const projectData = serializeProject(project);
    const issueData = serializeIssue(issue);

    if (!projectData || !issueData)
        return;

    const recentIssues = getRecentIssues(settings).filter(item =>
        item.project.id !== projectData.id || item.issue.iid !== issueData.iid);

    recentIssues.unshift({
        project: projectData,
        issue: issueData,
        updatedAt: new Date().toISOString(),
    });

    settings.set_string('recent-issues', JSON.stringify(recentIssues.slice(0, RECENT_ISSUE_LIMIT)));
}
