import { Command } from 'commander';
import { readFileSync } from 'fs';
import { GitHubClient } from './github.js';
import { buildReviewPrompt, buildReplyPrompt, buildIssueFixPrompt, buildIssueFixRetryPrompt, buildIssueValidationPrompt, buildSummaryPrompt } from './prompts.js';
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
    .option('--comment-body-file <path>', 'Path to file containing comment body (avoids shell injection)')
    .option('--sender <login>', '')
    .option('--label-name <label>', '')
    .option('--provider <provider>', 'LLM CLI provider to use (claude/gemini)', 'claude')
    .option('--merged', 'Whether the PR was merged (for closed action)', false)
    .option('--head-branch <branch>', 'Head branch of the closed PR', '')
    .option('--dry-run', 'Skip all GitHub and Git writes; LLM calls still run', false);

program.parse();
const opts = program.opts();

// Resolve comment body: prefer --comment-body-file over --comment-body
if (opts.commentBodyFile) {
    try {
        opts.commentBody = readFileSync(opts.commentBodyFile, 'utf8');
    } catch (err) {
        logger.warn(`Could not read --comment-body-file "${opts.commentBodyFile}": ${err.message}`);
        opts.commentBody = '';
    }
}

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

// Validate --action is a known value
const KNOWN_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'created', 'labeled', 'closed']);
if (!KNOWN_ACTIONS.has(opts.action)) {
    console.error(`Invalid --action value: "${opts.action}". Expected one of: ${[...KNOWN_ACTIONS].join(', ')}.`);
    process.exit(1);
}

// CLI Runner logic moved to src/provider.js

const REPO_DIR = process.env.REPO_DIR ?? '/repo';

async function runReview(gh, repo, prNumber, provider, dryRun) {
    const { isMassive, prData } = await gh.checkMassivePR(repo, prNumber);
    if (isMassive) {
        if (dryRun) {
            logger.info(`[DRY-RUN] Would post massive-PR warning to ${repo}#${prNumber}`);
        } else {
            await gh.postComment(repo, prNumber,
                `⚠️ **Auto-Review Dibatalkan**\n\nPR ini mengubah total ${prData.additions + prData.deletions} baris kode (batas maksimum ${config.MASSIVE_PR_LINES}). Terlalu masif untuk di-review secara otomatis saat ini.\nSilakan review secara manual atau pecah PR menjadi bagian yang lebih kecil.`
            );
        }
        logger.warn('Massive PR detected — aborted review.');
        return;
    }

    const targetBranch = prData.base.ref;
    const isPRBodyEmpty = !prData.body || !prData.body.trim();

    // Fetch comments and run review (+ optional summary) in parallel
    let existingReview, reviewText, summaryText;
    try {
        ([{ existingReview }, [reviewText, summaryText]] = await Promise.all([
            gh.getCommentsContext(repo, prNumber),
            Promise.all([
                runProviderCLI(provider, buildReviewPrompt(prData.title, prData.additions, prData.deletions, targetBranch, REPO_DIR)),
                isPRBodyEmpty
                    ? runProviderCLI(provider, buildSummaryPrompt(prData.title, targetBranch, REPO_DIR))
                    : Promise.resolve(null),
            ]),
        ]));
    } catch (err) {
        const isTimeout = err.message?.includes('timed out');
        const errBody = isTimeout
            ? `⚠️ **Auto-Review Timeout**\n\nLLM CLI tidak merespons dalam 10 menit. Silakan coba lagi dengan menambahkan label \`auto-review\`.`
            : `⚠️ **Auto-Review Gagal**\n\nTerjadi error: ${err.message}`;
        if (dryRun) {
            logger.info(`[DRY-RUN] Would post error comment to ${repo}#${prNumber}`);
        } else {
            await gh.postComment(repo, prNumber, errBody);
        }
        logger.error(`runReview failed: ${err.stack || err.message}`);
        return;
    }

    if (summaryText) {
        if (dryRun) {
            logger.info(`[DRY-RUN] Would update PR description for ${repo}#${prNumber}`);
        } else {
            await gh.updatePRDescription(repo, prNumber, summaryText);
            logger.info('PR description updated with auto-generated summary.');
        }
    }

    const reviewBody = `<!-- auto-review-bot -->\n## 🤖 ${provider.toUpperCase()} Auto Review\n\n${reviewText}`;
    if (existingReview) {
        if (dryRun) {
            logger.info(`[DRY-RUN] Would update existing review comment ${existingReview.id} on ${repo}#${prNumber}`);
        } else {
            await gh.updateComment(repo, existingReview.id, reviewBody);
            logger.info('Existing review comment updated.');
        }
    } else {
        if (dryRun) {
            logger.info(`[DRY-RUN] Would post new review comment to ${repo}#${prNumber}`);
        } else {
            await gh.postComment(repo, prNumber, reviewBody);
            logger.info('Review posted successfully.');
        }
    }
}

async function main() {
    if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_TOKEN.trim()) {
        console.error('Missing required environment variable: GITHUB_TOKEN');
        process.exit(1);
    }
    const gh = new GitHubClient(process.env.GITHUB_TOKEN);
    const dryRun = opts.dryRun;
    if (dryRun) logger.info('DRY-RUN MODE: GitHub and Git writes are disabled.');

    try {
        const isNewPR = ['opened', 'synchronize', 'reopened'].includes(opts.action);
        const commentBody = opts.commentBody || '';
        const isReply = opts.action === 'created' && commentBody.includes(config.BOT_MENTION);

        // ===================================
        // FLOW A: New PR Review
        // ===================================
        if (isNewPR) {
            logger.info(`Triggered FLOW A: New PR Review for ${opts.repo}#${opts.pr}`);
            await runReview(gh, opts.repo, opts.pr, opts.provider, dryRun);
            return;
        }

        // ===================================
        // FLOW B: Reply to Developer Comment
        // ===================================
        if (isReply) {
            if (!opts.sender || opts.sender === config.BOT_USERNAME) {
                logger.info('Comment is from the bot itself (or sender unknown) — ignoring loop');
                return;
            }

            const { lastBotReplyTime, thread } = await gh.getCommentsContext(opts.repo, opts.pr);
            if (Date.now() - lastBotReplyTime < config.REPLY_COOLDOWN_MS) {
                logger.info(`Reply cooldown active — ignoring comment on ${opts.repo}#${opts.pr}`);
                return;
            }

            logger.info(`Triggered FLOW B: Reply Comment for ${opts.repo}#${opts.pr}`);

            const prompt = buildReplyPrompt(thread, REPO_DIR);
            let replyText;
            try {
                replyText = await runProviderCLI(opts.provider, prompt);
            } catch (err) {
                const isTimeout = err.message?.includes('timed out');
                const errBody = isTimeout
                    ? `⚠️ **Reply Timeout**\n\nLLM CLI tidak merespons dalam 10 menit.`
                    : `⚠️ **Reply Gagal**\n\nError: ${err.message}`;
                if (dryRun) {
                    logger.info(`[DRY-RUN] Would post reply error comment to ${opts.repo}#${opts.pr}`);
                } else {
                    await gh.postComment(opts.repo, opts.pr, errBody);
                }
                return;
            }
            if (dryRun) {
                logger.info(`[DRY-RUN] Would post reply comment to ${opts.repo}#${opts.pr}`);
            } else {
                await gh.postComment(opts.repo, opts.pr, replyText);
            }
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
            const validationPrompt = buildIssueValidationPrompt(issueData.title, issueData.body ?? '');
            const validationResultRaw = await runProviderCLI(opts.provider, validationPrompt);

            let validationResult;
            try {
                // Use non-greedy match to avoid capturing past the first complete JSON object
                const jsonStrMatch = validationResultRaw.match(/\{[\s\S]*?\}/);
                const jsonStr = jsonStrMatch ? jsonStrMatch[0] : validationResultRaw;
                validationResult = JSON.parse(jsonStr);
            } catch (err) {
                logger.error('Failed to parse validation result — aborting to avoid acting on ambiguous output. Raw: ' + validationResultRaw);
                return;
            }

            // Validate parsed object has expected fields; treat missing/unexpected shape as invalid
            if (typeof validationResult !== 'object' || validationResult === null ||
                typeof validationResult.isValid !== 'boolean') {
                logger.error(`Validation result has unexpected shape — aborting. Parsed: ${JSON.stringify(validationResult)}`);
                return;
            }

            if (!validationResult.isValid) {
                const reason = typeof validationResult.reason === 'string' && validationResult.reason.trim()
                    ? validationResult.reason.trim()
                    : 'Tidak ada alasan yang diberikan oleh validator.';
                logger.info(`Issue #${opts.pr} validation failed: ${reason}`);
                const rejectionMsg = `⚠️ **Auto-Fix Dibatalkan**\n\nIssue ini tidak memiliki konteks yang cukup untuk diperbaiki secara otomatis oleh bot.\n\n**Alasan:** ${reason}\n\nSilakan lengkapi deskripsi issue (misalnya dengan menambahkan logs, pesan error, langkah reproduksi, atau letak file yang bermasalah) lalu tambahkan kembali label \`auto-fix\`.`;
                if (dryRun) {
                    logger.info(`[DRY-RUN] Would post validation rejection to ${opts.repo}#${opts.pr}`);
                } else {
                    await gh.postComment(opts.repo, opts.pr, rejectionMsg);
                }
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
            const prompt = buildIssueFixPrompt(issueData.title, issueData.body ?? '', REPO_DIR);

            // Resolve base branch — sub-issue branches off parent fix branch if one exists
            let baseBranch;
            const parentIssue = await gh.getParentIssue(opts.repo, opts.pr);
            if (parentIssue) {
                const parentBranch = `auto-fix/issue-${parentIssue.number}`;
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
            if (!setupBranch(branchName, baseBranch, opts.repo, process.env.GITHUB_TOKEN)) {
                logger.error('setupBranch failed — aborting auto-fix.');
                if (!dryRun) {
                    await gh.postComment(opts.repo, opts.pr, '⚠️ **Auto-Fix Gagal**\n\nGagal menyiapkan branch Git. Silakan cek log Jenkins untuk detail.');
                }
                return;
            }

            // Let the LLM do the magic
            try {
                await runProviderCLI(opts.provider, prompt);
            } catch (err) {
                logger.error(`LLM CLI failed during auto-fix: ${err.message}`);
                if (dryRun) {
                    logger.info(`[DRY-RUN] Would post LLM error comment to ${opts.repo}#${opts.pr}`);
                } else {
                    await gh.postComment(opts.repo, opts.pr, `⚠️ **Auto-Fix Gagal**\n\nTerjadi error saat menjalankan LLM: ${err.message}\n\nSilakan cek log Jenkins untuk detail.`);
                }
                return;
            }

            // Retry if LLM made no changes on first attempt
            const firstAttemptFiles = getChangedFiles();
            if (firstAttemptFiles === null) {
                logger.error('getChangedFiles() failed (git error) after first attempt — aborting.');
                if (!dryRun) {
                    await gh.postComment(opts.repo, opts.pr, '⚠️ **Auto-Fix Gagal**\n\nGagal membaca status git setelah LLM selesai. Silakan cek log Jenkins untuk detail.');
                }
                return;
            }
            if (firstAttemptFiles.length === 0) {
                logger.warn('No changes on first attempt — retrying with stricter prompt...');
                try {
                    await runProviderCLI(opts.provider, buildIssueFixRetryPrompt(issueData.title, issueData.body ?? '', REPO_DIR));
                } catch (err) {
                    logger.error(`LLM CLI failed during retry: ${err.message}`);
                    if (dryRun) {
                        logger.info(`[DRY-RUN] Would post retry error comment to ${opts.repo}#${opts.pr}`);
                    } else {
                        await gh.postComment(opts.repo, opts.pr, `⚠️ **Auto-Fix Gagal**\n\nTerjadi error saat retry LLM: ${err.message}\n\nSilakan cek log Jenkins untuk detail.`);
                    }
                    return;
                }
            }

            // Generate PR description from the changes made
            let prDescription = null;
            try {
                prDescription = await runProviderCLI(opts.provider, buildSummaryPrompt(`Fix: ${issueData.title}`, baseBranch, REPO_DIR));
            } catch (err) {
                logger.warn(`Failed to generate PR description: ${err.message}`);
            }

            // Check for changes and commit
            const changedFiles = getChangedFiles();
            if (changedFiles === null) {
                logger.error('getChangedFiles() failed (git error) before commit — aborting.');
                if (!dryRun) {
                    await gh.postComment(opts.repo, opts.pr, '⚠️ **Auto-Fix Gagal**\n\nGagal membaca status git sebelum commit. Silakan cek log Jenkins untuk detail.');
                }
                return;
            }
            if (changedFiles.length === 0) {
                if (dryRun) {
                    logger.info(`[DRY-RUN] Would post no-changes comment to ${opts.repo}#${opts.pr}`);
                } else {
                    await gh.postComment(opts.repo, opts.pr, '🤖 Maaf, saya tidak dapat menemukan solusi atau perubahan kode yang diperlukan untuk issue ini.');
                }
                logger.info('No changes made by LLM.');
                return;
            }

            const commitMsg = `Fix: ${issueData.title} (Resolves #${opts.pr})`;
            let pushOk;
            if (dryRun) {
                logger.info(`[DRY-RUN] Would commit "${commitMsg}" and push ${branchName}`);
                pushOk = true;
            } else {
                pushOk = commitAndPush(branchName, commitMsg, changedFiles);
            }
            if (!pushOk) {
                logger.error('Failed to commit or push changes.');
                if (!dryRun) {
                    await gh.postComment(opts.repo, opts.pr, '⚠️ **Auto-Fix Gagal**\n\nSaya berhasil membuat perubahan kode, namun gagal saat mencoba commit atau push ke repository. Silakan cek log Jenkins untuk detail.');
                }
                return;
            }
            logger.info('Changes committed and pushed to remote.');

            const prTitle = `Fix: ${issueData.title}`;
            const prBody = `Resolves #${opts.pr}\n\n${prDescription ?? `Dibuat secara otomatis oleh Auto-Reviewer Bot (${opts.provider}).`}`;
            const prResponse = dryRun
                ? (logger.info(`[DRY-RUN] Would create PR: "${prTitle}" (${branchName} -> ${baseBranch})`), { html_url: '[dry-run]' })
                : await gh.createPullRequest(opts.repo, prTitle, prBody, branchName, baseBranch);

            if (dryRun) {
                logger.info(`[DRY-RUN] Would post PR link comment to ${opts.repo}#${opts.pr}`);
            } else {
                await gh.postComment(opts.repo, opts.pr, `🤖 Saya telah mencoba memperbaiki issue ini. Silakan review Pull Request berikut: ${prResponse.html_url}`);
            }
            logger.info(`Pull request created successfully: ${prResponse.html_url}`);
            return;
        }

        // ===================================
        // FLOW D: Manual Review via Label
        // ===================================
        if (opts.action === 'labeled' && opts.labelName === config.AUTO_REVIEW_LABEL) {
            logger.info(`Triggered FLOW D: Manual Review via label for ${opts.repo}#${opts.pr}`);
            await runReview(gh, opts.repo, opts.pr, opts.provider, dryRun);
            return;
        }

        // ===================================
        // FLOW E: Auto-close Issue on PR Merge
        // ===================================
        if (opts.action === 'closed' && opts.merged) {
            const match = opts.headBranch.match(/^auto-fix\/issue-(\d+)$/);
            if (!match) {
                logger.info(`Closed PR branch "${opts.headBranch}" is not an auto-fix branch — skipping.`);
                return;
            }

            const issueNumber = parseInt(match[1], 10);
            logger.info(`Triggered FLOW E: Auto-close Issue #${issueNumber} after PR #${opts.pr} merged.`);

            const comment = `🤖 Issue ini ditutup secara otomatis karena Pull Request #${opts.pr} telah di-merge.`;
            if (dryRun) {
                logger.info(`[DRY-RUN] Would close issue #${issueNumber} on ${opts.repo}`);
            } else {
                await gh.closeIssue(opts.repo, issueNumber, comment);
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
