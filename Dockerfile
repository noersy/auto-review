FROM node:22-slim

# Install necessary system dependencies (git, ca-certificates, and procps for pgrep)
RUN apt-get update && apt-get install -y \
    git \
    ca-certificates \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user (required: claude-code --dangerously-skip-permissions
# refuses to run as root)
RUN useradd -m -s /bin/bash botuser

# Create writable dirs for botuser
RUN mkdir -p /home/botuser/.claude /home/botuser/.gemini /app && \
    chown -R botuser:botuser /home/botuser/.claude /home/botuser/.gemini /app

# /app and /repo are populated at runtime via Jenkinsfile (git clone + docker cp)
# No ENTRYPOINT or CMD — container is started with 'sleep infinity' and
# commands are run via 'docker exec'

ENV CI=true

USER botuser
