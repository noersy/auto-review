import config from './config.js';

/**
 * Validates and normalizes the performance issues array from the LLM.
 * @param {Array} issues - Raw issues array from LLM.
 * @returns {Array} - Normalized issues array.
 */
function normalizeIssues(issues) {
    if (!Array.isArray(issues)) return [];

    return issues.map(issue => ({
        type: issue.type || 'UNKNOWN',
        severity: (issue.severity || 'low').toLowerCase(),
        file: issue.file || 'unknown',
        line: issue.line ? Number(issue.line) : 0,
        description: issue.description || 'No description provided.',
        suggestion: issue.suggestion || 'No suggestion provided.',
    }));
}

/**
 * Determines the overall risk level based on the highest severity issue
 * if overallRisk is missing or invalid.
 * @param {Array} issues - Normalized issues array.
 * @param {string} claimedRisk - The overall risk returned by the LLM.
 * @returns {string} - Final calculated risk (critical, high, medium, low, none).
 */
function calculateOverallRisk(issues, claimedRisk) {
    const validRisks = ['critical', 'high', 'medium', 'low', 'none'];
    let risk = (claimedRisk || 'none').toLowerCase();

    if (!validRisks.includes(risk)) {
        risk = 'none';
    }

    if (issues.length === 0) return 'none';

    // If there are issues, but LLM returned 'none', recalculate
    if (risk === 'none') {
        const severities = issues.map(v => v.severity);
        if (severities.includes('critical')) return 'critical';
        if (severities.includes('high')) return 'high';
        if (severities.includes('medium')) return 'medium';
        return 'low';
    }

    return risk;
}

/**
 * Parses the raw JSON output from the LLM specific to the performance scan.
 * Extracts the <json> block and parses the content.
 * @param {string} rawOutput - Raw string output from the LLM.
 * @returns {Object} - Parsed performance report.
 */
export function parsePerformanceReport(rawOutput) {
    const defaultResponse = {
        issues: [],
        summary: 'Failed to parse performance report.',
        overallRisk: 'none'
    };

    if (!rawOutput) return defaultResponse;

    try {
        // Extract JSON specifically from within <json>...</json> tags
        const match = rawOutput.match(/<json>\s*([\s\S]*?)\s*<\/json>/i);
        const jsonString = match ? match[1] : rawOutput;

        // Strip markdown code blocks if the LLM wrapped it anyway
        const cleanJsonString = jsonString.replace(/^```json/mi, '').replace(/```$/mi, '').trim();

        const data = JSON.parse(cleanJsonString);

        const normalizedIssues = normalizeIssues(data.performanceIssues || data.issues || []);
        const calculatedRisk = calculateOverallRisk(normalizedIssues, data.overallRisk);

        return {
            issues: normalizedIssues,
            summary: data.summary || 'No summary provided.',
            overallRisk: calculatedRisk
        };
    } catch (error) {
        console.error('Failed to parse LLM performance output:', error.message);
        console.debug('Raw output was:\n' + rawOutput);
        return defaultResponse;
    }
}

/**
 * Builds a markdown summary of the performance scan.
 * @param {Object} report - Parsed performance report from `parsePerformanceReport`.
 * @returns {string} - Markdown formatted report.
 */
export function formatPerformanceMarkdown(report) {
    if (!report.issues || report.issues.length === 0) {
        return `### ⚡ Performance Scan: Clean\n\nNo noticeable performance bottlenecks were detected in this change.\n\n_Note: This is an automated LLM-based scan. Always conduct load testing for critical path changes._`;
    }

    const { critical, high, medium, low } = report.issues.reduce((acc, issue) => {
        if (acc[issue.severity] !== undefined) acc[issue.severity]++;
        return acc;
    }, { critical: 0, high: 0, medium: 0, low: 0 });

    const isBlocking = config.PERFORMANCE_BLOCK_ON.includes(report.overallRisk);
    const statusIcon = isBlocking ? '🚫' : '⚠️';

    let markdown = `### ${statusIcon} Performance Scan Report\n\n`;
    markdown += `**Overall Risk:** \`${report.overallRisk.toUpperCase()}\`\n\n`;
    markdown += `**Summary:** ${report.summary}\n\n`;
    markdown += `**Findings Count by Severity:**\n`;
    markdown += `- Critical: ${critical}\n`;
    markdown += `- High: ${high}\n`;
    markdown += `- Medium: ${medium}\n`;
    markdown += `- Low: ${low}\n\n`;

    markdown += `### Detailed Findings\n\n`;

    report.issues.forEach((issue, index) => {
        let icon = 'ℹ️';
        if (issue.severity === 'critical') icon = '⛔';
        if (issue.severity === 'high') icon = '🔴';
        if (issue.severity === 'medium') icon = '🟡';

        markdown += `#### ${index + 1}. [${icon} ${issue.severity.toUpperCase()}] ${issue.type.replace(/_/g, ' ')}\n`;
        markdown += `- **Location:** \`${issue.file}:${issue.line}\`\n`;
        markdown += `- **Description:** ${issue.description}\n`;
        markdown += `- **Suggestion:** ${issue.suggestion}\n\n`;
    });

    markdown += `\n---\n*This scan uses AI models to detect performance anti-patterns (N+1 queries, heavy loops, memory leaks). Found false positives? Adjust the code or leave a comment.*`;

    return markdown;
}
