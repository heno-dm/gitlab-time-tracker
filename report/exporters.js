// CSV / Markdown builders. Output is byte-compatible with the previous window.

const hours = seconds => (seconds / 3600).toFixed(2);

/**
 * @param {object} reportData from aggregate()
 * @param {{projectPath: string, monthLabel: string, strings?: object}} options
 */
export function toMarkdown(reportData, {projectPath, monthLabel, strings = {}}) {
    const s = {
        title: 'Monthly Time Report',
        period: 'Period',
        total: 'Total time',
        byCategory: 'Summary by category',
        byUser: 'Time by user and category',
        ...strings,
    };
    let content = `# ${s.title} - ${projectPath}\n\n`;
    content += `**${s.period}:** ${monthLabel}\n`;
    content += `**${s.total}:** ${hours(reportData.totalSeconds)}h\n\n`;
    content += `## ${s.byCategory}\n\n`;
    for (const [label, seconds] of Object.entries(reportData.timeByLabel).sort((a, b) => b[1] - a[1]))
        content += `- **${label}:** ${hours(seconds)}h\n`;

    content += `\n## ${s.byUser}\n\n`;
    for (const [user, categories] of Object.entries(reportData.timeByUserAndLabel).sort()) {
        for (const [label, seconds] of Object.entries(categories).sort((a, b) => b[1] - a[1]))
            content += `- **${user} / ${label}:** ${hours(seconds)}h\n`;
    }
    return content;
}

export function toCsv(reportData, {projectPath, monthLabel}) {
    const escape = value => String(value).replace(/"/g, '""');
    let content = '"Project","Month","User","Category","Time (hours)"\n';
    for (const [user, categories] of Object.entries(reportData.timeByUserAndLabel)) {
        for (const [label, seconds] of Object.entries(categories))
            content += `"${escape(projectPath)}","${escape(monthLabel)}","${escape(user)}","${escape(label)}","${hours(seconds)}"\n`;
    }
    content += `"${escape(projectPath)}","${escape(monthLabel)}","TOTAL","TOTAL","${hours(reportData.totalSeconds)}"\n`;
    return content;
}

/** gitlab-report-<group-project>-<yyyy>-<mm>.<ext> */
export function exportFileName(projectPath, year, month, ext) {
    const safePath = String(projectPath).replace(/[/\\:*?"<>|]/g, '-');
    return `gitlab-report-${safePath}-${year}-${String(month + 1).padStart(2, '0')}.${ext}`;
}
