import { describe, it, expect } from '@jest/globals';
import {
    buildReviewPrompt,
    buildReplyPrompt,
    buildSummaryPrompt,
    buildIssueFixPrompt,
    buildIssueFixRetryPrompt,
    buildSecurityScanPrompt,
    buildIssueValidationPrompt,
} from '../src/prompts.js';

// All prompt builders are pure functions — no mocks needed.

describe('buildReviewPrompt', () => {
    it('includes PR title, additions, deletions, branch, and repoDir', () => {
        const prompt = buildReviewPrompt('My PR', 120, 30, 'main', '/repo');
        expect(prompt).toContain('My PR');
        expect(prompt).toContain('+120');
        expect(prompt).toContain('-30');
        expect(prompt).toContain('origin/main');
        expect(prompt).toContain('/repo');
    });

    it('instructs not to ask for confirmation', () => {
        const prompt = buildReviewPrompt('T', 0, 0, 'main', '/repo');
        expect(prompt).toContain('DO NOT ask for confirmation');
    });

    it('returns a non-empty string', () => {
        expect(buildReviewPrompt('T', 0, 0, 'main', '/repo')).toBeTruthy();
    });
});

describe('buildReplyPrompt', () => {
    it('embeds conversation text inside <conversation> tags', () => {
        const prompt = buildReplyPrompt('alice: hello', '/repo');
        expect(prompt).toContain('<conversation>');
        expect(prompt).toContain('alice: hello');
        expect(prompt).toContain('</conversation>');
    });

    it('includes repoDir', () => {
        const prompt = buildReplyPrompt('thread', '/workspace/project');
        expect(prompt).toContain('/workspace/project');
    });

    it('marks conversation as untrusted', () => {
        const prompt = buildReplyPrompt('x', '/repo');
        expect(prompt).toContain('untrusted');
    });
});

describe('buildSummaryPrompt', () => {
    it('includes PR title, target branch, and repoDir', () => {
        const prompt = buildSummaryPrompt('Add feature X', 'develop', '/repo');
        expect(prompt).toContain('Add feature X');
        expect(prompt).toContain('origin/develop');
        expect(prompt).toContain('/repo');
    });

    it('instructs to return description text directly', () => {
        const prompt = buildSummaryPrompt('T', 'main', '/repo');
        expect(prompt).toContain('Return the description text directly');
    });
});

describe('buildIssueFixPrompt', () => {
    it('embeds issue title and body inside <issue> tags', () => {
        const prompt = buildIssueFixPrompt('Bug: crash', 'Steps: click button', '/repo');
        expect(prompt).toContain('<issue>');
        expect(prompt).toContain('Bug: crash');
        expect(prompt).toContain('Steps: click button');
        expect(prompt).toContain('</issue>');
    });

    it('includes repoDir', () => {
        const prompt = buildIssueFixPrompt('T', 'B', '/workspace');
        expect(prompt).toContain('/workspace');
    });

    it('marks issue content as untrusted', () => {
        const prompt = buildIssueFixPrompt('T', 'B', '/repo');
        expect(prompt).toContain('untrusted');
    });

    it('instructs to edit files directly', () => {
        const prompt = buildIssueFixPrompt('T', 'B', '/repo');
        expect(prompt).toContain('edit the files directly');
    });
});

describe('buildIssueFixRetryPrompt', () => {
    it('mentions previous attempt and no file changes', () => {
        const prompt = buildIssueFixRetryPrompt('Bug', 'Body', '/repo');
        expect(prompt).toContain('NO file changes');
    });

    it('includes issue title and body', () => {
        const prompt = buildIssueFixRetryPrompt('Crash on login', 'Steps here', '/repo');
        expect(prompt).toContain('Crash on login');
        expect(prompt).toContain('Steps here');
    });

    it('instructs to make at least one meaningful code change', () => {
        const prompt = buildIssueFixRetryPrompt('T', 'B', '/repo');
        expect(prompt).toContain('at least one meaningful code change');
    });
});

describe('buildSecurityScanPrompt', () => {
    it('includes PR title, target branch, and repoDir', () => {
        const prompt = buildSecurityScanPrompt('Add SQL query', 'main', '/repo');
        expect(prompt).toContain('Add SQL query');
        expect(prompt).toContain('origin/main');
        expect(prompt).toContain('/repo');
    });

    it('instructs to wrap response in <json> tags', () => {
        const prompt = buildSecurityScanPrompt('T', 'main', '/repo');
        expect(prompt).toContain('<json>');
        expect(prompt).toContain('</json>');
    });

    it('lists expected vulnerability types', () => {
        const prompt = buildSecurityScanPrompt('T', 'main', '/repo');
        expect(prompt).toContain('SQL Injection');
        expect(prompt).toContain('XSS');
        expect(prompt).toContain('Command Injection');
    });

    it('defines severity levels', () => {
        const prompt = buildSecurityScanPrompt('T', 'main', '/repo');
        expect(prompt).toContain('critical');
        expect(prompt).toContain('high');
        expect(prompt).toContain('medium');
        expect(prompt).toContain('low');
    });
});

describe('buildIssueValidationPrompt', () => {
    it('embeds issue title and body inside <issue> tags', () => {
        const prompt = buildIssueValidationPrompt('Feature: export CSV', 'Please add CSV export');
        expect(prompt).toContain('<issue>');
        expect(prompt).toContain('Feature: export CSV');
        expect(prompt).toContain('Please add CSV export');
        expect(prompt).toContain('</issue>');
    });

    it('requests JSON with isValid and reason fields', () => {
        const prompt = buildIssueValidationPrompt('T', 'B');
        expect(prompt).toContain('"isValid"');
        expect(prompt).toContain('"reason"');
    });

    it('wraps expected output in <json> tags', () => {
        const prompt = buildIssueValidationPrompt('T', 'B');
        expect(prompt).toContain('<json>');
        expect(prompt).toContain('</json>');
    });

    it('marks issue content as untrusted', () => {
        const prompt = buildIssueValidationPrompt('T', 'B');
        expect(prompt).toContain('untrusted');
    });
});
