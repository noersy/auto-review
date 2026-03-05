export default {
    // Thresholds
    MASSIVE_PR_LINES: 5500,        // Max total lines before bailing out
    REPLY_COOLDOWN_MS: 60 * 1000,  // Minimum ms between bot replies on the same PR (Flow B)

    // Bot Identity
    BOT_USERNAME: 'fei-reviewer',  // Set to the real github bot username
    BOT_MENTION: '@fei-reviewer',

    // Labels
    AUTO_FIX_LABEL: 'auto-fix',
    AUTO_REVIEW_LABEL: 'auto-review',

    // Jenkins
    WEBHOOK_TOKEN: 'headless-agent-webhook',

    // LLM Models
    // Heavy Models (for complex reasoning, bug finding, reviews)
    GEMINI_MODEL: 'gemini-2.5-pro',
    CLAUDE_MODEL: 'claude-3-5-sonnet-20241022',

    // Light Models (for routing, validation, summarization)
    GEMINI_LIGHT_MODEL: 'gemini-2.5-flash',
    CLAUDE_LIGHT_MODEL: 'claude-3-5-haiku-20241022',

    // Security Scanner
    SECURITY_SCAN_ENABLED: true,
    SECURITY_RISK_LABEL: 'security-risk',
    SECURITY_STATUS_CONTEXT: 'auto-review/security',
    SECURITY_BLOCK_ON: ['critical', 'high'],
};
