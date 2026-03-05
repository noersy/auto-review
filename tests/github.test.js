import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockOctokit = {
    pulls: {
        get: jest.fn(),
        list: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
    issues: {
        get: jest.fn(),
        listComments: jest.fn(),
        createComment: jest.fn(),
        updateComment: jest.fn(),
        addLabels: jest.fn(),
        removeLabel: jest.fn(),
        update: jest.fn(),
    },
    repos: {
        get: jest.fn(),
        getBranch: jest.fn(),
        createCommitStatus: jest.fn(),
    },
    request: jest.fn(),
    paginate: jest.fn(),
};

jest.unstable_mockModule('@octokit/rest', () => ({
    Octokit: jest.fn(() => mockOctokit),
}));

jest.unstable_mockModule('../src/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { GitHubClient } = await import('../src/github.js');

let gh;
beforeEach(() => {
    gh = new GitHubClient('fake-token');
    Object.values(mockOctokit.pulls).forEach(fn => fn.mockReset());
    Object.values(mockOctokit.issues).forEach(fn => fn.mockReset());
    Object.values(mockOctokit.repos).forEach(fn => fn.mockReset());
    mockOctokit.request.mockReset();
    mockOctokit.paginate.mockReset();
});

// ─── _parseRepo ────────────────────────────────────────────────────────────

describe('GitHubClient._parseRepo', () => {
    it('splits owner/repo correctly', () => {
        expect(gh._parseRepo('myorg/myrepo')).toEqual({ owner: 'myorg', repo: 'myrepo' });
    });
});

// ─── withRetry — tested via getPR ─────────────────────────────────────────

describe('withRetry — retry logic', () => {
    it('retries on 503 and succeeds on second attempt', async () => {
        const err = Object.assign(new Error('Service Unavailable'), { status: 503 });
        mockOctokit.pulls.get
            .mockRejectedValueOnce(err)
            .mockResolvedValueOnce({ data: { number: 1 } });
        const result = await gh.getPR('owner/repo', 1);
        expect(result).toEqual({ number: 1 });
        expect(mockOctokit.pulls.get).toHaveBeenCalledTimes(2);
    });

    it('retries on 502 and succeeds on second attempt', async () => {
        const err = Object.assign(new Error('Bad Gateway'), { status: 502 });
        mockOctokit.pulls.get
            .mockRejectedValueOnce(err)
            .mockResolvedValueOnce({ data: { number: 2 } });
        expect(await gh.getPR('owner/repo', 2)).toEqual({ number: 2 });
    });

    it('retries on 504 and succeeds on second attempt', async () => {
        const err = Object.assign(new Error('Gateway Timeout'), { status: 504 });
        mockOctokit.pulls.get
            .mockRejectedValueOnce(err)
            .mockResolvedValueOnce({ data: { number: 3 } });
        expect(await gh.getPR('owner/repo', 3)).toEqual({ number: 3 });
    });

    it('throws immediately on non-retryable status (400)', async () => {
        const err = Object.assign(new Error('Bad Request'), { status: 400 });
        mockOctokit.pulls.get.mockRejectedValue(err);
        await expect(gh.getPR('owner/repo', 1)).rejects.toThrow('Bad Request');
        expect(mockOctokit.pulls.get).toHaveBeenCalledTimes(1);
    });

    it('exhausts all 3 retries on persistent 503', async () => {
        const err = Object.assign(new Error('Service Unavailable'), { status: 503 });
        mockOctokit.pulls.get.mockRejectedValue(err);
        await expect(gh.getPR('owner/repo', 1)).rejects.toThrow('Service Unavailable');
        expect(mockOctokit.pulls.get).toHaveBeenCalledTimes(3);
    }, 15_000);

    it('respects numeric Retry-After header on 429', async () => {
        const err = Object.assign(new Error('Rate Limited'), {
            status: 429,
            response: { headers: { 'retry-after': '1' } },
        });
        mockOctokit.pulls.get
            .mockRejectedValueOnce(err)
            .mockResolvedValueOnce({ data: { number: 5 } });
        const result = await gh.getPR('owner/repo', 5);
        expect(result).toEqual({ number: 5 });
    }, 10_000);

    it('respects HTTP-date Retry-After header on 429', async () => {
        const soon = new Date(Date.now() + 500).toUTCString();
        const err = Object.assign(new Error('Rate Limited'), {
            status: 429,
            response: { headers: { 'retry-after': soon } },
        });
        mockOctokit.pulls.get
            .mockRejectedValueOnce(err)
            .mockResolvedValueOnce({ data: { number: 6 } });
        const result = await gh.getPR('owner/repo', 6);
        expect(result).toEqual({ number: 6 });
    }, 10_000);
});

// ─── getPR ─────────────────────────────────────────────────────────────────

describe('GitHubClient.getPR', () => {
    it('returns PR data with correct params', async () => {
        const prData = { number: 42, title: 'Test PR', additions: 10, deletions: 5 };
        mockOctokit.pulls.get.mockResolvedValue({ data: prData });
        const result = await gh.getPR('owner/repo', 42);
        expect(result).toEqual(prData);
        expect(mockOctokit.pulls.get).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', pull_number: 42 });
    });
});

// ─── checkMassivePR ────────────────────────────────────────────────────────

describe('GitHubClient.checkMassivePR', () => {
    it('returns isMassive: true when lines exceed threshold (5500)', async () => {
        const prData = { number: 1, additions: 4000, deletions: 2000 };
        mockOctokit.pulls.get.mockResolvedValue({ data: prData });
        const result = await gh.checkMassivePR('owner/repo', 1);
        expect(result.isMassive).toBe(true);
        expect(result.prData).toEqual(prData);
    });

    it('returns isMassive: false when lines are within threshold', async () => {
        const prData = { number: 2, additions: 100, deletions: 50 };
        mockOctokit.pulls.get.mockResolvedValue({ data: prData });
        expect((await gh.checkMassivePR('owner/repo', 2)).isMassive).toBe(false);
    });

    it('returns isMassive: false exactly at the threshold boundary (5500)', async () => {
        const prData = { number: 3, additions: 5500, deletions: 0 };
        mockOctokit.pulls.get.mockResolvedValue({ data: prData });
        expect((await gh.checkMassivePR('owner/repo', 3)).isMassive).toBe(false);
    });
});

// ─── getCommentsContext ────────────────────────────────────────────────────

describe('GitHubClient.getCommentsContext', () => {
    it('returns zero time, empty thread, null review when no comments', async () => {
        mockOctokit.paginate.mockResolvedValue([]);
        const ctx = await gh.getCommentsContext('owner/repo', 1);
        expect(ctx.lastBotReplyTime).toBe(0);
        expect(ctx.thread).toBe('');
        expect(ctx.existingReview).toBeNull();
    });

    it('identifies existing review by <!-- auto-review-bot --> marker', async () => {
        const comments = [{
            user: { login: 'fei-reviewer' },
            body: '<!-- auto-review-bot -->\nGreat PR!',
            created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
        }];
        mockOctokit.paginate.mockResolvedValue(comments);
        const ctx = await gh.getCommentsContext('owner/repo', 1);
        expect(ctx.existingReview).toBeTruthy();
        expect(ctx.existingReview.body).toContain('<!-- auto-review-bot -->');
    });

    it('picks the max of created_at and updated_at across all bot comments', async () => {
        const comments = [
            { user: { login: 'fei-reviewer' }, body: 'first', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
            { user: { login: 'fei-reviewer' }, body: 'second', created_at: '2024-01-02T00:00:00Z', updated_at: '2024-01-03T00:00:00Z' },
        ];
        mockOctokit.paginate.mockResolvedValue(comments);
        const ctx = await gh.getCommentsContext('owner/repo', 1);
        expect(ctx.lastBotReplyTime).toBe(new Date('2024-01-03T00:00:00Z').getTime());
    });

    it('formats thread as "[login]: body" joined by double newline', async () => {
        const comments = [
            { user: { login: 'alice' }, body: 'Hello', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
            { user: { login: 'bob' }, body: 'World', created_at: '2024-01-02T00:00:00Z', updated_at: '2024-01-02T00:00:00Z' },
        ];
        mockOctokit.paginate.mockResolvedValue(comments);
        const ctx = await gh.getCommentsContext('owner/repo', 1);
        expect(ctx.thread).toBe('[alice]: Hello\n\n[bob]: World');
    });

    it('non-bot comments do not affect lastBotReplyTime', async () => {
        const comments = [{
            user: { login: 'alice' }, body: 'LGTM!',
            created_at: '2024-06-01T00:00:00Z', updated_at: '2024-06-01T00:00:00Z',
        }];
        mockOctokit.paginate.mockResolvedValue(comments);
        const ctx = await gh.getCommentsContext('owner/repo', 1);
        expect(ctx.lastBotReplyTime).toBe(0);
    });
});

// ─── branchExists ──────────────────────────────────────────────────────────

describe('GitHubClient.branchExists', () => {
    it('returns true when branch exists', async () => {
        mockOctokit.repos.getBranch.mockResolvedValue({ data: { name: 'main' } });
        expect(await gh.branchExists('owner/repo', 'main')).toBe(true);
    });

    it('returns false on 404', async () => {
        const err = Object.assign(new Error('Not Found'), { status: 404 });
        mockOctokit.repos.getBranch.mockRejectedValue(err);
        expect(await gh.branchExists('owner/repo', 'missing')).toBe(false);
    });

    it('rethrows non-404 errors', async () => {
        const err = Object.assign(new Error('Server Error'), { status: 500 });
        mockOctokit.repos.getBranch.mockRejectedValue(err);
        await expect(gh.branchExists('owner/repo', 'branch')).rejects.toThrow('Server Error');
    });
});

// ─── findOpenPR ────────────────────────────────────────────────────────────

describe('GitHubClient.findOpenPR', () => {
    it('returns null when no open PRs', async () => {
        mockOctokit.pulls.list.mockResolvedValue({ data: [] });
        expect(await gh.findOpenPR('owner/repo', 'feature')).toBeNull();
    });

    it('returns first PR in the list', async () => {
        const pr = { number: 10, html_url: 'https://github.com/owner/repo/pull/10' };
        mockOctokit.pulls.list.mockResolvedValue({ data: [pr, { number: 11 }] });
        expect(await gh.findOpenPR('owner/repo', 'feature')).toEqual(pr);
    });
});

// ─── getParentIssue ────────────────────────────────────────────────────────

describe('GitHubClient.getParentIssue', () => {
    it('returns parent issue data', async () => {
        const parentData = { number: 5, title: 'Parent' };
        mockOctokit.request.mockResolvedValue({ data: parentData });
        expect(await gh.getParentIssue('owner/repo', 10)).toEqual(parentData);
    });

    it('returns null on 404', async () => {
        const err = Object.assign(new Error('Not Found'), { status: 404 });
        mockOctokit.request.mockRejectedValue(err);
        expect(await gh.getParentIssue('owner/repo', 10)).toBeNull();
    });

    it('rethrows non-404 errors', async () => {
        const err = Object.assign(new Error('Forbidden'), { status: 403 });
        mockOctokit.request.mockRejectedValue(err);
        await expect(gh.getParentIssue('owner/repo', 10)).rejects.toThrow('Forbidden');
    });
});

// ─── postComment ───────────────────────────────────────────────────────────

describe('GitHubClient.postComment', () => {
    it('calls createComment with correct params', async () => {
        mockOctokit.issues.createComment.mockResolvedValue({});
        await gh.postComment('owner/repo', 5, 'Nice PR!');
        expect(mockOctokit.issues.createComment).toHaveBeenCalledWith({
            owner: 'owner', repo: 'repo', issue_number: 5, body: 'Nice PR!',
        });
    });
});

// ─── updateComment ─────────────────────────────────────────────────────────

describe('GitHubClient.updateComment', () => {
    it('calls updateComment with correct params', async () => {
        mockOctokit.issues.updateComment.mockResolvedValue({});
        await gh.updateComment('owner/repo', 99, 'Updated body');
        expect(mockOctokit.issues.updateComment).toHaveBeenCalledWith({
            owner: 'owner', repo: 'repo', comment_id: 99, body: 'Updated body',
        });
    });
});

// ─── getIssue ─────────────────────────────────────────────────────────────

describe('GitHubClient.getIssue', () => {
    it('returns issue data', async () => {
        const issueData = { number: 7, title: 'Bug: crash', body: 'Steps...' };
        mockOctokit.issues.get.mockResolvedValue({ data: issueData });
        const result = await gh.getIssue('owner/repo', 7);
        expect(result).toEqual(issueData);
        expect(mockOctokit.issues.get).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', issue_number: 7 });
    });
});

// ─── getDefaultBranch ─────────────────────────────────────────────────────

describe('GitHubClient.getDefaultBranch', () => {
    it('returns the default_branch field from repo data', async () => {
        mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'develop' } });
        expect(await gh.getDefaultBranch('owner/repo')).toBe('develop');
    });
});

// ─── addLabel ──────────────────────────────────────────────────────────────

describe('GitHubClient.addLabel', () => {
    it('wraps label in array and calls addLabels with correct params', async () => {
        mockOctokit.issues.addLabels.mockResolvedValue({});
        await gh.addLabel('owner/repo', 5, 'security-risk');
        expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith({
            owner: 'owner', repo: 'repo', issue_number: 5, labels: ['security-risk'],
        });
    });
});

// ─── removeLabel ───────────────────────────────────────────────────────────

describe('GitHubClient.removeLabel', () => {
    it('resolves silently when label does not exist (404)', async () => {
        const err = Object.assign(new Error('Not Found'), { status: 404 });
        mockOctokit.issues.removeLabel.mockRejectedValue(err);
        await expect(gh.removeLabel('owner/repo', 1, 'security-risk')).resolves.toBeUndefined();
    });

    it('rethrows on non-404 error', async () => {
        const err = Object.assign(new Error('Server Error'), { status: 500 });
        mockOctokit.issues.removeLabel.mockRejectedValue(err);
        await expect(gh.removeLabel('owner/repo', 1, 'security-risk')).rejects.toThrow('Server Error');
    });
});

// ─── createCommitStatus ────────────────────────────────────────────────────

describe('GitHubClient.createCommitStatus', () => {
    it('calls createCommitStatus with all params', async () => {
        mockOctokit.repos.createCommitStatus.mockResolvedValue({});
        await gh.createCommitStatus('owner/repo', 'abc1234', 'failure', 'Security risk', 'auto-review/security');
        expect(mockOctokit.repos.createCommitStatus).toHaveBeenCalledWith({
            owner: 'owner', repo: 'repo',
            sha: 'abc1234', state: 'failure',
            description: 'Security risk', context: 'auto-review/security',
        });
    });
});

// ─── updatePRDescription ───────────────────────────────────────────────────

describe('GitHubClient.updatePRDescription', () => {
    it('calls pulls.update with the new body', async () => {
        mockOctokit.pulls.update.mockResolvedValue({});
        await gh.updatePRDescription('owner/repo', 42, 'New description');
        expect(mockOctokit.pulls.update).toHaveBeenCalledWith({
            owner: 'owner', repo: 'repo', pull_number: 42, body: 'New description',
        });
    });
});

// ─── createPullRequest ─────────────────────────────────────────────────────

describe('GitHubClient.createPullRequest', () => {
    it('returns created PR data', async () => {
        const pr = { number: 20, html_url: 'https://github.com/owner/repo/pull/20' };
        mockOctokit.pulls.create.mockResolvedValue({ data: pr });
        const result = await gh.createPullRequest('owner/repo', 'Fix bug', 'Body', 'auto-fix/issue-7', 'main');
        expect(result).toEqual(pr);
        expect(mockOctokit.pulls.create).toHaveBeenCalledWith({
            owner: 'owner', repo: 'repo',
            title: 'Fix bug', body: 'Body', head: 'auto-fix/issue-7', base: 'main',
        });
    });

    it('defaults base to "main" when not specified', async () => {
        mockOctokit.pulls.create.mockResolvedValue({ data: {} });
        await gh.createPullRequest('owner/repo', 'T', 'B', 'head-branch');
        expect(mockOctokit.pulls.create).toHaveBeenCalledWith(expect.objectContaining({ base: 'main' }));
    });
});

// ─── closeIssue ────────────────────────────────────────────────────────────

describe('GitHubClient.closeIssue', () => {
    it('posts a comment then closes the issue', async () => {
        mockOctokit.issues.createComment.mockResolvedValue({});
        mockOctokit.issues.update.mockResolvedValue({});
        await gh.closeIssue('owner/repo', 7, 'Closing this issue');
        expect(mockOctokit.issues.createComment).toHaveBeenCalledWith(
            expect.objectContaining({ issue_number: 7, body: 'Closing this issue' })
        );
        expect(mockOctokit.issues.update).toHaveBeenCalledWith(
            expect.objectContaining({ issue_number: 7, state: 'closed' })
        );
    });

    it('posts comment before closing (order matters)', async () => {
        const callOrder = [];
        mockOctokit.issues.createComment.mockImplementation(() => { callOrder.push('comment'); return Promise.resolve({}); });
        mockOctokit.issues.update.mockImplementation(() => { callOrder.push('close'); return Promise.resolve({}); });
        await gh.closeIssue('owner/repo', 7, 'Done');
        expect(callOrder).toEqual(['comment', 'close']);
    });
});
