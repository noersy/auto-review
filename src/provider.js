import { spawn } from 'child_process';
import { logger } from './logger.js';

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
        '-o', 'stream-json'
    ];

    const providerArgs = provider === 'gemini' ? geminiArgs : claudeArgs;

    return new Promise((resolve, reject) => {
        const proc = spawn('npx', providerArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, CI: 'true' },
            shell: false
        });

        // Pipe stderr live so we can see what the CLI is doing
        proc.stderr.on('data', chunk => {
            process.stderr.write(chunk);
        });

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

                    if (provider === 'gemini') {
                        /* 
                         * Gemini CLI might have different stream-json format. 
                         * Adapting to potential structures to grab the final result.
                         */
                        if (event.type === 'result') {
                            finalResult = event.result;
                        } else if (event.message?.content) {
                            // E.g. {"type": "assistant", "message": {"content": [{ "text": "...", "type": "text" }]}}
                            for (const block of event.message.content) {
                                if (block.type === 'text' && block.text?.trim()) {
                                    logger.info(`[Gemini] ${block.text.trim()}`);
                                }
                            }
                        } else if (event.text) {
                            // Fallback if just text chunks are produced
                            finalResult = (finalResult || '') + event.text;
                        }
                    } else {
                        // Claude Original parsing
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
                    }
                } catch (_) { /* ignore non-JSON lines */ }
            }
        });

        proc.on('close', code => {
            if (code !== 0) {
                reject(new Error(`${provider.toUpperCase()} CLI exited with code ${code}`));
                return;
            }
            if (!finalResult) {
                reject(new Error(`${provider.toUpperCase()} CLI exited successfully but no result was found in output.`));
                return;
            }
            resolve(finalResult);
        });

        proc.on('error', err => {
            reject(new Error(`Failed to spawn ${provider.toUpperCase()} CLI: ` + err.message));
        });
    });
}
