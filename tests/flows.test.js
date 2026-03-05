import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockGh = {
    checkMassivePR: jest.fn(),
    postComment: jest.fn(),
    getCommentsContext: jest.fn(),
    updateComment: jest.fn(),
    updatePRDescription: jest.fn(),
    addLabel: jest.fn(),
    removeLabel: jest.fn(),
    createCommitStatus: jest.fn(),
    getIssue: jest.fn(),
    findOpenPR: jest.fn(),
    getParentIssue: jest.fn(),
    branchExists: jest.fn(),
    getDefaultBranch: jest.fn(),
    createPullRequest: jest.fn(),
    closeIssue: jest.fn(),
    createPullRequestReview: jest.fn(),
};

const mockRunProviderCLI = jest.fn();
const mockSetupBranch = jest.fn();
const mockGetChangedFiles = jest.fn();
const mockCommitAndPush = jest.fn();
const mockParseSecurityResult = jest.fn();
const mockShouldBlockMerge = jest.fn();
const mockBuildSecurityReport = jest.fn();

jest.unstable_mockModule('../src/provider.js', () => ({ runProviderCLI: mockRunProviderCLI }));
jest.unstable_mockModule('../src/git.js', () => ({
    setupBranch: mockSetupBranch,
    getChangedFiles: mockGetChangedFiles,
    commitAndPush: mockCommitAndPush,
}));
jest.unstable_mockModule('../src/security.js', () => ({
    parseSecurityResult: mockParseSecurityResult,
    shouldBlockMerge: mockShouldBlockMerge,
    buildSecurityReport: mockBuildSecurityReport,
}));
jest.unstable_mockModule('../src/prompts.js', () => ({
    buildReviewPrompt: jest.fn(() => 'review-prompt'),
    buildReplyPrompt: jest.fn(() => 'reply-prompt'),
    buildSummaryPrompt: jest.fn(() => 'summary-prompt'),
    buildIssueFixPrompt: jest.fn(() => 'fix-prompt'),
    buildIssueFixRetryPrompt: jest.fn(() => 'fix-retry-prompt'),
    buildIssueValidationPrompt: jest.fn(() => 'validation-prompt'),
    buildSecurityScanPrompt: jest.fn(() => 'security-prompt'),
}));
jest.unstable_mockModule('../src/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { flowReview, flowReply, flowAutoFix, flowAutoClose } = await import('../src/flows.js');

// Helper: reset all mocks before each test
beforeEach(() => {
    Object.values(mockGh).forEach(fn => fn.mockReset());
    mockRunProviderCLI.mockReset();
    mockSetupBranch.mockReset();
    mockGetChangedFiles.mockReset();
    mockCommitAndPush.mockReset();
    mockParseSecurityResult.mockReset();
    mockShouldBlockMerge.mockReset();
    mockBuildSecurityReport.mockReset();
});

// ─── flowAutoClose ─────────────────────────────────────────────────────────

describe('flowAutoClose', () => {
    it('does nothing when headBranch is not auto-fix pattern', async () => {
        await flowAutoClose(mockGh, { repo: 'o/r', pr: 99, headBranch: 'feature/new-thing', dryRun: false });
        expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });

    it('calls closeIssue with correct issue number', async () => {
        mockGh.closeIssue.mockResolvedValue();
        await flowAutoClose(mockGh, { repo: 'o/r', pr: 99, headBranch: 'auto-fix/issue-42', dryRun: false });
        expect(mockGh.closeIssue).toHaveBeenCalledWith('o/r', 42, expect.stringContaining('#99'));
    });

    it('skips closeIssue in dryRun mode', async () => {
        await flowAutoClose(mockGh, { repo: 'o/r', pr: 99, headBranch: 'auto-fix/issue-42', dryRun: true });
        expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });
});

// ─── flowReply ─────────────────────────────────────────────────────────────

describe('flowReply', () => {
    const baseArgs = { repo: 'o/r', pr: 5, provider: 'gemini', sender: 'alice', commentBody: 'Hey bot!', dryRun: false };

    it('ignores when sender is the bot itself', async () => {
        await flowReply(mockGh, { ...baseArgs, sender: 'fei-reviewer' });
        expect(mockGh.getCommentsContext).not.toHaveBeenCalled();
    });

    it('ignores when sender is undefined', async () => {
        await flowReply(mockGh, { ...baseArgs, sender: undefined });
        expect(mockGh.getCommentsContext).not.toHaveBeenCalled();
    });

    it('respects reply cooldown', async () => {
        mockGh.getCommentsContext.mockResolvedValue({ lastBotReplyTime: Date.now() - 1000, thread: '' });
        await flowReply(mockGh, baseArgs);
        expect(mockRunProviderCLI).not.toHaveBeenCalled();
    });

    it('posts reply when outside cooldown', async () => {
        mockGh.getCommentsContext.mockResolvedValue({ lastBotReplyTime: 0, thread: 'some thread' });
        mockRunProviderCLI.mockResolvedValue('Here is my reply!');
        mockGh.postComment.mockResolvedValue();
        await flowReply(mockGh, baseArgs);
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 5, 'Here is my reply!');
    });

    it('posts error comment when LLM fails', async () => {
        mockGh.getCommentsContext.mockResolvedValue({ lastBotReplyTime: 0, thread: '' });
        mockRunProviderCLI.mockRejectedValue(new Error('LLM crash'));
        mockGh.postComment.mockResolvedValue();
        await flowReply(mockGh, baseArgs);
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 5, expect.stringContaining('Gagal'));
    });

    it('posts timeout comment when LLM times out', async () => {
        mockGh.getCommentsContext.mockResolvedValue({ lastBotReplyTime: 0, thread: '' });
        mockRunProviderCLI.mockRejectedValue(new Error('CLI timed out after 30 minutes'));
        mockGh.postComment.mockResolvedValue();
        await flowReply(mockGh, baseArgs);
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 5, expect.stringContaining('Timeout'));
    });

    it('skips posting in dryRun mode', async () => {
        mockGh.getCommentsContext.mockResolvedValue({ lastBotReplyTime: 0, thread: '' });
        mockRunProviderCLI.mockResolvedValue('Reply text');
        await flowReply(mockGh, { ...baseArgs, dryRun: true });
        expect(mockGh.postComment).not.toHaveBeenCalled();
    });
});

// ─── flowReview ─────────────────────────────────────────────────────────────

describe('flowReview', () => {
    const prData = {
        title: 'My PR',
        body: 'description',
        additions: 100,
        deletions: 20,
        base: { ref: 'main' },
        head: { sha: 'abc1234567890' },
    };

    beforeEach(() => {
        mockGh.checkMassivePR.mockResolvedValue({ isMassive: false, prData });
        mockGh.getCommentsContext.mockResolvedValue({ existingReview: null, lastBotReplyTime: 0, thread: '' });
        mockRunProviderCLI.mockResolvedValue('Review text');
        mockParseSecurityResult.mockReturnValue(null); // security scan skipped
    });

    it('posts massive PR warning and returns when PR is too large', async () => {
        mockGh.checkMassivePR.mockResolvedValue({ isMassive: true, prData: { ...prData, additions: 4000, deletions: 2000 } });
        mockGh.postComment.mockResolvedValue();
        await flowReview(mockGh, 'o/r', 1, 'gemini', false);
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 1, expect.stringContaining('Dibatalkan'));
        expect(mockRunProviderCLI).not.toHaveBeenCalled();
    });

    it('skips auto-review when PR is a draft and options.ignoreDrafts is true', async () => {
        const draftPR = { ...prData, draft: true };
        mockGh.checkMassivePR.mockResolvedValue({ isMassive: false, prData: draftPR });

        await flowReview(mockGh, 'o/r', 1, 'gemini', false, { ignoreDrafts: true });

        expect(mockRunProviderCLI).not.toHaveBeenCalled();
        expect(mockGh.postComment).not.toHaveBeenCalled();
        expect(mockGh.updatePRDescription).not.toHaveBeenCalled();
    });

    it('processes auto-review when PR is a draft but options.ignoreDrafts is false', async () => {
        const draftPR = { ...prData, draft: true };
        mockGh.checkMassivePR.mockResolvedValue({ isMassive: false, prData: draftPR });
        mockGh.postComment.mockResolvedValue();
        mockGh.removeLabel.mockResolvedValue();
        mockGh.createCommitStatus.mockResolvedValue();

        await flowReview(mockGh, 'o/r', 1, 'gemini', false, { ignoreDrafts: false });

        expect(mockRunProviderCLI).toHaveBeenCalled();
        expect(mockGh.postComment).toHaveBeenCalled();
    });

    it('processes auto-review when PR is not a draft and options.ignoreDrafts is true', async () => {
        const nonDraftPR = { ...prData, draft: false };
        mockGh.checkMassivePR.mockResolvedValue({ isMassive: false, prData: nonDraftPR });
        mockGh.postComment.mockResolvedValue();
        mockGh.removeLabel.mockResolvedValue();
        mockGh.createCommitStatus.mockResolvedValue();

        await flowReview(mockGh, 'o/r', 1, 'gemini', false, { ignoreDrafts: true });

        expect(mockRunProviderCLI).toHaveBeenCalled();
        expect(mockGh.postComment).toHaveBeenCalled();
    });

    it('posts new review comment when no existing review', async () => {
        mockGh.postComment.mockResolvedValue();
        mockGh.removeLabel.mockResolvedValue();
        mockGh.createCommitStatus.mockResolvedValue();
        // security: clean scan
        mockParseSecurityResult.mockReturnValue({ overallRisk: 'low', vulnerabilities: [] });
        mockShouldBlockMerge.mockReturnValue(false);
        mockBuildSecurityReport.mockReturnValue('Security report');

        await flowReview(mockGh, 'o/r', 1, 'gemini', false);
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 1, expect.stringContaining('<!-- auto-review-bot -->'));
    });

    it('updates existing review comment when one already exists', async () => {
        mockGh.getCommentsContext.mockResolvedValue({ existingReview: { id: 999 }, lastBotReplyTime: 0, thread: '' });
        mockGh.updateComment.mockResolvedValue();
        mockGh.removeLabel.mockResolvedValue();
        mockGh.createCommitStatus.mockResolvedValue();
        mockParseSecurityResult.mockReturnValue({ overallRisk: 'low', vulnerabilities: [] });
        mockShouldBlockMerge.mockReturnValue(false);
        mockBuildSecurityReport.mockReturnValue('report');

        await flowReview(mockGh, 'o/r', 1, 'gemini', false);
        expect(mockGh.updateComment).toHaveBeenCalledWith('o/r', 999, expect.stringContaining('<!-- auto-review-bot -->'));
        expect(mockGh.postComment).not.toHaveBeenCalledWith('o/r', 1, expect.stringContaining('<!-- auto-review-bot -->'));
    });

    it('updates PR description when body is empty', async () => {
        const emptyBodyPR = { ...prData, body: '' };
        mockGh.checkMassivePR.mockResolvedValue({ isMassive: false, prData: emptyBodyPR });
        // second CLI call = summary
        mockRunProviderCLI.mockResolvedValueOnce('Review').mockResolvedValueOnce('Generated summary');
        mockGh.updatePRDescription.mockResolvedValue();
        mockGh.postComment.mockResolvedValue();
        mockParseSecurityResult.mockReturnValue(null);

        await flowReview(mockGh, 'o/r', 1, 'gemini', false);
        expect(mockGh.updatePRDescription).toHaveBeenCalledWith('o/r', 1, 'Generated summary');
    });

    it('does not update PR description when body is present', async () => {
        await flowReview(mockGh, 'o/r', 1, 'gemini', false);
        expect(mockGh.updatePRDescription).not.toHaveBeenCalled();
    });

    it('posts error comment when LLM fails', async () => {
        mockRunProviderCLI.mockRejectedValue(new Error('LLM exploded'));
        mockGh.postComment.mockResolvedValue();
        await flowReview(mockGh, 'o/r', 1, 'gemini', false);
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 1, expect.stringContaining('Gagal'));
    });

    it('posts timeout comment when LLM times out', async () => {
        mockRunProviderCLI.mockRejectedValue(new Error('CLI timed out after 30 minutes'));
        mockGh.postComment.mockResolvedValue();
        await flowReview(mockGh, 'o/r', 1, 'gemini', false);
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 1, expect.stringContaining('Timeout'));
    });

    it('blocks merge and labels PR when security risk is critical', async () => {
        mockGh.postComment.mockResolvedValue();
        mockGh.addLabel.mockResolvedValue();
        mockGh.createCommitStatus.mockResolvedValue();
        const secResult = { overallRisk: 'critical', vulnerabilities: [{ severity: 'critical' }] };
        mockParseSecurityResult.mockReturnValue(secResult);
        mockShouldBlockMerge.mockReturnValue(true);
        mockBuildSecurityReport.mockReturnValue('Security report blocked');

        await flowReview(mockGh, 'o/r', 1, 'gemini', false);
        expect(mockGh.addLabel).toHaveBeenCalledWith('o/r', 1, 'security-risk');
        expect(mockGh.createCommitStatus).toHaveBeenCalledWith('o/r', prData.head.sha, 'failure', expect.any(String), expect.any(String));
    });

    it('skips all GitHub writes in dryRun mode', async () => {
        await flowReview(mockGh, 'o/r', 1, 'gemini', true);
        expect(mockGh.postComment).not.toHaveBeenCalled();
        expect(mockGh.updateComment).not.toHaveBeenCalled();
        expect(mockGh.updatePRDescription).not.toHaveBeenCalled();
    });

    it('sets success commit status and removes label when medium/low findings', async () => {
        mockGh.postComment.mockResolvedValue();
        mockGh.removeLabel.mockResolvedValue();
        mockGh.createCommitStatus.mockResolvedValue();
        const secResult = { overallRisk: 'medium', vulnerabilities: [{ severity: 'medium' }] };
        mockParseSecurityResult.mockReturnValue(secResult);
        mockShouldBlockMerge.mockReturnValue(false); // medium does not block
        mockBuildSecurityReport.mockReturnValue('Minor findings report');

        await flowReview(mockGh, 'o/r', 1, 'gemini', false);
        expect(mockGh.removeLabel).toHaveBeenCalledWith('o/r', 1, 'security-risk');
        expect(mockGh.createCommitStatus).toHaveBeenCalledWith('o/r', prData.head.sha, 'success', expect.any(String), expect.any(String));
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 1, 'Minor findings report');
    });

    it('sets success status and removes label silently when scan is clean (no comment)', async () => {
        mockGh.removeLabel.mockResolvedValue();
        mockGh.createCommitStatus.mockResolvedValue();
        mockGh.postComment.mockResolvedValue();
        const secResult = { overallRisk: 'none', vulnerabilities: [] };
        mockParseSecurityResult.mockReturnValue(secResult);
        mockShouldBlockMerge.mockReturnValue(false);

        await flowReview(mockGh, 'o/r', 1, 'gemini', false);
        expect(mockGh.removeLabel).toHaveBeenCalledWith('o/r', 1, 'security-risk');
        expect(mockGh.createCommitStatus).toHaveBeenCalledWith('o/r', prData.head.sha, 'success', expect.any(String), expect.any(String));
        // clean scan should NOT post an extra security comment
        const securityCommentCalls = mockGh.postComment.mock.calls.filter(c => String(c[2]).includes('Security'));
        expect(securityCommentCalls).toHaveLength(0);
    });

    it('skips dryRun security actions when blocked', async () => {
        const secResult = { overallRisk: 'critical', vulnerabilities: [{ severity: 'critical' }] };
        mockParseSecurityResult.mockReturnValue(secResult);
        mockShouldBlockMerge.mockReturnValue(true);
        mockBuildSecurityReport.mockReturnValue('Blocked report');

        await flowReview(mockGh, 'o/r', 1, 'gemini', true);
        expect(mockGh.addLabel).not.toHaveBeenCalled();
        expect(mockGh.createCommitStatus).not.toHaveBeenCalled();
    });

    it('parses JSON and posts inline comments via createPullRequestReview', async () => {
        mockGh.postComment.mockResolvedValue();
        mockGh.createPullRequestReview.mockResolvedValue();
        mockParseSecurityResult.mockReturnValue(null);
        mockShouldBlockMerge.mockReturnValue(false);

        const jsonOutput = `
<json>
{
  "summary": "Great PR overall.",
  "inline_comments": [
    { "file": "src/index.js", "line": 10, "comment": "Fix this typo." }
  ]
}
</json>`;
        mockRunProviderCLI.mockResolvedValue(jsonOutput);

        await flowReview(mockGh, 'o/r', 1, 'gemini', false);

        expect(mockGh.createPullRequestReview).toHaveBeenCalledWith(
            'o/r', 1, 'COMMENT', expect.any(String),
            [{ path: 'src/index.js', line: 10, body: 'Fix this typo.' }]
        );
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 1, expect.stringContaining('Great PR overall.'));
    });

    it('falls back to main comment when inline comments fail to post', async () => {
        mockGh.postComment.mockResolvedValue();
        mockGh.createPullRequestReview.mockRejectedValue(Object.assign(new Error('Invalid line'), { status: 422 }));
        mockParseSecurityResult.mockReturnValue(null);
        mockShouldBlockMerge.mockReturnValue(false);

        const jsonOutput = `
<json>
{
  "summary": "Great PR overall.",
  "inline_comments": [
    { "file": "src/index.js", "line": 999, "comment": "Out of diff." }
  ]
}
</json>`;
        mockRunProviderCLI.mockResolvedValue(jsonOutput);

        await flowReview(mockGh, 'o/r', 1, 'gemini', false);

        expect(mockGh.createPullRequestReview).toHaveBeenCalled();
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 1, expect.stringContaining('Inline Comments (Fallback)'));
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 1, expect.stringContaining('Out of diff.'));
    });

    it('handles LLM output lacking proper JSON format by falling back to full text', async () => {
        mockGh.postComment.mockResolvedValue();
        mockGh.createPullRequestReview.mockResolvedValue();
        mockParseSecurityResult.mockReturnValue(null);
        mockShouldBlockMerge.mockReturnValue(false);

        mockRunProviderCLI.mockResolvedValue('Just some markdown text without json tags.');

        await flowReview(mockGh, 'o/r', 1, 'gemini', false);

        expect(mockGh.createPullRequestReview).not.toHaveBeenCalled();
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 1, expect.stringContaining('Just some markdown text without json tags.'));
    });
});

// ─── flowAutoFix ───────────────────────────────────────────────────────────

describe('flowAutoFix', () => {
    const issueData = { number: 7, title: 'Bug: something broken', body: 'Steps to reproduce...' };
    const validOk = JSON.stringify({ isValid: true });
    const validFail = JSON.stringify({ isValid: false, reason: 'Not enough context' });

    beforeEach(() => {
        mockGh.getIssue.mockResolvedValue(issueData);
        mockGh.findOpenPR.mockResolvedValue(null);
        mockGh.getParentIssue.mockResolvedValue(null);
        mockGh.getDefaultBranch.mockResolvedValue('main');
        mockSetupBranch.mockReturnValue(true);
        mockRunProviderCLI.mockResolvedValue(validOk);
        mockGetChangedFiles.mockReturnValue(['src/fix.js']);
        mockCommitAndPush.mockReturnValue(true);
        mockGh.createPullRequest.mockResolvedValue({ html_url: 'https://github.com/o/r/pull/8' });
        mockGh.postComment.mockResolvedValue();
    });

    it('aborts when validation JSON is invalid', async () => {
        mockRunProviderCLI.mockResolvedValue('not json');
        await flowAutoFix(mockGh, { repo: 'o/r', pr: 7, provider: 'gemini', dryRun: false });
        expect(mockSetupBranch).not.toHaveBeenCalled();
    });

    it('posts rejection comment when issue is invalid', async () => {
        mockRunProviderCLI.mockResolvedValue(validFail);
        await flowAutoFix(mockGh, { repo: 'o/r', pr: 7, provider: 'gemini', dryRun: false });
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 7, expect.stringContaining('Dibatalkan'));
        expect(mockSetupBranch).not.toHaveBeenCalled();
    });

    it('skips when open PR already exists (idempotency)', async () => {
        mockRunProviderCLI.mockResolvedValue(validOk);
        mockGh.findOpenPR.mockResolvedValue({ html_url: 'https://github.com/o/r/pull/5', number: 5 });
        await flowAutoFix(mockGh, { repo: 'o/r', pr: 7, provider: 'gemini', dryRun: false });
        expect(mockSetupBranch).not.toHaveBeenCalled();
    });

    it('aborts when setupBranch fails', async () => {
        mockRunProviderCLI.mockResolvedValue(validOk);
        mockSetupBranch.mockReturnValue(false);
        await flowAutoFix(mockGh, { repo: 'o/r', pr: 7, provider: 'gemini', dryRun: false });
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 7, expect.stringContaining('Gagal'));
        expect(mockCommitAndPush).not.toHaveBeenCalled();
    });

    it('posts no-changes comment when LLM makes no edits', async () => {
        mockRunProviderCLI.mockResolvedValueOnce(validOk)  // validation
            .mockResolvedValueOnce('did nothing')           // fix attempt
            .mockResolvedValueOnce('retry did nothing');    // retry
        mockGetChangedFiles.mockReturnValue([]);
        await flowAutoFix(mockGh, { repo: 'o/r', pr: 7, provider: 'gemini', dryRun: false });
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 7, expect.stringContaining('Tidak Ada Perubahan'));
    });

    it('creates PR and posts success comment on happy path', async () => {
        mockRunProviderCLI
            .mockResolvedValueOnce(validOk)       // validation
            .mockResolvedValueOnce('fix code')    // fix
            .mockResolvedValueOnce('PR summary'); // summary

        await flowAutoFix(mockGh, { repo: 'o/r', pr: 7, provider: 'gemini', dryRun: false });
        expect(mockGh.createPullRequest).toHaveBeenCalled();
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 7, expect.stringContaining('Selesai'));
    });

    it('branches from parent issue when parent branch exists', async () => {
        mockGh.getParentIssue.mockResolvedValue({ number: 3 });
        mockGh.branchExists.mockResolvedValue(true);
        mockRunProviderCLI
            .mockResolvedValueOnce(validOk)
            .mockResolvedValueOnce('fix code')
            .mockResolvedValueOnce('summary');

        await flowAutoFix(mockGh, { repo: 'o/r', pr: 7, provider: 'gemini', dryRun: false });
        expect(mockSetupBranch).toHaveBeenCalledWith('auto-fix/issue-7', 'auto-fix/issue-3', 'o/r', undefined);
    });

    it('falls back to default branch when parent branch missing', async () => {
        mockGh.getParentIssue.mockResolvedValue({ number: 3 });
        mockGh.branchExists.mockResolvedValue(false);
        mockGh.getDefaultBranch.mockResolvedValue('develop');
        mockRunProviderCLI
            .mockResolvedValueOnce(validOk)
            .mockResolvedValueOnce('fix code')
            .mockResolvedValueOnce('summary');

        await flowAutoFix(mockGh, { repo: 'o/r', pr: 7, provider: 'gemini', dryRun: false });
        expect(mockSetupBranch).toHaveBeenCalledWith('auto-fix/issue-7', 'develop', 'o/r', undefined);
    });

    it('dry-run: does not push or create PR', async () => {
        mockRunProviderCLI
            .mockResolvedValueOnce(validOk)
            .mockResolvedValueOnce('fix code')
            .mockResolvedValueOnce('summary');

        await flowAutoFix(mockGh, { repo: 'o/r', pr: 7, provider: 'gemini', dryRun: true });
        expect(mockCommitAndPush).not.toHaveBeenCalled();
        expect(mockGh.createPullRequest).not.toHaveBeenCalled();
    });

    it('posts error comment when LLM fix step throws', async () => {
        mockRunProviderCLI
            .mockResolvedValueOnce(validOk)           // validation OK
            .mockRejectedValueOnce(new Error('LLM crashed')); // fix step fails
        await flowAutoFix(mockGh, { repo: 'o/r', pr: 7, provider: 'gemini', dryRun: false });
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 7, expect.stringContaining('Gagal'));
        expect(mockCommitAndPush).not.toHaveBeenCalled();
    });

    it('posts error comment when getChangedFiles returns null (git error)', async () => {
        mockRunProviderCLI
            .mockResolvedValueOnce(validOk)
            .mockResolvedValueOnce('fix code');
        mockGetChangedFiles.mockReturnValue(null); // git status failed
        await flowAutoFix(mockGh, { repo: 'o/r', pr: 7, provider: 'gemini', dryRun: false });
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 7, expect.stringContaining('Gagal'));
        expect(mockCommitAndPush).not.toHaveBeenCalled();
    });

    it('posts error comment when commitAndPush returns false', async () => {
        mockRunProviderCLI
            .mockResolvedValueOnce(validOk)
            .mockResolvedValueOnce('fix code')
            .mockResolvedValueOnce('summary');
        mockCommitAndPush.mockReturnValue(false);
        await flowAutoFix(mockGh, { repo: 'o/r', pr: 7, provider: 'gemini', dryRun: false });
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 7, expect.stringContaining('Gagal'));
        expect(mockGh.createPullRequest).not.toHaveBeenCalled();
    });

    it('aborts when validation result shape is invalid (missing isValid)', async () => {
        mockRunProviderCLI.mockResolvedValue(JSON.stringify({ reason: 'ok' })); // no isValid field
        await flowAutoFix(mockGh, { repo: 'o/r', pr: 7, provider: 'gemini', dryRun: false });
        expect(mockSetupBranch).not.toHaveBeenCalled();
    });

    it('skips rejection comment in dryRun when issue is invalid', async () => {
        mockRunProviderCLI.mockResolvedValue(validFail);
        await flowAutoFix(mockGh, { repo: 'o/r', pr: 7, provider: 'gemini', dryRun: true });
        expect(mockGh.postComment).not.toHaveBeenCalled();
    });

    it('posts error when second getChangedFiles returns null (git error before commit)', async () => {
        // First LLM attempt produces changes (skips retry),
        // but git status fails right before the commit step.
        mockRunProviderCLI
            .mockResolvedValueOnce(validOk)       // validation
            .mockResolvedValueOnce('fix code')    // fix
            .mockResolvedValueOnce('summary');    // PR description
        mockGetChangedFiles
            .mockReturnValueOnce(['src/fix.js'])  // first check: has changes → skip retry
            .mockReturnValueOnce(null);           // second check: git error before commit
        await flowAutoFix(mockGh, { repo: 'o/r', pr: 7, provider: 'gemini', dryRun: false });
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 7, expect.stringContaining('Gagal'));
        expect(mockCommitAndPush).not.toHaveBeenCalled();
    });

    it('posts error when retry LLM throws', async () => {
        // First attempt = no changes → triggers retry, retry throws
        mockRunProviderCLI
            .mockResolvedValueOnce(validOk)                           // validation
            .mockResolvedValueOnce('fix attempt')                     // fix (no changes)
            .mockRejectedValueOnce(new Error('Retry LLM crashed'));   // retry throws
        mockGetChangedFiles.mockReturnValue([]);
        await flowAutoFix(mockGh, { repo: 'o/r', pr: 7, provider: 'gemini', dryRun: false });
        expect(mockGh.postComment).toHaveBeenCalledWith('o/r', 7, expect.stringContaining('Gagal'));
    });

    it('includes issue title in commit message', async () => {
        mockRunProviderCLI
            .mockResolvedValueOnce(validOk)
            .mockResolvedValueOnce('fix code')
            .mockResolvedValueOnce('summary');
        await flowAutoFix(mockGh, { repo: 'o/r', pr: 7, provider: 'gemini', dryRun: false });
        expect(mockCommitAndPush).toHaveBeenCalledWith(
            'auto-fix/issue-7',
            expect.stringContaining(issueData.title),
            ['src/fix.js']
        );
    });

    it('uses fallback PR body when summary generation fails', async () => {
        mockRunProviderCLI
            .mockResolvedValueOnce(validOk)
            .mockResolvedValueOnce('fix code')
            .mockRejectedValueOnce(new Error('summary failed')); // summary step fails
        await flowAutoFix(mockGh, { repo: 'o/r', pr: 7, provider: 'gemini', dryRun: false });
        expect(mockGh.createPullRequest).toHaveBeenCalledWith(
            'o/r',
            expect.any(String),
            expect.stringContaining('Dibuat secara otomatis'),
            'auto-fix/issue-7',
            'main'
        );
    });
});
