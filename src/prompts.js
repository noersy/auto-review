import { CLAUDE_REVIEW_FILE } from './config.js';

export function buildReviewPrompt(prTitle, additions, deletions) {
    return `You are an expert Principal Software Engineer acting as a code reviewer.
I have checked out a Pull Request branch titled "${prTitle}". The PR has +${additions} and -${deletions} lines.
Please review the changes in this branch against the main branch (e.g., using \`git diff origin/main...\`).
If needed, inspect the full files to understand the context.

Focus on:
1. Finding actual bugs or logical errors.
2. Security vulnerabilities.
3. Performance bottlenecks.
4. Serious code smell.
Ignore minor stylistic issues unless they are egregious.

Write your final response in Markdown format. Save your final output strictly to a file named '${CLAUDE_REVIEW_FILE}' in the current directory. 
DO NOT use pagination or interactive tools to ask me for confirmation. Do the entire review and write the file. Exit immediately after writing the file.`;
}

export function buildReplyPrompt(conversationText) {
    return `You are an expert Principal Software Engineer. 
A developer is asking you a question regarding a Pull Request review.
Here is the conversation context:
${conversationText}

Please use your tools to inspect the repository code if you need more context to answer the question.
Write your final response to the user in Markdown format. Save your final output strictly to a file named '${CLAUDE_REVIEW_FILE}' in the current directory.
DO NOT use interactive tools to ask me for confirmation. Just write the answer file and finish.`;
}
