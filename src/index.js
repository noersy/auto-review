import { spawn, execSync } from 'child_process';
import { Command } from 'commander';
import { GitHubClient } from './github.js';
import { buildReviewPrompt, buildReplyPrompt, buildIssueFixPrompt, buildIssueValidationPrompt } from './prompts.js';
import { logger } from './logger.js';
import config from './config.js';
import { runProviderCLI } from './provider.js';
import dotenv from 'dotenv';

dotenv.config();

const program = new Command();
program
    .requiredOption('--action <action>')
    .requiredOption('--repo <repo>')
    .requiredOption('--pr <number>')
    .option('--comment-body <body>', '')
    .option('--sender <login>', '')
    .option('--label-name <label>', '')
    .option('--provider <provider>', 'LLM CLI provider to use (claude/gemini)', 'claude');

program.parse();
const opts = program.opts();

// CLI Runner logic moved to src/provider.js

async function main() {
    const gh = new GitHubClient(process.env.GITHUB_TOKEN);

    try {
        const isNewPR = ['opened', 'synchronize', 'reopened'].includes(opts.action);
        const commentBody = (opts.commentBody === 'null' || !opts.commentBody) ? '' : opts.commentBody;
        const isReply = opts.action === 'created' && commentBody.includes(config.BOT_MENTION);

        // ===================================
        // FLOW A: New PR Review
        // ===================================
        if (isNewPR) {
            logger.info(`Triggered FLOW A: New PR Review for ${opts.repo}#${opts.pr}`);

            const { isMassive, prData } = await gh.checkMassivePR(opts.repo, opts.pr);
            if (isMassive) {
                await gh.postComment(opts.repo, opts.pr,
                    `⚠️ **Auto-Review Dibatalkan**\n\nPR ini mengubah total ${prData.additions + prData.deletions} baris kode (batas maksimum ${config.MASSIVE_PR_LINES}). Terlalu masif untuk di-review secara otomatis saat ini.\nSilakan review secara manual atau pecah PR menjadi bagian yang lebih kecil.`
                );
                logger.warn('Massive PR detected — aborted review.');
                return;
            }

            const targetBranch = prData.base.ref;
            const prompt = buildReviewPrompt(prData.title, prData.additions, prData.deletions, targetBranch);
            const reviewText = await runProviderCLI(opts.provider, prompt);
            await gh.postComment(opts.repo, opts.pr, `## 🤖 ${opts.provider.toUpperCase()} Auto Review\n\n${reviewText}`);
            logger.info('Review posted successfully');
            return;
        }

        // ===================================
        // FLOW B: Reply to Developer Comment
        // ===================================
        if (isReply) {
            if (opts.sender === config.BOT_USERNAME) {
                logger.info('Comment is from the bot itself — ignoring loop');
                return;
            }

            logger.info(`Triggered FLOW B: Reply Comment for ${opts.repo}#${opts.pr}`);

            const thread = await gh.getCommentThread(opts.repo, opts.pr);
            const prompt = buildReplyPrompt(thread);
            const replyText = await runProviderCLI(opts.provider, prompt);
            await gh.postComment(opts.repo, opts.pr, replyText);
            logger.info('Reply posted successfully');
            return;
        }

        // ===================================
        // FLOW C: Auto Fix Issue by Label
        // ===================================
        if (opts.action === 'labeled' && opts.labelName === config.AUTO_FIX_LABEL) {
            logger.info(`Triggered FLOW C: Auto Fix Issue for ${opts.repo}#${opts.pr}`);

            const issueData = await gh.getIssue(opts.repo, opts.pr);

            // 1. Issue Validation Step
            logger.info('Validating issue context...');
            const validationPrompt = buildIssueValidationPrompt(issueData.title, issueData.body);
            const validationResultRaw = await runProviderCLI(opts.provider, validationPrompt);

            let validationResult = { isValid: true };
            try {
                const jsonStrMatch = validationResultRaw.match(/\{[\s\S]*\}/);
                const jsonStr = jsonStrMatch ? jsonStrMatch[0] : validationResultRaw;
                validationResult = JSON.parse(jsonStr);
            } catch (err) {
                logger.warn('Failed to parse validation result. Assuming valid and proceeding. Raw output: ' + validationResultRaw);
            }

            if (validationResult.isValid === false) {
                logger.info(`Issue #${opts.pr} validation failed: ${validationResult.reason}`);
                const rejectionMsg = `⚠️ **Auto-Fix Dibatalkan**\n\nIssue ini tidak memiliki konteks yang cukup untuk diperbaiki secara otomatis oleh bot.\n\n**Alasan:** ${validationResult.reason}\n\nSilakan lengkapi deskripsi issue (misalnya dengan menambahkan logs, pesan error, langkah reproduksi, atau letak file yang bermasalah) lalu tambahkan kembali label \`auto-fix\`.`;
                await gh.postComment(opts.repo, opts.pr, rejectionMsg);
                return;
            }

            // 2. Proceed with Auto Fix
            const prompt = buildIssueFixPrompt(issueData.title, issueData.body);

            // Resolve base branch early — sub-issue branches off parent fix branch
            let baseBranch;
            if (issueData.parent_issue_url) {
                const parentNumber = issueData.parent_issue_url.split('/').pop();
                const parentBranch = `auto-fix/issue-${parentNumber}`;
                const parentExists = await gh.branchExists(opts.repo, parentBranch);
                if (parentExists) {
                    baseBranch = parentBranch;
                    logger.info(`Sub-issue detected — branching from parent: ${baseBranch}`);
                } else {
                    baseBranch = await gh.getDefaultBranch(opts.repo);
                    logger.warn(`Parent branch ${parentBranch} not found — falling back to ${baseBranch}`);
                }
            } else {
                baseBranch = await gh.getDefaultBranch(opts.repo);
            }

            // Setup Git context and branch
            const branchName = `auto-fix/issue-${opts.pr}`;
            try {
                process.chdir('/repo');
                execSync('git config --global user.email "bot@auto-reviewer.local"');
                execSync('git config --global user.name "Auto Reviewer Bot"');
                execSync('git config --global --add safe.directory /repo');
                execSync(`git remote set-url origin https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${opts.repo}.git`);
                execSync('git fetch origin');

                // Always create branch fresh from baseBranch
                execSync(`git checkout -B ${branchName} origin/${baseBranch}`);
                logger.info(`Checked out branch: ${branchName} (from ${baseBranch})`);
            } catch (err) {
                logger.error(`Failed to setup git branch: ${err.message}`);
                return;
            }

            // Let the LLM do the magic
            await runProviderCLI(opts.provider, prompt);

            // Check for changes and commit
            try {
                const diff = execSync('git status --porcelain').toString();
                if (!diff.trim()) {
                    await gh.postComment(opts.repo, opts.pr, '🤖 Maaf, saya tidak dapat menemukan solusi atau perubahan kode yang diperlukan untuk issue ini.');
                    logger.info('No changes made by LLM.');
                    return;
                }

                // Exclude credential files from commit
                execSync('git add .');
                execSync('git reset HEAD .claude-credentials.json .gemini-credentials.json .gemini-settings.json 2>/dev/null || true', { shell: true });
                execSync(`git commit -m "Fix: ${issueData.title} (Resolves #${opts.pr})"`);
                execSync(`git push -u origin ${branchName} --force`);
                logger.info('Changes committed and pushed to remote.');

                const prBody = `Resolves #${opts.pr}\n\nDibuat secara otomatis oleh Auto-Reviewer Bot (${opts.provider}).`;
                const prResponse = await gh.createPullRequest(opts.repo, `Fix: ${issueData.title}`, prBody, branchName, baseBranch);

                await gh.postComment(opts.repo, opts.pr, `🤖 Saya telah mencoba memperbaiki issue ini. Silakan review Pull Request berikut: ${prResponse.html_url}`);
                logger.info(`Pull request created successfully: ${prResponse.html_url}`);
            } catch (err) {
                logger.error(`Failed during commit/push/PR creation: ${err.message}`);
            }
            return;
        }

        logger.info(`Action "${opts.action}" not handled. Terminating peacefully.`);

    } catch (error) {
        logger.error(`Fatal orchestration error: ${error.stack || error.message}`);
        process.exit(1);
    }
}

main();
