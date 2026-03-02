import { logger } from './logger.js';
import config from './config.js';

const SEVERITY_EMOJI = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🟢',
};

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };

/**
 * Parse the structured JSON security result from raw LLM output.
 * Supports <json>...</json> tags and fallback brace-matching.
 * Returns parsed object or null on failure.
 */
export function parseSecurityResult(rawOutput) {
    try {
        const jsonMatch = rawOutput.match(/<json>([\s\S]*?)<\/json>/i);
        let jsonStr = rawOutput;

        if (jsonMatch) {
            jsonStr = jsonMatch[1];
        } else {
            const firstBrace = rawOutput.indexOf('{');
            const lastBrace = rawOutput.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
                jsonStr = rawOutput.slice(firstBrace, lastBrace + 1);
            }
        }

        const result = JSON.parse(jsonStr);

        // Validate shape
        if (typeof result !== 'object' || result === null || !Array.isArray(result.vulnerabilities)) {
            logger.error('Security scan result has unexpected shape: ' + JSON.stringify(result));
            return null;
        }

        return result;
    } catch (err) {
        logger.error('Failed to parse security scan result: ' + err.message);
        return null;
    }
}

/**
 * Determine whether the merge should be blocked based on overall risk.
 */
export function shouldBlockMerge(result) {
    if (!result || !result.overallRisk) return false;
    return config.SECURITY_BLOCK_ON.includes(result.overallRisk);
}

/**
 * Build a markdown security report from the parsed result.
 */
export function buildSecurityReport(result, blocked) {
    const header = blocked
        ? `## 🚨 Security Scan — Risiko Terdeteksi`
        : `## 🛡️ Security Scan — Selesai`;

    const lines = [`<!-- auto-review-security -->`, header, ''];

    if (result.summary) {
        lines.push(`> ${result.summary}`, '');
    }

    if (result.vulnerabilities.length === 0) {
        lines.push('Tidak ditemukan kerentanan keamanan pada perubahan ini. ✅');
        return lines.join('\n');
    }

    // Overall risk badge
    const riskEmoji = SEVERITY_EMOJI[result.overallRisk] || '⚪';
    lines.push(`**Overall Risk:** ${riskEmoji} \`${(result.overallRisk || 'unknown').toUpperCase()}\``);

    if (blocked) {
        lines.push('', '> ⛔ **Merge diblokir** — Perbaiki kerentanan `critical` / `high` sebelum merge.');
    }

    lines.push('', '### Detail Kerentanan', '');
    lines.push('| # | Severity | Type | File | Description | Suggestion |');
    lines.push('|---|----------|------|------|-------------|------------|');

    result.vulnerabilities.forEach((v, i) => {
        const emoji = SEVERITY_EMOJI[v.severity] || '⚪';
        const sev = `${emoji} ${(v.severity || '?').toUpperCase()}`;
        const file = v.line ? `\`${v.file}:${v.line}\`` : `\`${v.file || '?'}\``;
        const desc = (v.description || '-').replace(/\|/g, '\\|');
        const sugg = (v.suggestion || '-').replace(/\|/g, '\\|');
        lines.push(`| ${i + 1} | ${sev} | \`${v.type || '?'}\` | ${file} | ${desc} | ${sugg} |`);
    });

    return lines.join('\n');
}
