import { spawn } from 'child_process';
import { logger } from './logger.js';
import config from './config.js';

const CLI_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export async function runProviderCLI(provider, promptText) {
    logger.info(`Executing ${provider.toUpperCase()} CLI...`);

    const claudeArgs = [
        '--yes', '@anthropic-ai/claude-code', '-p', promptText,
        '--dangerously-skip-permissions',
        '--output-format', 'stream-json',
        '--verbose'
    ];

    const repoDir = process.env.REPO_DIR ?? process.cwd();
    const geminiArgs = [
        '--yes', '@google/gemini-cli', '-p', promptText,
        '-y',
        '-o', 'stream-json',
        '--include-directories', repoDir,
        '--model', config.GEMINI_MODEL
    ];

    if (provider !== 'claude' && provider !== 'gemini') {
        throw new Error(`Unknown provider "${provider}". Expected "claude" or "gemini".`);
    }
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
                         * Text is accumulated directly into finalResult from assistant events;
                         * the result event's field is used only if no text was streamed.
                         */
                        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
                            for (const block of event.message.content) {
                                if (block.type === 'text' && block.text) {
                                    finalResult = (finalResult || '') + block.text;
                                    if (block.text.trim()) {
                                        logger.info(`[Claude] ${block.text.trim()}`);
                                    }
                                } else if (block.type === 'tool_use') {
                                    logger.info(`[Claude] tool: ${block.name} (${JSON.stringify(block.input).slice(0, 120)})`);
                                }
                            }
                        } else if (event.type === 'result' && !finalResult) {
                            finalResult = event.result || null;
                        }
                    }
                } catch (_) { /* ignore non-JSON lines */ }
            }
        });

        const timeout = setTimeout(() => {
            proc.kill('SIGTERM');
            // Force-kill after 5 s grace period if process ignores SIGTERM
            setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) { } }, 5000);
            reject(new Error(`${provider.toUpperCase()} CLI timed out after ${CLI_TIMEOUT_MS / 60000} minutes`));
        }, CLI_TIMEOUT_MS);

        proc.on('close', code => {
            clearTimeout(timeout);
            // Process any remaining buffered content that lacked a trailing newline
            if (stdoutBuf.trim()) {
                try {
                    const event = JSON.parse(stdoutBuf);
                    if (provider === 'gemini') {
                        if (event.type === 'message' && event.role === 'assistant' && event.content) {
                            finalResult = (finalResult || '') + event.content;
                        }
                    } else {
                        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
                            for (const block of event.message.content) {
                                if (block.type === 'text' && block.text) {
                                    finalResult = (finalResult || '') + block.text;
                                }
                            }
                        } else if (event.type === 'result' && !finalResult) {
                            finalResult = event.result || null;
                        }
                    }
                } catch (_) { /* ignore non-JSON remainder */ }
            }
            if (code !== 0) {
                reject(new Error(`${provider.toUpperCase()} CLI exited with code ${code}`));
                return;
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
