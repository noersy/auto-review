import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock child_process.spawnSync
jest.unstable_mockModule('child_process', () => ({
    spawnSync: jest.fn(),
}));

// Mock logger
jest.unstable_mockModule('../src/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { spawnSync } = await import('child_process');
const { setupBranch, getChangedFiles, commitAndPush } = await import('../src/git.js');

beforeEach(() => {
    spawnSync.mockReset();
});

// ─── getChangedFiles ──────────────────────────────────────────────────────

describe('getChangedFiles', () => {
    it('returns empty array when no changes', () => {
        spawnSync.mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: null });
        expect(getChangedFiles()).toEqual([]);
    });

    it('returns null when git command fails', () => {
        spawnSync.mockReturnValue({ status: 1, error: new Error('git error'), stdout: null });
        expect(getChangedFiles()).toBeNull();
    });

    it('returns null when spawnSync returns error field', () => {
        spawnSync.mockReturnValue({ error: new Error('spawn fail'), status: 0, stdout: null });
        expect(getChangedFiles()).toBeNull();
    });

    it('parses a single modified file', () => {
        //  git status -z format: " M path\0"
        const output = ' M src/app.js\0';
        spawnSync.mockReturnValue({ status: 0, stdout: Buffer.from(output), stderr: null });
        const files = getChangedFiles();
        expect(files).toContain('src/app.js');
    });

    it('parses multiple files', () => {
        const output = ' M src/a.js\0 M src/b.js\0';
        spawnSync.mockReturnValue({ status: 0, stdout: Buffer.from(output), stderr: null });
        const files = getChangedFiles();
        expect(files).toHaveLength(2);
        expect(files).toContain('src/a.js');
        expect(files).toContain('src/b.js');
    });

    it('skips temporary and credential files', () => {
        const output = ' M .claude-credentials.json\0 M .gemini-credentials.json\0 M .gemini-settings.json\0?? .creds/foo.json\0 M .bot-comment-body.txt\0 A pr_description.md\0?? test-file-1234abcd.js\0 M src/real.js\0';
        spawnSync.mockReturnValue({ status: 0, stdout: Buffer.from(output), stderr: null });
        const files = getChangedFiles();
        expect(files).not.toContain('.claude-credentials.json');
        expect(files).not.toContain('.gemini-credentials.json');
        expect(files).not.toContain('.gemini-settings.json');
        expect(files).not.toContain('.creds/foo.json');
        expect(files).not.toContain('.bot-comment-body.txt');
        expect(files).not.toContain('pr_description.md');
        expect(files).not.toContain('test-file-1234abcd.js');
        expect(files).toContain('src/real.js');
    });

    it('handles rename (R) entries by skipping old path', () => {
        // R status: "R  new-path\0old-path\0"
        const output = 'R  src/new.js\0src/old.js\0';
        spawnSync.mockReturnValue({ status: 0, stdout: Buffer.from(output), stderr: null });
        const files = getChangedFiles();
        expect(files).toContain('src/new.js');
        expect(files).not.toContain('src/old.js');
    });

    it('handles copy (C) entries by skipping old path', () => {
        const output = 'C  src/copy.js\0src/original.js\0';
        spawnSync.mockReturnValue({ status: 0, stdout: Buffer.from(output), stderr: null });
        const files = getChangedFiles();
        expect(files).toContain('src/copy.js');
        expect(files).not.toContain('src/original.js');
    });
});

// ─── setupBranch ─────────────────────────────────────────────────────────

describe('setupBranch', () => {
    it('returns false when remote set-url fails', () => {
        spawnSync.mockReturnValue({ status: 1, error: null }); // first call = set-url
        const ok = setupBranch('auto-fix/issue-1', 'main', 'owner/repo', 'token123');
        expect(ok).toBe(false);
    });

    it('returns false when any git step fails', () => {
        // First call = remote set-url (success), second call = first git step (fail)
        spawnSync
            .mockReturnValueOnce({ status: 0, error: null })   // set-url OK
            .mockReturnValue({ status: 1, error: null });       // any subsequent step fails
        const ok = setupBranch('auto-fix/issue-1', 'main', 'owner/repo', 'token123');
        expect(ok).toBe(false);
    });

    it('returns true when all steps succeed', () => {
        spawnSync.mockReturnValue({ status: 0, error: null, stdio: 'inherit' });
        const ok = setupBranch('auto-fix/issue-1', 'main', 'owner/repo', 'token123');
        expect(ok).toBe(true);
    });
});

// ─── commitAndPush ───────────────────────────────────────────────────────

describe('commitAndPush', () => {
    it('returns true when all git operations succeed', () => {
        spawnSync.mockReturnValue({ status: 0, error: null });
        const ok = commitAndPush('feature-branch', 'feat: add thing', ['src/a.js']);
        expect(ok).toBe(true);
    });

    it('returns false when git add fails', () => {
        spawnSync.mockReturnValueOnce({ status: 1, error: null }); // add fails
        const ok = commitAndPush('feature-branch', 'feat: add thing', ['src/a.js']);
        expect(ok).toBe(false);
    });

    it('returns false when git commit fails', () => {
        spawnSync
            .mockReturnValueOnce({ status: 0, error: null })  // add OK
            .mockReturnValueOnce({ status: 1, error: null }); // commit fails
        const ok = commitAndPush('feature-branch', 'feat: add thing', ['src/a.js']);
        expect(ok).toBe(false);
    });

    it('returns false when git push fails', () => {
        spawnSync
            .mockReturnValueOnce({ status: 0, error: null })  // add OK
            .mockReturnValueOnce({ status: 0, error: null })  // commit OK
            .mockReturnValueOnce({ status: 1, error: null }); // push fails
        const ok = commitAndPush('feature-branch', 'feat: add thing', ['src/a.js']);
        expect(ok).toBe(false);
    });
});
