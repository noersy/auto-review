#!/bin/bash
# Copy credentials from read-only mount to writable ~/.claude/ dir
if [ -f /run/secrets/claude-credentials ]; then
    cp /run/secrets/claude-credentials /home/botuser/.claude/.credentials.json
fi

# Copy Gemini credentials from read-only mount to writable ~/.gemini/ dir
if [ -f /run/secrets/gemini-credentials ]; then
    cp /run/secrets/gemini-credentials /home/botuser/.gemini/oauth_creds.json
fi

if [ -f /run/secrets/gemini-settings ]; then
    cp /run/secrets/gemini-settings /home/botuser/.gemini/settings.json
fi

exec "$@"
