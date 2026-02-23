import { spawn } from 'child_process';
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

// Run Claude Code CLI and return the final result text.
// stderr (Claude's thinking/tool-use progress) is streamed live to console.
// stdout (JSONL events) is captured to extract the final result.
async function runClaudeCLI(promptText) {
    logger.info("Executing Claude Code CLI...");

    return new Promise((resolve, reject) => {
        const proc = spawn(
            'npx',
            ['--yes', '@anthropic-ai/claude-code', '-p', promptText,
             '--dangerously-skip-permissions',
             '--output-format', 'stream-json',
             '--verbose'],
            {
                stdio: ['ignore', 'pipe', 'inherit'],
                env: { ...process.env, CI: 'true' }
            }
        );

        let stdoutBuf = '';
        let finalResult = null;

        proc.stdout.on('data', chunk => {
            stdoutBuf += chunk.toString();
            const lines = stdoutBuf.split('\n');
            stdoutBuf = lines.pop(); // keep incomplete last line
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const event = JSON.parse(line);
                    if (event.type === 'result') {
                        finalResult = event.result;
                    } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
                        for (const block of event.message.content) {
                            if (block.type === 'text' && block.text?.trim()) {
                                logger.info(`[Claude] ${block.text.trim()}`);
                            } else if (block.type === 'tool_use') {
                                logger.info(`[Claude] tool: ${block.name}(${JSON.stringify(block.input).slice(0, 120)})`);
                            }
                        }
                    }
                } catch (_) { /* ignore non-JSON lines */ }
            }
        });

        proc.on('close', code => {
            if (code !== 0) {
                reject(new Error(`Claude Code CLI exited with code ${code}`));
                return;
            }
            if (!finalResult) {
                reject(new Error('Claude Code CLI exited successfully but no result was found in output.'));
                return;
            }
            resolve(finalResult);
        });

        proc.on('error', err => {
            reject(new Error('Failed to spawn Claude Code CLI: ' + err.message));
        });
    });
}

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

            const prompt = buildReviewPrompt(prData.title, prData.additions, prData.deletions);
            const reviewText = await runClaudeCLI(prompt);
            await gh.postComment(opts.repo, opts.pr, `## 🤖 Claude Auto Review\n\n${reviewText}`);
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
            const replyText = await runClaudeCLI(prompt);
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
