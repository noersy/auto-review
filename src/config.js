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
    GEMINI_MODEL: 'gemini-3.1-pro-preview',
    // GEMINI_MODEL: 'gemini-2.5-pro',
};
