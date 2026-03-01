import { Octokit } from '@octokit/rest';
import { logger } from './logger.js';
import config from './config.js';

const RETRYABLE_STATUS = new Set([502, 503, 504]);

async function withRetry(fn, label, retries = 3, delayMs = 2000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const status = err.status ?? err.response?.status;
            if (attempt < retries && RETRYABLE_STATUS.has(status)) {
                logger.warn(`${label} failed with ${status} — retrying (${attempt}/${retries})...`);
                await new Promise(r => setTimeout(r, delayMs * attempt));
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

    // Find the bot's existing review comment on a PR, returns comment data or null
    async findBotReviewComment(repoFullName, issueNumber) {
        const { owner, repo } = this._parseRepo(repoFullName);
        const { data } = await withRetry(
            () => this.octokit.issues.listComments({ owner, repo, issue_number: issueNumber }),
            `LIST comments #${issueNumber}`
        );
        return data.find(c => c.user.login === config.BOT_USERNAME && c.body.startsWith('## 🤖')) ?? null;
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

    // Get comment thread (for reply context)
    async getCommentThread(repoFullName, issueNumber) {
        const { owner, repo } = this._parseRepo(repoFullName);
        logger.info(`Fetching comments for ${repoFullName}#${issueNumber}...`);
        const { data } = await withRetry(
            () => this.octokit.issues.listComments({ owner, repo, issue_number: issueNumber }),
            `GET comments #${issueNumber}`
        );
        return data.map(c => `[${c.user.login}]: ${c.body}`).join('\n\n');
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
            await this.octokit.repos.getBranch({ owner, repo, branch });
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
