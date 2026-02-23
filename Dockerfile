FROM node:22-slim

# Install git and npx dependencies
RUN apt-get update && apt-get install -y \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set working directory for the bot
WORKDIR /app

# Copy bot source
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

# Claude Code CLI auth — mounted at runtime via volume or env
# (see docker-run-local.sh)
ENV CI=true

ENTRYPOINT ["node", "src/index.js"]
