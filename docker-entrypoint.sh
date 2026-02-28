#!/bin/bash
# Copy credentials from read-only mount to writable ~/.claude/ dir
if [ -f /run/secrets/claude-credentials ]; then
    cp /run/secrets/claude-credentials /home/botuser/.claude/.credentials.json
fi

# Copy Gemini credentials from read-only mount to writable ~/.gemini/ dir
if [ -f /run/secrets/gemini-credentials ]; then
    cp /run/secrets/gemini-credentials /home/botuser/.gemini/oauth_creds.json
    mkdir -p /root/.gemini /home/user/.gemini
    cp /run/secrets/gemini-credentials /root/.gemini/oauth_creds.json
    cp /run/secrets/gemini-credentials /home/user/.gemini/oauth_creds.json 2>/dev/null || true
fi

if [ -f /run/secrets/gemini-settings ]; then
    cp /run/secrets/gemini-settings /home/botuser/.gemini/settings.json
    cp /run/secrets/gemini-settings /root/.gemini/settings.json
    cp /run/secrets/gemini-settings /home/user/.gemini/settings.json 2>/dev/null || true
fi

exec node /app/src/index.js "$@"
