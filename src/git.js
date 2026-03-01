import { spawnSync } from 'child_process';
import { logger } from './logger.js';

const REPO_DIR = '/repo';
const CREDENTIAL_FILES = [
    '.claude-credentials.json',
    '.gemini-credentials.json',
    '.gemini-settings.json',
];

/**
 * Run a git command inside REPO_DIR. Returns true on success, false on failure.
 */
function git(args, opts = {}) {
    const result = spawnSync('git', args, { cwd: REPO_DIR, stdio: 'inherit', shell: false, ...opts });
    if (result.status !== 0) {
        logger.error(`Failed to run: git ${args.join(' ')}`);
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
        ['remote', 'set-url', 'origin', `https://x-access-token:${token}@github.com/${repoFullName}.git`],
        ['fetch', 'origin'],
        ['checkout', '-B', branchName, `origin/${baseBranch}`],
    ];
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
    const result = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_DIR, shell: false, stdio: 'pipe' });
    if (result.status !== 0) return null;
    const output = result.stdout?.toString() ?? '';
    if (!output.trim()) return [];
    return output.trim().split('\n')
        .map(line => line.slice(3))  // strip "XY " status prefix
        .filter(f => !CREDENTIAL_FILES.includes(f));
}

/**
 * Stage the given files, commit with the given message, and force-push the branch.
 * Returns true on success, false if any step fails.
 */
export function commitAndPush(branchName, commitMessage, files) {
    const gitOpts = { cwd: REPO_DIR, stdio: 'inherit', shell: false };
    return (
        git(['add', '--', ...files]) &&
        git(['commit', '-m', commitMessage], gitOpts) &&
        git(['push', '-u', 'origin', branchName, '--force-with-lease'], gitOpts)
    );
}
