import { Octokit } from '@octokit/rest';
import { logger } from './logger.js';
import config from './config.js';

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
        const { data } = await this.octokit.pulls.get({
            owner,
            repo,
            pull_number: prNumber
        });
        return data;
    }

    // Post a comment on a PR
    async postComment(repoFullName, issueNumber, body) {
        const { owner, repo } = this._parseRepo(repoFullName);
        logger.info(`Posting comment to ${repoFullName}#${issueNumber}...`);
        await this.octokit.issues.createComment({
            owner,
            repo,
            issue_number: issueNumber,
            body
        });
    }

    // Get comment thread (for reply context)
    async getCommentThread(repoFullName, issueNumber) {
        const { owner, repo } = this._parseRepo(repoFullName);
        logger.info(`Fetching comments for ${repoFullName}#${issueNumber}...`);
        const { data } = await this.octokit.issues.listComments({
            owner,
            repo,
            issue_number: issueNumber
        });

        return data.map(c => `[${c.user.login}]: ${c.body}`).join('\n\n');
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
