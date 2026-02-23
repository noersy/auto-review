#!/bin/bash
# Copy credentials from read-only mount to writable ~/.claude/ dir
if [ -f /run/secrets/claude-credentials ]; then
    cp /run/secrets/claude-credentials /home/botuser/.claude/.credentials.json
fi
exec node /app/src/index.js "$@"
