import { Octokit } from '@octokit/rest';
import { logger } from './logger.js';
import config from './config.js';

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

async function withRetry(fn, label, retries = 3, delayMs = 2000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const status = err.status ?? err.response?.status;
            if (attempt < retries && RETRYABLE_STATUS.has(status)) {
                let waitMs = delayMs * attempt;
                if (status === 429) {
                    const retryAfter = err.response?.headers?.['retry-after'];
                    if (retryAfter) {
                        const parsed = parseInt(retryAfter, 10);
                        waitMs = isNaN(parsed) ? delayMs * attempt : parsed * 1000;
                    }
                }
                logger.warn(`${label} failed with ${status} — retrying in ${waitMs}ms (${attempt}/${retries})...`);
                await new Promise(r => setTimeout(r, waitMs));
            } else {
                throw err;
            }
        }
    }
}

export class GitHubClient {
    constructor(token) {
        this.octokit = new Octokit({ auth: token });
    }

    // Parse "owner/repo" format
    _parseRepo(repoFullName) {
        const [owner, repo] = repoFullName.split('/');
        return { owner, repo };
    }

    // Get PR metadata (title, body, additions, deletions)
    async getPR(repoFullName, prNumber) {
        const { owner, repo } = this._parseRepo(repoFullName);
        logger.info(`Fetching PR metadata for ${repoFullName}#${prNumber}...`);
        const { data } = await withRetry(
            () => this.octokit.pulls.get({ owner, repo, pull_number: prNumber }),
            `GET PR #${prNumber}`
        );
        return data;
    }

    // Get Issue metadata (title, body)
    async getIssue(repoFullName, issueNumber) {
        const { owner, repo } = this._parseRepo(repoFullName);
        logger.info(`Fetching Issue metadata for ${repoFullName}#${issueNumber}...`);
        const { data } = await withRetry(
            () => this.octokit.issues.get({ owner, repo, issue_number: issueNumber }),
            `GET Issue #${issueNumber}`
        );
        return data;
    }

    // Update an existing comment by ID
    async updateComment(repoFullName, commentId, body) {
        const { owner, repo } = this._parseRepo(repoFullName);
        logger.info(`Updating comment ${commentId} on ${repoFullName}...`);
        await withRetry(
            () => this.octokit.issues.updateComment({ owner, repo, comment_id: commentId, body }),
            `PATCH comment ${commentId}`
        );
    }

    // Post a comment on a PR
    async postComment(repoFullName, issueNumber, body) {
        const { owner, repo } = this._parseRepo(repoFullName);
        logger.info(`Posting comment to ${repoFullName}#${issueNumber}...`);
        await withRetry(
            () => this.octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body }),
            `POST comment #${issueNumber}`
        );
    }

    // Fetch all comments once; returns { lastBotReplyTime, thread, existingReview }
    // lastBotReplyTime: ms timestamp of most recent bot comment (0 if none)
    // thread: formatted string of all comments for reply context
    // existingReview: bot's review comment (identified by <!-- auto-review-bot --> marker), or null
    async getCommentsContext(repoFullName, issueNumber) {
        const { owner, repo } = this._parseRepo(repoFullName);
        logger.info(`Fetching comments for ${repoFullName}#${issueNumber}...`);
        const comments = await withRetry(
            () => this.octokit.paginate(this.octokit.issues.listComments, {
                owner, repo, issue_number: issueNumber, per_page: 100
            }),
            `LIST comments #${issueNumber}`
        );
        const botComments = comments.filter(c => c.user.login === config.BOT_USERNAME);
        const lastBotReplyTime = botComments.length === 0 ? 0 : Math.max(
            ...botComments.map(c => Math.max(
                new Date(c.created_at).getTime(),
                new Date(c.updated_at).getTime()
            ))
        );
        const thread = comments.map(c => `[${c.user.login}]: ${c.body}`).join('\n\n');
        const existingReview = botComments.find(c => c.body.includes('<!-- auto-review-bot -->')) ?? null;
        return { lastBotReplyTime, thread, existingReview };
    }

    // Get default branch of a repo
    async getDefaultBranch(repoFullName) {
        const { owner, repo } = this._parseRepo(repoFullName);
        const { data } = await withRetry(
            () => this.octokit.repos.get({ owner, repo }),
            `GET repo ${repoFullName}`
        );
        return data.default_branch;
    }

    // Check if a branch exists on remote
    async branchExists(repoFullName, branch) {
        const { owner, repo } = this._parseRepo(repoFullName);
        try {
            await withRetry(
                () => this.octokit.repos.getBranch({ owner, repo, branch }),
                `GET branch ${branch}`
            );
            return true;
        } catch (err) {
            if (err.status === 404) return false;
            throw err;
        }
    }

    // Find an open PR by head branch name, returns PR data or null
    async findOpenPR(repoFullName, headBranch) {
        const { owner, repo } = this._parseRepo(repoFullName);
        const { data } = await withRetry(
            () => this.octokit.pulls.list({ owner, repo, head: `${owner}:${headBranch}`, state: 'open' }),
            `LIST PRs for ${headBranch}`
        );
        return data.length > 0 ? data[0] : null;
    }

    // Create a Pull Request
    async createPullRequest(repoFullName, title, body, head, base = 'main') {
        const { owner, repo } = this._parseRepo(repoFullName);
        logger.info(`Creating PR in ${repoFullName}: ${head} -> ${base}...`);
        const { data } = await withRetry(
            () => this.octokit.pulls.create({ owner, repo, title, body, head, base }),
            `CREATE PR ${head} -> ${base}`
        );
        return data;
    }

    // Close an issue with a comment
    async closeIssue(repoFullName, issueNumber, comment) {
        const { owner, repo } = this._parseRepo(repoFullName);
        await withRetry(
            () => this.octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body: comment }),
            `POST comment #${issueNumber}`
        );
        await withRetry(
            () => this.octokit.issues.update({ owner, repo, issue_number: issueNumber, state: 'closed' }),
            `CLOSE issue #${issueNumber}`
        );
        logger.info(`Issue #${issueNumber} closed.`);
    }

    // Update the body (description) of a PR
    async updatePRDescription(repoFullName, prNumber, body) {
        const { owner, repo } = this._parseRepo(repoFullName);
        logger.info(`Updating PR description for ${repoFullName}#${prNumber}...`);
        await withRetry(
            () => this.octokit.pulls.update({ owner, repo, pull_number: prNumber, body }),
            `PATCH PR #${prNumber} description`
        );
    }

    // Check if PR is "massive"
    async checkMassivePR(repoFullName, prNumber) {
        const pr = await this.getPR(repoFullName, prNumber);
        const totalLines = pr.additions + pr.deletions;
        logger.info(`PR #${prNumber}: +${pr.additions} -${pr.deletions} = ${totalLines} lines changed`);

        if (totalLines > config.MASSIVE_PR_LINES) {
            return { isMassive: true, prData: pr };
        }
        return { isMassive: false, prData: pr };
    }
}
