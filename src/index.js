import { spawn } from 'child_process';
import { Command } from 'commander';
import dotenv from 'dotenv';
import { GitHubClient } from './github.js';
import { buildReviewPrompt, buildReplyPrompt } from './prompts.js';
import { logger } from './logger.js';
import config from './config.js';
import { runProviderCLI } from './provider.js';

dotenv.config();

const program = new Command();
program
    .requiredOption('--action <action>')
    .requiredOption('--repo <repo>')
    .requiredOption('--pr <number>')
    .option('--comment-body <body>', '')
    .option('--sender <login>', '')
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

        logger.info(`Action "${opts.action}" not handled. Terminating peacefully.`);

    } catch (error) {
        logger.error(`Fatal orchestration error: ${error.stack || error.message}`);
        process.exit(1);
    }
}

main();
