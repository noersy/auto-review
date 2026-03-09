import { spawnSync } from 'child_process';
import { logger } from './logger.js';

const REPO_DIR = process.env.REPO_DIR ?? process.cwd();
const IGNORED_TEMP_PATTERNS = [
    /^\.claude-credentials\.json$/,
    /^\.gemini-credentials\.json$/,
    /^\.gemini-settings\.json$/,
    /^\.bot-comment-body\.txt$/,
    /^pr_description\.md$/,
    /^\.creds\//
];

/**
 * Run a git command inside REPO_DIR. Returns true on success, false on failure.
 */
function git(args, opts = {}) {
    const result = spawnSync('git', args, { cwd: REPO_DIR, stdio: 'inherit', shell: false, ...opts });
    if (result.error || result.status !== 0) {
        logger.error(`Failed to run: git ${args.join(' ')}${result.error ? ' — ' + result.error.message : ''}`);
        return false;
    }
    return true;
}

/**
 * Configure git identity, safe directory, and remote URL, then fetch and
 * check out a fresh branch from the given base.
 * Returns true on success, false if any step fails.
 */
export function setupBranch(branchName, baseBranch, repoFullName, token) {
    const steps = [
        ['config', '--global', 'user.email', 'bot@auto-reviewer.local'],
        ['config', '--global', 'user.name', 'Auto Reviewer Bot'],
        ['config', '--global', '--add', 'safe.directory', REPO_DIR],
        ['fetch', 'origin'],
        ['checkout', '-B', branchName, `origin/${baseBranch}`],
    ];

    // Set remote URL separately so the token is never passed through git() logging.
    // stdio: 'pipe' prevents the URL (which contains the token) from leaking into logs.
    const remoteResult = spawnSync('git', ['remote', 'set-url', 'origin', `https://x-access-token:${token}@github.com/${repoFullName}.git`], { cwd: REPO_DIR, stdio: 'pipe', shell: false });
    if (remoteResult.error || remoteResult.status !== 0) {
        logger.error('Failed to run: git remote set-url origin <redacted>');
        return false;
    }

    for (const args of steps) {
        if (!git(args)) return false;
    }
    logger.info(`Checked out branch: ${branchName} (from ${baseBranch})`);
    return true;
}

/**
 * Returns the list of changed file paths from `git status --porcelain`,
 * excluding credential files. Returns null if the git command fails.
 */
export function getChangedFiles() {
    const result = spawnSync('git', ['status', '-z'], { cwd: REPO_DIR, shell: false, stdio: 'pipe' });
    if (result.error || result.status !== 0) return null;
    const output = result.stdout?.toString() ?? '';
    if (!output) return [];
    // -z outputs NUL-delimited entries: "XY PATH\0"
    // For renames/copies: "R  new\0old\0" — the second entry is the old path (no status prefix).
    // We collect only the new paths and skip the old-path entries that follow R/C status codes.
    const entries = output.split('\0');
    const files = [];
    let skipNext = false;
    for (const entry of entries) {
        if (skipNext) { skipNext = false; continue; }
        if (entry.length <= 3) continue;
        const xy = entry.slice(0, 2);
        const file = entry.slice(3);

        const isIgnored = IGNORED_TEMP_PATTERNS.some(pattern => pattern.test(file));
        if (!isIgnored) files.push(file);

        // R (rename) and C (copy) are followed by the original path as a separate entry
        if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') skipNext = true;
    }
    return files;
}

/**
 * Stage the given files, commit with the given message, and force-push the branch.
 * Returns true on success, false if any step fails.
 */
export function commitAndPush(branchName, commitMessage, files) {
    return (
        git(['add', '--', ...files]) &&
        git(['commit', '-m', commitMessage]) &&
        git(['push', '-u', 'origin', branchName, '--force-with-lease'])
    );
}
