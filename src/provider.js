import { spawn } from 'child_process';
import { logger } from './logger.js';

const CLI_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export async function runProviderCLI(provider, promptText) {
    logger.info(`Executing ${provider.toUpperCase()} CLI...`);

    const claudeArgs = [
        '--yes', '@anthropic-ai/claude-code', '-p', promptText,
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--verbose'
    ];

    const geminiArgs = [
        '--yes', '@google/gemini-cli', '-p', promptText,
        '-y',
        '-o', 'stream-json',
        '--include-directories', '/repo',
        '--model', 'gemini-2.5-pro'
    ];

    const providerArgs = provider === 'gemini' ? geminiArgs : claudeArgs;

    return new Promise((resolve, reject) => {
        const proc = spawn('npx', providerArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, CI: 'true' },
            shell: false
        });

        // Pipe stderr live and also capture for diagnostics
        let stderrBuf = '';
        proc.stderr.on('data', chunk => {
            process.stderr.write(chunk);
            stderrBuf += chunk.toString();
        });

        let stdoutBuf = '';
        let finalResult = null;
        let accumulatedText = '';  // Accumulate text from streaming chunks

        proc.stdout.on('data', chunk => {
            const raw = chunk.toString();
            stdoutBuf += raw;
            const lines = stdoutBuf.split('\n');
            stdoutBuf = lines.pop(); // keep incomplete last line
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const event = JSON.parse(line);

                    if (provider === 'gemini') {
                        /* 
                         * Gemini stream-json format:
                         * Text chunks come in as: {"type":"message","role":"assistant","content":"...","delta":true}
                         * The "result" event only contains stats.
                         */
                        if (event.type === 'message' && event.role === 'assistant' && event.content) {
                            finalResult = (finalResult || '') + event.content;
                            if (event.content.trim()) {
                                logger.info(`[Gemini] ${event.content.trim()} `);
                            }
                        }
                    } else {
                        /*
                         * Claude stream-json format (--output-format stream-json --verbose):
                         * - assistant: {"type":"assistant","message":{"content":[{"type":"text","text":"..."}|{"type":"tool_use","name":"..."}]}}
                         * - result:    {"type":"result","subtype":"success","result":"..."}
                         */
                        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
                            for (const block of event.message.content) {
                                if (block.type === 'text' && block.text) {
                                    accumulatedText += block.text;
                                    if (block.text.trim()) {
                                        process.stderr.write(`[Claude] ${block.text}`);
                                    }
                                } else if (block.type === 'tool_use') {
                                    logger.info(`[Claude] tool: ${block.name} (${JSON.stringify(block.input).slice(0, 120)})`);
                                }
                            }
                        } else if (event.type === 'result') {
                            finalResult = event.result || accumulatedText || null;
                        }
                    }
                } catch (_) { /* ignore non-JSON lines */ }
            }
        });

        const timeout = setTimeout(() => {
            proc.kill('SIGTERM');
            // Force-kill after 5 s grace period if process ignores SIGTERM
            setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 5000);
            reject(new Error(`${provider.toUpperCase()} CLI timed out after ${CLI_TIMEOUT_MS / 60000} minutes`));
        }, CLI_TIMEOUT_MS);

        proc.on('close', code => {
            clearTimeout(timeout);
            if (code !== 0) {
                reject(new Error(`${provider.toUpperCase()} CLI exited with code ${code} `));
                return;
            }
            // For Claude: fall back to accumulated stream text if no 'result' event was captured
            if (!finalResult && accumulatedText) {
                finalResult = accumulatedText;
            }
            if (!finalResult) {
                const stderrTail = stderrBuf.split('\n').filter(l => l.trim()).slice(-20).join('\n');
                reject(new Error(
                    `${provider.toUpperCase()} CLI exited successfully but no result was found in output.\n` +
                    `--- Last stderr (20 lines) ---\n${stderrTail || '(empty)'}`
                ));
                return;
            }
            resolve(finalResult);
        });

        proc.on('error', err => {
            clearTimeout(timeout);
            reject(new Error(`Failed to spawn ${provider.toUpperCase()} CLI: ` + err.message));
        });
    });
}
