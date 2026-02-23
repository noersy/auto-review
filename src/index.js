import fs from 'fs';
import { execSync } from 'child_process';
import { Command } from 'commander';
import dotenv from 'dotenv';
import { GitHubClient } from './github.js';
import { buildReviewPrompt, buildReplyPrompt } from './prompts.js';
import { logger } from './logger.js';
import config from './config.js';

dotenv.config();

const program = new Command();
program
    .requiredOption('--action <action>')
    .requiredOption('--repo <repo>')
    .requiredOption('--pr <number>')
    .option('--comment-body <body>', '')
    .option('--sender <login>', '');

program.parse();
const opts = program.opts();

async function runClaudeCLI(promptText) {
    logger.info("Executing Claude Code CLI...");
    try {
        // Run npx @anthropic-ai/claude-code
        // Using --yes to skip auth prompts, assuming ~/.claude.json is injected by Jenkins
        // The -p flag sets the prompt
        const command = `npx --yes @anthropic-ai/claude-code -p "${promptText.replace(/"/g, '\\"')}" --no-interaction`;
        execSync(command, {
            stdio: 'inherit',
            env: { ...process.env, CI: "true" }
        });
    } catch (error) {
        logger.error("Claude Code CLI failed: " + error.message);
        throw error;
    }
}

async function main() {
    const gh = new GitHubClient(process.env.GITHUB_TOKEN);

    try {
        const isNewPR = ['opened', 'synchronize'].includes(opts.action);
        const isReply = opts.action === 'created' && opts.commentBody?.includes(config.BOT_MENTION);

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

            const prompt = buildReviewPrompt(prData.title, prData.additions, prData.deletions);
            await runClaudeCLI(prompt);

            if (fs.existsSync(config.CLAUDE_REVIEW_FILE)) {
                const reviewText = fs.readFileSync(config.CLAUDE_REVIEW_FILE, 'utf-8');
                await gh.postComment(opts.repo, opts.pr, `## 🤖 Claude Auto Review\n\n${reviewText}`);
                logger.info('Review posted successfully');
            } else {
                throw new Error(`Expected output file '${config.CLAUDE_REVIEW_FILE}' not found! Claude might have failed silently.`);
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

            await runClaudeCLI(prompt);

            if (fs.existsSync(config.CLAUDE_REVIEW_FILE)) {
                const reviewText = fs.readFileSync(config.CLAUDE_REVIEW_FILE, 'utf-8');
                await gh.postComment(opts.repo, opts.pr, reviewText);
                logger.info('Reply posted successfully');
            } else {
                throw new Error(`Expected output file '${config.CLAUDE_REVIEW_FILE}' not found! Claude might have failed silently.`);
            }
            return;
        }

        logger.info(`Action "${opts.action}" not handled. Terminating peacefully.`);

    } catch (error) {
        logger.error(`Fatal orchestration error: ${error.stack || error.message}`);
        // Optional: Only post error to GitHub if it crashed midway
        // await gh.postComment(opts.repo, opts.pr, `❌ **Auto-Review Error**: Sedang terjadi kesalahan internal pada pipeline bot.\n\n\`\`\`\n${error.message}\n\`\`\``).catch(() => {});
        process.exit(1);
    } finally {
        // Cleanup generated file
        if (fs.existsSync(config.CLAUDE_REVIEW_FILE)) {
            fs.unlinkSync(config.CLAUDE_REVIEW_FILE);
        }
    }
}

main();
