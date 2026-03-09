import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock logger to avoid console noise
jest.unstable_mockModule('../src/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { parseSecurityResult, shouldBlockMerge, buildSecurityReport } = await import('../src/security.js');

// ─── parseSecurityResult ───────────────────────────────────────────────────

describe('parseSecurityResult', () => {
    it('parses valid JSON wrapped in <json> tags', () => {
        const raw = `<json>{"overallRisk":"low","vulnerabilities":[]}</json>`;
        const result = parseSecurityResult(raw);
        expect(result).toEqual({ overallRisk: 'low', vulnerabilities: [] });
    });

    it('parses bare JSON when no <json> tag present', () => {
        const raw = `Some preamble {"overallRisk":"medium","vulnerabilities":[]} trailing text`;
        const result = parseSecurityResult(raw);
        expect(result).toEqual({ overallRisk: 'medium', vulnerabilities: [] });
    });

    it('returns null when JSON is malformed', () => {
        const result = parseSecurityResult('not json at all');
        expect(result).toBeNull();
    });

    it('returns null when vulnerabilities field is missing', () => {
        const raw = `<json>{"overallRisk":"low"}</json>`;
        const result = parseSecurityResult(raw);
        expect(result).toBeNull();
    });

    it('returns null when vulnerabilities is not an array', () => {
        const raw = `<json>{"overallRisk":"low","vulnerabilities":"none"}</json>`;
        const result = parseSecurityResult(raw);
        expect(result).toBeNull();
    });

    it('returns null for null input', () => {
        const result = parseSecurityResult(null);
        expect(result).toBeNull();
    });

    it('prefers <json> tag over bare brace matching', () => {
        const raw = `{garbage {"overallRisk":"high","vulnerabilities":[]}</json> <json>{"overallRisk":"critical","vulnerabilities":[]}</json>`;
        const result = parseSecurityResult(raw);
        expect(result.overallRisk).toBe('critical');
    });

    it('parses result with vulnerabilities array', () => {
        const raw = `<json>{"overallRisk":"high","vulnerabilities":[{"severity":"high","type":"SQLi","file":"db.js","description":"SQL injection","suggestion":"Use parameterized queries"}]}</json>`;
        const result = parseSecurityResult(raw);
        expect(result.vulnerabilities).toHaveLength(1);
        expect(result.vulnerabilities[0].severity).toBe('high');
    });
});

// ─── shouldBlockMerge ─────────────────────────────────────────────────────

describe('shouldBlockMerge', () => {
    it('returns true for critical risk', () => {
        expect(shouldBlockMerge({ overallRisk: 'critical', vulnerabilities: [] })).toBe(true);
    });

    it('returns true for high risk', () => {
        expect(shouldBlockMerge({ overallRisk: 'high', vulnerabilities: [] })).toBe(true);
    });

    it('returns false for medium risk', () => {
        expect(shouldBlockMerge({ overallRisk: 'medium', vulnerabilities: [] })).toBe(false);
    });

    it('returns false for low risk', () => {
        expect(shouldBlockMerge({ overallRisk: 'low', vulnerabilities: [] })).toBe(false);
    });

    it('returns false when result is null', () => {
        expect(shouldBlockMerge(null)).toBe(false);
    });

    it('returns false when overallRisk is missing', () => {
        expect(shouldBlockMerge({ vulnerabilities: [] })).toBe(false);
    });
});

// ─── buildSecurityReport ──────────────────────────────────────────────────

describe('buildSecurityReport', () => {
    it('contains the security comment marker', () => {
        const result = { overallRisk: 'low', vulnerabilities: [], summary: 'All good.' };
        const report = buildSecurityReport(result, false);
        expect(report).toContain('<!-- auto-review-security -->');
    });

    it('uses "Selesai" header when not blocked', () => {
        const result = { overallRisk: 'low', vulnerabilities: [] };
        const report = buildSecurityReport(result, false);
        expect(report).toContain('Selesai');
        expect(report).not.toContain('Risiko Terdeteksi');
    });

    it('uses "Risiko Terdeteksi" header when blocked', () => {
        const result = { overallRisk: 'critical', vulnerabilities: [] };
        const report = buildSecurityReport(result, true);
        expect(report).toContain('Risiko Terdeteksi');
    });

    it('shows clean message when no vulnerabilities', () => {
        const result = { overallRisk: 'low', vulnerabilities: [] };
        const report = buildSecurityReport(result, false);
        expect(report).toContain('Tidak ditemukan kerentanan');
    });

    it('shows overall risk badge when vulnerabilities exist', () => {
        const result = {
            overallRisk: 'high',
            vulnerabilities: [{ severity: 'high', type: 'XSS', file: 'app.js', description: 'XSS vuln', suggestion: 'Sanitize' }],
        };
        const report = buildSecurityReport(result, true);
        expect(report).toContain('Overall Risk');
        expect(report).toContain('HIGH');
    });

    it('shows block warning when blocked', () => {
        const result = {
            overallRisk: 'critical',
            vulnerabilities: [{ severity: 'critical', type: 'RCE', file: 'exec.js', description: 'RCE', suggestion: 'Fix it' }],
        };
        const report = buildSecurityReport(result, true);
        expect(report).toContain('Merge diblokir');
    });

    it('renders vulnerability table rows', () => {
        const result = {
            overallRisk: 'medium',
            vulnerabilities: [{ severity: 'medium', type: 'CSRF', file: 'form.js', line: 10, description: 'CSRF issue', suggestion: 'Add token' }],
        };
        const report = buildSecurityReport(result, false);
        expect(report).toContain('`form.js:10`');
        expect(report).toContain('CSRF');
    });

    it('includes summary when provided', () => {
        const result = { overallRisk: 'low', vulnerabilities: [], summary: 'Nothing found here.' };
        const report = buildSecurityReport(result, false);
        expect(report).toContain('Nothing found here.');
    });

    it('escapes pipe characters in description and suggestion', () => {
        const result = {
            overallRisk: 'low',
            vulnerabilities: [{ severity: 'low', type: 'Info', file: 'a.js', description: 'a | b', suggestion: 'c | d' }],
        };
        const report = buildSecurityReport(result, false);
        expect(report).toContain('a \\| b');
        expect(report).toContain('c \\| d');
    });
});
