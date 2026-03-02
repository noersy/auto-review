#!/usr/bin/env node
import { Command } from 'commander';
import { execSync } from 'child_process';
import { GitHubClient } from './github.js';
import { logger } from './logger.js';
import { flowReview, flowReply, flowAutoFix } from './flows.js';
import { buildWebhookPayload, triggerJenkinsJob, logTriggerResult } from './jenkins.js';
import config from './config.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Auto-detect "owner/repo" from the git remote in the current directory.
 */
function detectRepo() {
    try {
        const url = execSync('git remote get-url origin', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        // Match HTTPS: https://github.com/owner/repo.git
        // Match SSH:   git@github.com:owner/repo.git
        const match = url.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/i);
        if (match) return match[1];
    } catch (_) { /* not a git repo or no remote */ }
    return null;
}

/**
 * Resolve GitHub token from flag, env, or bail.
 */
function resolveToken(flagToken) {
    const token = flagToken || process.env.GITHUB_TOKEN;
    if (!token || !token.trim()) {
        console.error('Error: GitHub token tidak ditemukan.');
        console.error('  Gunakan --token <token>, atau set GITHUB_TOKEN env var, atau buat file .env.');
        process.exit(1);
    }
    return token;
}

/**
 * Resolve --repo: use explicit flag or auto-detect.
 */
function resolveRepo(flagRepo) {
    if (flagRepo) return flagRepo;
    const detected = detectRepo();
    if (detected) {
        logger.info(`Auto-detected repository: ${detected}`);
        return detected;
    }
    console.error('Error: --repo <owner/repo> diperlukan (auto-detect gagal karena bukan git repo atau tidak ada remote origin).');
    process.exit(1);
}

// ── CLI Definition ──────────────────────────────────────────────────────────

const program = new Command();
program
    .name('auto-review')
    .description('CLI untuk auto-review PR dan auto-fix issue menggunakan LLM')
    .version('1.0.0');

// ── Global Options ──────────────────────────────────────────────────────────

program
    .option('--repo <owner/repo>', 'GitHub repository (auto-detected jika di dalam git repo)')
    .option('--provider <provider>', 'LLM provider: claude atau gemini', 'claude')
    .option('--token <token>', 'GitHub token (default: $GITHUB_TOKEN)')
    .option('--dry-run', 'Tampilkan apa yang akan dilakukan tanpa melakukan perubahan', false);

// ── Subcommand: review ──────────────────────────────────────────────────────

program
    .command('review <pr>')
    .description('Review Pull Request secara otomatis menggunakan LLM')
    .action(async (pr) => {
        const globalOpts = program.opts();
        const repo = resolveRepo(globalOpts.repo);
        const token = resolveToken(globalOpts.token);
        const dryRun = globalOpts.dryRun;
        const provider = globalOpts.provider;

        if (dryRun) logger.info('DRY-RUN MODE: GitHub writes dinonaktifkan.');

        const gh = new GitHubClient(token);
        logger.info(`Starting review for ${repo}#${pr}...`);
        await flowReview(gh, repo, pr, provider, dryRun);
    });

// ── Subcommand: fix ─────────────────────────────────────────────────────────

program
    .command('fix <issue>')
    .description('Auto-fix issue dengan membuat branch, menjalankan LLM, dan membuka PR')
    .action(async (issue) => {
        const globalOpts = program.opts();
        const repo = resolveRepo(globalOpts.repo);
        const token = resolveToken(globalOpts.token);
        const dryRun = globalOpts.dryRun;
        const provider = globalOpts.provider;

        // flowAutoFix needs GITHUB_TOKEN in env for git operations
        process.env.GITHUB_TOKEN = token;

        if (dryRun) logger.info('DRY-RUN MODE: GitHub and Git writes dinonaktifkan.');

        const gh = new GitHubClient(token);
        logger.info(`Starting auto-fix for ${repo}#${issue}...`);
        await flowAutoFix(gh, { repo, pr: issue, provider, dryRun });
    });

// ── Subcommand: reply ───────────────────────────────────────────────────────

program
    .command('reply <pr>')
    .description('Reply ke komentar developer di PR yang menyebut bot')
    .requiredOption('--body <text>', 'Isi komentar untuk direspon')
    .action(async (pr, cmdOpts) => {
        const globalOpts = program.opts();
        const repo = resolveRepo(globalOpts.repo);
        const token = resolveToken(globalOpts.token);
        const dryRun = globalOpts.dryRun;
        const provider = globalOpts.provider;

        if (dryRun) logger.info('DRY-RUN MODE: GitHub writes dinonaktifkan.');

        const gh = new GitHubClient(token);
        logger.info(`Starting reply for ${repo}#${pr}...`);
        await flowReply(gh, {
            repo,
            pr,
            provider,
            sender: 'cli-user',
            commentBody: cmdOpts.body,
            dryRun,
        });
    });

// ── Subcommand: trigger ─────────────────────────────────────────────────────

const trigger = program
    .command('trigger')
    .description('Trigger Jenkins job secara remote via webhook');

function resolveJenkinsUrl(flagUrl) {
    const url = flagUrl || process.env.JENKINS_URL;
    if (!url || !url.trim()) {
        console.error('Error: Jenkins URL tidak ditemukan.');
        console.error('  Gunakan --jenkins-url <url>, atau set JENKINS_URL env var.');
        process.exit(1);
    }
    return url;
}

trigger
    .command('review <pr>')
    .description('Trigger Jenkins untuk review Pull Request')
    .option('--jenkins-url <url>', 'Jenkins base URL (default: $JENKINS_URL)')
    .option('--webhook-token <token>', 'Override webhook token')
    .option('--jenkins-user <user>', 'Jenkins username (default: $JENKINS_USER)')
    .option('--jenkins-token <token>', 'Jenkins API token (default: $JENKINS_API_TOKEN)')
    .action(async (pr, cmdOpts) => {
        const globalOpts = program.opts();
        const repo = resolveRepo(globalOpts.repo);
        const provider = globalOpts.provider;
        const dryRun = globalOpts.dryRun;
        const jenkinsUrl = resolveJenkinsUrl(cmdOpts.jenkinsUrl);
        const webhookToken = cmdOpts.webhookToken || config.WEBHOOK_TOKEN;

        const payload = buildWebhookPayload('review', repo, pr, provider);

        if (dryRun) {
            logger.info('DRY-RUN: Payload yang akan dikirim ke Jenkins:');
            console.log(JSON.stringify(payload, null, 2));
            logger.info(`URL: ${jenkinsUrl}/generic-webhook-trigger/invoke?token=${webhookToken}`);
            return;
        }

        const auth = {
            user: cmdOpts.jenkinsUser || process.env.JENKINS_USER,
            apiToken: cmdOpts.jenkinsToken || process.env.JENKINS_API_TOKEN,
        };

        try {
            const result = await triggerJenkinsJob(jenkinsUrl, webhookToken, payload, auth);
            logTriggerResult(result);
        } catch (err) {
            logger.error(err.message);
            process.exit(1);
        }
    });

trigger
    .command('fix <issue>')
    .description('Trigger Jenkins untuk auto-fix issue')
    .option('--jenkins-url <url>', 'Jenkins base URL (default: $JENKINS_URL)')
    .option('--webhook-token <token>', 'Override webhook token')
    .option('--jenkins-user <user>', 'Jenkins username (default: $JENKINS_USER)')
    .option('--jenkins-token <token>', 'Jenkins API token (default: $JENKINS_API_TOKEN)')
    .action(async (issue, cmdOpts) => {
        const globalOpts = program.opts();
        const repo = resolveRepo(globalOpts.repo);
        const provider = globalOpts.provider;
        const dryRun = globalOpts.dryRun;
        const jenkinsUrl = resolveJenkinsUrl(cmdOpts.jenkinsUrl);
        const webhookToken = cmdOpts.webhookToken || config.WEBHOOK_TOKEN;

        const payload = buildWebhookPayload('fix', repo, issue, provider);

        if (dryRun) {
            logger.info('DRY-RUN: Payload yang akan dikirim ke Jenkins:');
            console.log(JSON.stringify(payload, null, 2));
            logger.info(`URL: ${jenkinsUrl}/generic-webhook-trigger/invoke?token=${webhookToken}`);
            return;
        }

        const auth = {
            user: cmdOpts.jenkinsUser || process.env.JENKINS_USER,
            apiToken: cmdOpts.jenkinsToken || process.env.JENKINS_API_TOKEN,
        };

        try {
            const result = await triggerJenkinsJob(jenkinsUrl, webhookToken, payload, auth);
            logTriggerResult(result);
        } catch (err) {
            logger.error(err.message);
            process.exit(1);
        }
    });

// ── Parse & Run ─────────────────────────────────────────────────────────────

program.parseAsync().catch((err) => {
    logger.error(`Fatal error: ${err.stack || err.message}`);
    process.exit(1);
});

