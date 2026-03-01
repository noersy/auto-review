import { Command } from 'commander';
import { GitHubClient } from './github.js';
import { buildReviewPrompt, buildReplyPrompt, buildIssueFixPrompt, buildIssueValidationPrompt } from './prompts.js';
import { logger } from './logger.js';
import config from './config.js';
import { runProviderCLI } from './provider.js';
import { setupBranch, getChangedFiles, commitAndPush } from './git.js';
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

// Validate --repo format (must be "owner/repo")
if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(opts.repo)) {
    console.error(`Invalid --repo format: "${opts.repo}". Expected "owner/repo".`);
    process.exit(1);
}

// Validate --pr is a positive integer
if (!/^\d+$/.test(opts.pr)) {
    console.error(`Invalid --pr value: "${opts.pr}". Expected a positive integer.`);
    process.exit(1);
}

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
            const reviewBody = `## 🤖 ${opts.provider.toUpperCase()} Auto Review\n\n${reviewText}`;

            const existingReview = await gh.findBotReviewComment(opts.repo, opts.pr);
            if (existingReview) {
                await gh.updateComment(opts.repo, existingReview.id, reviewBody);
                logger.info('Existing review comment updated.');
            } else {
                await gh.postComment(opts.repo, opts.pr, reviewBody);
                logger.info('Review posted successfully.');
            }
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

            let validationResult;
            try {
                const jsonStrMatch = validationResultRaw.match(/\{[\s\S]*\}/);
                const jsonStr = jsonStrMatch ? jsonStrMatch[0] : validationResultRaw;
                validationResult = JSON.parse(jsonStr);
            } catch (err) {
                logger.error('Failed to parse validation result — aborting to avoid acting on ambiguous output. Raw: ' + validationResultRaw);
                return;
            }

            if (validationResult.isValid === false) {
                logger.info(`Issue #${opts.pr} validation failed: ${validationResult.reason}`);
                const rejectionMsg = `⚠️ **Auto-Fix Dibatalkan**\n\nIssue ini tidak memiliki konteks yang cukup untuk diperbaiki secara otomatis oleh bot.\n\n**Alasan:** ${validationResult.reason}\n\nSilakan lengkapi deskripsi issue (misalnya dengan menambahkan logs, pesan error, langkah reproduksi, atau letak file yang bermasalah) lalu tambahkan kembali label \`auto-fix\`.`;
                await gh.postComment(opts.repo, opts.pr, rejectionMsg);
                return;
            }

            // 2. Idempotency check — skip if a fix PR already exists
            const branchName = `auto-fix/issue-${opts.pr}`;
            const existingPR = await gh.findOpenPR(opts.repo, branchName);
            if (existingPR) {
                logger.info(`Open PR already exists for ${branchName}: ${existingPR.html_url} — skipping.`);
                return;
            }

            // 3. Proceed with Auto Fix
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
            if (!setupBranch(branchName, baseBranch, opts.repo, process.env.GITHUB_TOKEN)) return;

            // Let the LLM do the magic
            try {
                await runProviderCLI(opts.provider, prompt);
            } catch (err) {
                logger.error(`LLM CLI failed during auto-fix: ${err.message}`);
                await gh.postComment(opts.repo, opts.pr, `⚠️ **Auto-Fix Gagal**\n\nTerjadi error saat menjalankan LLM: ${err.message}\n\nSilakan cek log Jenkins untuk detail.`);
                return;
            }

            // Check for changes and commit
            const changedFiles = getChangedFiles();
            if (!changedFiles || changedFiles.length === 0) {
                await gh.postComment(opts.repo, opts.pr, '🤖 Maaf, saya tidak dapat menemukan solusi atau perubahan kode yang diperlukan untuk issue ini.');
                logger.info('No changes made by LLM.');
                return;
            }

            if (!commitAndPush(branchName, `Fix: ${issueData.title} (Resolves #${opts.pr})`, changedFiles)) {
                logger.error('Failed to commit or push changes.');
                await gh.postComment(opts.repo, opts.pr, '⚠️ **Auto-Fix Gagal**\n\nSaya berhasil membuat perubahan kode, namun gagal saat mencoba commit atau push ke repository. Silakan cek log Jenkins untuk detail.');
                return;
            }
            logger.info('Changes committed and pushed to remote.');

            const prBody = `Resolves #${opts.pr}\n\nDibuat secara otomatis oleh Auto-Reviewer Bot (${opts.provider}).`;
            const prResponse = await gh.createPullRequest(opts.repo, `Fix: ${issueData.title}`, prBody, branchName, baseBranch);

            await gh.postComment(opts.repo, opts.pr, `🤖 Saya telah mencoba memperbaiki issue ini. Silakan review Pull Request berikut: ${prResponse.html_url}`);
            logger.info(`Pull request created successfully: ${prResponse.html_url}`);
            return;
        }

        logger.info(`Action "${opts.action}" not handled. Terminating peacefully.`);

    } catch (error) {
        logger.error(`Fatal orchestration error: ${error.stack || error.message}`);
        process.exit(1);
    }
}

main();
