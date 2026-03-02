import { buildReviewPrompt, buildReplyPrompt, buildIssueFixPrompt, buildIssueFixRetryPrompt, buildIssueValidationPrompt, buildSummaryPrompt } from './prompts.js';
import { logger } from './logger.js';
import config from './config.js';
import { runProviderCLI } from './provider.js';
import { setupBranch, getChangedFiles, commitAndPush } from './git.js';

/**
 * Flow A & D: Review a Pull Request.
 */
export async function flowReview(gh, repo, prNumber, provider, dryRun) {
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
    const repoDir = process.env.REPO_DIR ?? process.cwd();

    // Fetch comments and run review (+ optional summary) in parallel
    let existingReview, reviewText, summaryText;
    try {
        ([{ existingReview }, [reviewText, summaryText]] = await Promise.all([
            gh.getCommentsContext(repo, prNumber),
            Promise.all([
                runProviderCLI(provider, buildReviewPrompt(prData.title, prData.additions, prData.deletions, targetBranch, repoDir)),
                isPRBodyEmpty
                    ? runProviderCLI(provider, buildSummaryPrompt(prData.title, targetBranch, repoDir))
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

/**
 * Flow B: Reply to a developer comment that mentions the bot.
 */
export async function flowReply(gh, { repo, pr, provider, sender, commentBody, dryRun }) {
    if (!sender || sender === config.BOT_USERNAME) {
        logger.info('Comment is from the bot itself (or sender unknown) — ignoring loop');
        return;
    }

    const { lastBotReplyTime, thread } = await gh.getCommentsContext(repo, pr);
    if (Date.now() - lastBotReplyTime < config.REPLY_COOLDOWN_MS) {
        logger.info(`Reply cooldown active — ignoring comment on ${repo}#${pr}`);
        return;
    }

    logger.info(`Triggered FLOW B: Reply Comment for ${repo}#${pr}`);
    const repoDir = process.env.REPO_DIR ?? process.cwd();
    const prompt = buildReplyPrompt(thread, repoDir);

    let replyText;
    try {
        replyText = await runProviderCLI(provider, prompt);
    } catch (err) {
        const isTimeout = err.message?.includes('timed out');
        const errBody = isTimeout
            ? `⚠️ **Reply Timeout**\n\nLLM CLI tidak merespons dalam 10 menit.`
            : `⚠️ **Reply Gagal**\n\nError: ${err.message}`;
        if (dryRun) {
            logger.info(`[DRY-RUN] Would post reply error comment to ${repo}#${pr}`);
        } else {
            await gh.postComment(repo, pr, errBody);
        }
        return;
    }
    if (dryRun) {
        logger.info(`[DRY-RUN] Would post reply comment to ${repo}#${pr}`);
    } else {
        await gh.postComment(repo, pr, replyText);
    }
    logger.info('Reply posted successfully');
}

/**
 * Flow C: Auto-fix an issue by creating a branch, running LLM, and opening a PR.
 */
export async function flowAutoFix(gh, { repo, pr, provider, dryRun }) {
    logger.info(`Triggered FLOW C: Auto Fix Issue for ${repo}#${pr}`);
    const repoDir = process.env.REPO_DIR ?? process.cwd();

    const issueData = await gh.getIssue(repo, pr);

    // 1. Issue Validation Step
    logger.info('Validating issue context...');
    const validationPrompt = buildIssueValidationPrompt(issueData.title, issueData.body ?? '');
    const validationResultRaw = await runProviderCLI(provider, validationPrompt);

    let validationResult;
    try {
        const jsonStrMatch = validationResultRaw.match(/\{[\s\S]*?\}/);
        const jsonStr = jsonStrMatch ? jsonStrMatch[0] : validationResultRaw;
        validationResult = JSON.parse(jsonStr);
    } catch (err) {
        logger.error('Failed to parse validation result — aborting to avoid acting on ambiguous output. Raw: ' + validationResultRaw);
        return;
    }

    if (typeof validationResult !== 'object' || validationResult === null ||
        typeof validationResult.isValid !== 'boolean') {
        logger.error(`Validation result has unexpected shape — aborting. Parsed: ${JSON.stringify(validationResult)}`);
        return;
    }

    if (!validationResult.isValid) {
        const reason = typeof validationResult.reason === 'string' && validationResult.reason.trim()
            ? validationResult.reason.trim()
            : 'Tidak ada alasan yang diberikan oleh validator.';
        logger.info(`Issue #${pr} validation failed: ${reason}`);
        const rejectionMsg = `⚠️ **Auto-Fix Dibatalkan**\n\nIssue ini tidak memiliki konteks yang cukup untuk diperbaiki secara otomatis oleh bot.\n\n**Alasan:** ${reason}\n\nSilakan lengkapi deskripsi issue (misalnya dengan menambahkan logs, pesan error, langkah reproduksi, atau letak file yang bermasalah) lalu tambahkan kembali label \`auto-fix\`.`;
        if (dryRun) {
            logger.info(`[DRY-RUN] Would post validation rejection to ${repo}#${pr}`);
        } else {
            await gh.postComment(repo, pr, rejectionMsg);
        }
        return;
    }

    // 2. Idempotency check
    const branchName = `auto-fix/issue-${pr}`;
    const existingPR = await gh.findOpenPR(repo, branchName);
    if (existingPR) {
        logger.info(`Open PR already exists for ${branchName}: ${existingPR.html_url} — skipping.`);
        return;
    }

    // 3. Proceed with Auto Fix
    const prompt = buildIssueFixPrompt(issueData.title, issueData.body ?? '', repoDir);

    // Resolve base branch
    let baseBranch;
    const parentIssue = await gh.getParentIssue(repo, pr);
    if (parentIssue) {
        const parentBranch = `auto-fix/issue-${parentIssue.number}`;
        const parentExists = await gh.branchExists(repo, parentBranch);
        if (parentExists) {
            baseBranch = parentBranch;
            logger.info(`Sub-issue detected — branching from parent: ${baseBranch}`);
        } else {
            baseBranch = await gh.getDefaultBranch(repo);
            logger.warn(`Parent branch ${parentBranch} not found — falling back to ${baseBranch}`);
        }
    } else {
        baseBranch = await gh.getDefaultBranch(repo);
    }

    // Setup Git context and branch
    if (!setupBranch(branchName, baseBranch, repo, process.env.GITHUB_TOKEN)) {
        logger.error('setupBranch failed — aborting auto-fix.');
        if (!dryRun) {
            await gh.postComment(repo, pr, '⚠️ **Auto-Fix Gagal**\n\nGagal menyiapkan branch Git. Silakan cek log Jenkins untuk detail.');
        }
        return;
    }

    // Let the LLM do the magic
    try {
        await runProviderCLI(provider, prompt);
    } catch (err) {
        logger.error(`LLM CLI failed during auto-fix: ${err.message}`);
        if (dryRun) {
            logger.info(`[DRY-RUN] Would post LLM error comment to ${repo}#${pr}`);
        } else {
            await gh.postComment(repo, pr, `⚠️ **Auto-Fix Gagal**\n\nTerjadi error saat menjalankan LLM: ${err.message}\n\nSilakan cek log Jenkins untuk detail.`);
        }
        return;
    }

    // Retry if LLM made no changes on first attempt
    const firstAttemptFiles = getChangedFiles();
    if (firstAttemptFiles === null) {
        logger.error('getChangedFiles() failed (git error) after first attempt — aborting.');
        if (!dryRun) {
            await gh.postComment(repo, pr, '⚠️ **Auto-Fix Gagal**\n\nGagal membaca status git setelah LLM selesai. Silakan cek log Jenkins untuk detail.');
        }
        return;
    }
    if (firstAttemptFiles.length === 0) {
        logger.warn('No changes on first attempt — retrying with stricter prompt...');
        try {
            await runProviderCLI(provider, buildIssueFixRetryPrompt(issueData.title, issueData.body ?? '', repoDir));
        } catch (err) {
            logger.error(`LLM CLI failed during retry: ${err.message}`);
            if (dryRun) {
                logger.info(`[DRY-RUN] Would post retry error comment to ${repo}#${pr}`);
            } else {
                await gh.postComment(repo, pr, `⚠️ **Auto-Fix Gagal**\n\nTerjadi error saat retry LLM: ${err.message}\n\nSilakan cek log Jenkins untuk detail.`);
            }
            return;
        }
    }

    // Generate PR description from the changes made
    let prDescription = null;
    try {
        prDescription = await runProviderCLI(provider, buildSummaryPrompt(`Fix: ${issueData.title}`, baseBranch, repoDir));
    } catch (err) {
        logger.warn(`Failed to generate PR description: ${err.message}`);
    }

    // Check for changes and commit
    const changedFiles = getChangedFiles();
    if (changedFiles === null) {
        logger.error('getChangedFiles() failed (git error) before commit — aborting.');
        if (!dryRun) {
            await gh.postComment(repo, pr, '⚠️ **Auto-Fix Gagal**\n\nGagal membaca status git sebelum commit. Silakan cek log Jenkins untuk detail.');
        }
        return;
    }
    if (changedFiles.length === 0) {
        if (dryRun) {
            logger.info(`[DRY-RUN] Would post no-changes comment to ${repo}#${pr}`);
        } else {
            await gh.postComment(repo, pr, '🤖 Maaf, saya tidak dapat menemukan solusi atau perubahan kode yang diperlukan untuk issue ini.');
        }
        logger.info('No changes made by LLM.');
        return;
    }

    const commitMsg = `Fix: ${issueData.title} (Resolves #${pr})`;
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
            await gh.postComment(repo, pr, '⚠️ **Auto-Fix Gagal**\n\nSaya berhasil membuat perubahan kode, namun gagal saat mencoba commit atau push ke repository. Silakan cek log Jenkins untuk detail.');
        }
        return;
    }
    logger.info('Changes committed and pushed to remote.');

    const prTitle = `Fix: ${issueData.title}`;
    const prBody = `Resolves #${pr}\n\n${prDescription ?? `Dibuat secara otomatis oleh Auto-Reviewer Bot (${provider}).`}`;
    const prResponse = dryRun
        ? (logger.info(`[DRY-RUN] Would create PR: "${prTitle}" (${branchName} -> ${baseBranch})`), { html_url: '[dry-run]' })
        : await gh.createPullRequest(repo, prTitle, prBody, branchName, baseBranch);

    if (dryRun) {
        logger.info(`[DRY-RUN] Would post PR link comment to ${repo}#${pr}`);
    } else {
        await gh.postComment(repo, pr, `🤖 Saya telah mencoba memperbaiki issue ini. Silakan review Pull Request berikut: ${prResponse.html_url}`);
    }
    logger.info(`Pull request created successfully: ${prResponse.html_url}`);
}

/**
 * Flow E: Auto-close linked issue when a merged PR's branch matches auto-fix pattern.
 */
export async function flowAutoClose(gh, { repo, pr, headBranch, dryRun }) {
    const match = headBranch.match(/^auto-fix\/issue-(\d+)$/);
    if (!match) {
        logger.info(`Closed PR branch "${headBranch}" is not an auto-fix branch — skipping.`);
        return;
    }

    const issueNumber = parseInt(match[1], 10);
    logger.info(`Triggered FLOW E: Auto-close Issue #${issueNumber} after PR #${pr} merged.`);

    const comment = `🤖 Issue ini ditutup secara otomatis karena Pull Request #${pr} telah di-merge.`;
    if (dryRun) {
        logger.info(`[DRY-RUN] Would close issue #${issueNumber} on ${repo}`);
    } else {
        await gh.closeIssue(repo, issueNumber, comment);
    }
}
