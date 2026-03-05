import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';

// ─── Mock child_process.spawn ──────────────────────────────────────────────

const mockSpawn = jest.fn();

jest.unstable_mockModule('child_process', () => ({
    spawn: mockSpawn,
}));

jest.unstable_mockModule('../src/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { runProviderCLI } = await import('../src/provider.js');

/**
 * Build a fake child process whose stdout/stderr are Readable PassThrough streams.
 * Lines are written to stdout; the process closes with exitCode after a tick.
 *
 * @param {string[]} stdoutLines - JSON (or arbitrary) lines emitted on stdout
 * @param {string}   stderrText  - text emitted on stderr
 * @param {number}   exitCode    - exit code passed to the 'close' event
 */
function makeFakeProc(stdoutLines = [], stderrText = '', exitCode = 0) {
    const proc = new EventEmitter();
    proc.pid = 12345;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();

    setImmediate(() => {
        if (stderrText) proc.stderr.write(stderrText);
        proc.stderr.end();

        for (const line of stdoutLines) {
            proc.stdout.write(line + '\n');
        }
        proc.stdout.end();

        // Emit close after streams are done
        setImmediate(() => proc.emit('close', exitCode));
    });

    return proc;
}

/**
 * Build a fake proc that emits an 'error' event instead of 'close'.
 */
function makeFakeErrorProc(errorMessage) {
    const proc = new EventEmitter();
    proc.pid = 12346;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();

    // Attach an error handler so Node doesn't throw on the EventEmitter itself
    proc.on('error', () => { });

    setImmediate(() => {
        proc.stderr.end();
        proc.stdout.end();
        proc.emit('error', new Error(errorMessage));
    });

    return proc;
}

beforeEach(() => {
    mockSpawn.mockReset();
});

// ─── Unknown provider ──────────────────────────────────────────────────────

describe('runProviderCLI — unknown provider', () => {
    it('throws before spawning for unknown provider', async () => {
        await expect(runProviderCLI('openai', 'some prompt')).rejects.toThrow(
            'Unknown provider "openai"'
        );
        expect(mockSpawn).not.toHaveBeenCalled();
    });
});

// ─── Spawn error ───────────────────────────────────────────────────────────

describe('runProviderCLI — spawn error', () => {
    it('rejects when the proc emits an error event', async () => {
        mockSpawn.mockReturnValue(makeFakeErrorProc('ENOENT: npx not found'));
        await expect(runProviderCLI('gemini', 'prompt')).rejects.toThrow(
            'Failed to spawn GEMINI CLI'
        );
    });
});

// ─── Non-zero exit, no result ──────────────────────────────────────────────

describe('runProviderCLI — non-zero exit, no result', () => {
    it('rejects with exit code message when process fails with no output', async () => {
        mockSpawn.mockReturnValue(makeFakeProc([], 'some stderr output', 1));
        await expect(runProviderCLI('gemini', 'prompt')).rejects.toThrow(
            'GEMINI CLI exited with code 1'
        );
    });

    it('rejects with "no result found" when exit 0 but no content streamed', async () => {
        // Emits a result-only event with no text — finalResult stays null
        const lines = [JSON.stringify({ type: 'result', subtype: 'success' })];
        mockSpawn.mockReturnValue(makeFakeProc(lines, 'stderr tail', 0));
        await expect(runProviderCLI('claude', 'prompt')).rejects.toThrow(
            'no result was found in output'
        );
    });
});

// ─── Non-zero exit WITH partial result ────────────────────────────────────

describe('runProviderCLI — non-zero exit with partial result already received', () => {
    it('resolves with partial result when content arrived before non-zero exit', async () => {
        const lines = [
            JSON.stringify({
                type: 'assistant',
                message: { content: [{ type: 'text', text: 'Partial review content' }] },
            }),
        ];
        mockSpawn.mockReturnValue(makeFakeProc(lines, '', 1));
        const result = await runProviderCLI('claude', 'prompt');
        expect(result).toBe('Partial review content');
    });
});

// ─── Gemini stream-json parsing ────────────────────────────────────────────

describe('runProviderCLI — Gemini stream-json parsing', () => {
    it('accumulates content from multiple assistant message events', async () => {
        const lines = [
            JSON.stringify({ type: 'message', role: 'assistant', content: 'Hello ', delta: true }),
            JSON.stringify({ type: 'message', role: 'assistant', content: 'World', delta: true }),
        ];
        mockSpawn.mockReturnValue(makeFakeProc(lines));
        expect(await runProviderCLI('gemini', 'prompt')).toBe('Hello World');
    });

    it('ignores non-assistant events (result/stats)', async () => {
        const lines = [
            JSON.stringify({ type: 'result', stats: { tokens: 100 } }),
            JSON.stringify({ type: 'message', role: 'assistant', content: 'Actual output', delta: true }),
        ];
        mockSpawn.mockReturnValue(makeFakeProc(lines));
        expect(await runProviderCLI('gemini', 'prompt')).toBe('Actual output');
    });

    it('ignores messages from non-assistant roles', async () => {
        const lines = [
            JSON.stringify({ type: 'message', role: 'user', content: 'Ignore me', delta: true }),
            JSON.stringify({ type: 'message', role: 'assistant', content: 'Keep me', delta: true }),
        ];
        mockSpawn.mockReturnValue(makeFakeProc(lines));
        expect(await runProviderCLI('gemini', 'prompt')).toBe('Keep me');
    });

    it('skips events with empty content string', async () => {
        const lines = [
            JSON.stringify({ type: 'message', role: 'assistant', content: '', delta: true }),
            JSON.stringify({ type: 'message', role: 'assistant', content: 'Real content', delta: true }),
        ];
        mockSpawn.mockReturnValue(makeFakeProc(lines));
        expect(await runProviderCLI('gemini', 'prompt')).toBe('Real content');
    });
});

// ─── Claude stream-json parsing ────────────────────────────────────────────

describe('runProviderCLI — Claude stream-json parsing', () => {
    it('accumulates text from assistant content blocks', async () => {
        const lines = [
            JSON.stringify({
                type: 'assistant',
                message: { content: [{ type: 'text', text: 'Line 1\n' }, { type: 'text', text: 'Line 2' }] },
            }),
        ];
        mockSpawn.mockReturnValue(makeFakeProc(lines));
        expect(await runProviderCLI('claude', 'prompt')).toBe('Line 1\nLine 2');
    });

    it('accumulates text across multiple assistant events', async () => {
        const lines = [
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Part A ' }] } }),
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Part B' }] } }),
        ];
        mockSpawn.mockReturnValue(makeFakeProc(lines));
        expect(await runProviderCLI('claude', 'prompt')).toBe('Part A Part B');
    });

    it('ignores tool_use blocks — does not add to result', async () => {
        const lines = [
            JSON.stringify({
                type: 'assistant',
                message: {
                    content: [
                        { type: 'tool_use', name: 'bash', input: { command: 'ls' } },
                        { type: 'text', text: 'Done.' },
                    ]
                },
            }),
        ];
        mockSpawn.mockReturnValue(makeFakeProc(lines));
        expect(await runProviderCLI('claude', 'prompt')).toBe('Done.');
    });

    it('falls back to result event text when no assistant text was streamed', async () => {
        const lines = [
            JSON.stringify({ type: 'result', subtype: 'success', result: 'Fallback result text' }),
        ];
        mockSpawn.mockReturnValue(makeFakeProc(lines));
        expect(await runProviderCLI('claude', 'prompt')).toBe('Fallback result text');
    });

    it('does not override streamed assistant text with result event', async () => {
        const lines = [
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Streamed text' }] } }),
            JSON.stringify({ type: 'result', subtype: 'success', result: 'Should be ignored' }),
        ];
        mockSpawn.mockReturnValue(makeFakeProc(lines));
        expect(await runProviderCLI('claude', 'prompt')).toBe('Streamed text');
    });

    it('warns and skips malformed JSON lines without crashing', async () => {
        const lines = [
            'this is not json',
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Valid' }] } }),
        ];
        mockSpawn.mockReturnValue(makeFakeProc(lines));
        expect(await runProviderCLI('claude', 'prompt')).toBe('Valid');
    });

    it('ignores whitespace-only lines without crashing', async () => {
        const lines = [
            '   ',
            JSON.stringify({ type: 'result', result: 'Output' }),
        ];
        mockSpawn.mockReturnValue(makeFakeProc(lines));
        expect(await runProviderCLI('claude', 'prompt')).toBe('Output');
    });
});

// ─── Timeout ───────────────────────────────────────────────────────────────

describe('runProviderCLI — timeout', () => {
    it('rejects when CLI times out', async () => {
        jest.useFakeTimers();

        const proc = new EventEmitter();
        proc.pid = 999;
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        mockSpawn.mockReturnValue(proc);

        const promise = runProviderCLI('gemini', 'prompt');

        // Advance past the 30-minute timeout
        jest.advanceTimersByTime(31 * 60 * 1000);

        await expect(promise).rejects.toThrow('timed out after 30 minutes');
        jest.useRealTimers();
    });
});

// ─── Stderr tail in error ──────────────────────────────────────────────────

describe('runProviderCLI — stderr tail in "no result" error', () => {
    it('includes last stderr lines in error message when no result found', async () => {
        mockSpawn.mockReturnValue(makeFakeProc([], 'line1\nline2\nfinalLine', 0));
        await expect(runProviderCLI('gemini', 'prompt')).rejects.toThrow('finalLine');
    });

    it('shows "(empty)" when stderr was empty and no result found', async () => {
        mockSpawn.mockReturnValue(makeFakeProc([], '', 0));
        await expect(runProviderCLI('gemini', 'prompt')).rejects.toThrow('(empty)');
    });
});

// ─── REPO_DIR spawn args ───────────────────────────────────────────────────

describe('runProviderCLI — REPO_DIR env var', () => {
    it('passes REPO_DIR to gemini spawn cwd and --include-directories', async () => {
        process.env.REPO_DIR = '/custom/repo';
        mockSpawn.mockReturnValue(makeFakeProc([
            JSON.stringify({ type: 'message', role: 'assistant', content: 'ok', delta: true }),
        ]));

        await runProviderCLI('gemini', 'prompt');

        expect(mockSpawn).toHaveBeenCalledWith(
            'npx',
            expect.arrayContaining(['--include-directories', '/custom/repo']),
            expect.objectContaining({ cwd: '/custom/repo' })
        );

        delete process.env.REPO_DIR;
    });
});

// ─── Gemini falsy content edge case ───────────────────────────────────────

describe('runProviderCLI — Gemini falsy content guard', () => {
    it('does not accumulate content when value is 0 (falsy)', async () => {
        const lines = [
            JSON.stringify({ type: 'message', role: 'assistant', content: 0, delta: true }),
            JSON.stringify({ type: 'message', role: 'assistant', content: 'valid', delta: true }),
        ];
        mockSpawn.mockReturnValue(makeFakeProc(lines));
        expect(await runProviderCLI('gemini', 'prompt')).toBe('valid');
    });
});
