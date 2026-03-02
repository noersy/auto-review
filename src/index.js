import { Command } from 'commander';
import { readFileSync } from 'fs';
import { GitHubClient } from './github.js';
import { logger } from './logger.js';
import config from './config.js';
import { flowReview, flowReply, flowAutoFix, flowAutoClose } from './flows.js';
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

        // Flow A: New PR Review
        if (isNewPR) {
            logger.info(`Triggered FLOW A: New PR Review for ${opts.repo}#${opts.pr}`);
            await flowReview(gh, opts.repo, opts.pr, opts.provider, dryRun);
            return;
        }

        // Flow B: Reply to Developer Comment
        if (isReply) {
            await flowReply(gh, {
                repo: opts.repo,
                pr: opts.pr,
                provider: opts.provider,
                sender: opts.sender,
                commentBody,
                dryRun,
            });
            return;
        }

        // Flow C: Auto Fix Issue by Label
        if (opts.action === 'labeled' && opts.labelName === config.AUTO_FIX_LABEL) {
            await flowAutoFix(gh, {
                repo: opts.repo,
                pr: opts.pr,
                provider: opts.provider,
                dryRun,
            });
            return;
        }

        // Flow D: Manual Review via Label
        if (opts.action === 'labeled' && opts.labelName === config.AUTO_REVIEW_LABEL) {
            logger.info(`Triggered FLOW D: Manual Review via label for ${opts.repo}#${opts.pr}`);
            await flowReview(gh, opts.repo, opts.pr, opts.provider, dryRun);
            return;
        }

        // Flow E: Auto-close Issue on PR Merge
        if (opts.action === 'closed' && opts.merged) {
            await flowAutoClose(gh, {
                repo: opts.repo,
                pr: opts.pr,
                headBranch: opts.headBranch,
                dryRun,
            });
            return;
        }

        logger.info(`Action "${opts.action}" not handled. Terminating peacefully.`);

    } catch (error) {
        logger.error(`Fatal orchestration error: ${error.stack || error.message}`);
        process.exit(1);
    }
}

main();
