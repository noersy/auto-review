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

# Set working directory for the bot
WORKDIR /app

# Copy bot source
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY docker-entrypoint.sh /docker-entrypoint.sh

# Give botuser ownership of /app and create writable .claude and .gemini dirs
RUN chown -R botuser:botuser /app && \
    mkdir -p /home/botuser/.claude && \
    chown -R botuser:botuser /home/botuser/.claude && \
    mkdir -p /home/botuser/.gemini && \
    chown -R botuser:botuser /home/botuser/.gemini && \
    chmod +x /docker-entrypoint.sh

USER botuser

# Claude Code CLI auth — credentials.json mounted at /run/secrets/claude-credentials
# and copied to writable ~/.claude/ by entrypoint
ENV CI=true

ENTRYPOINT ["/docker-entrypoint.sh"]
