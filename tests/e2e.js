import 'dotenv/config';
import { Octokit } from '@octokit/rest';
import crypto from 'crypto';

// Default options
const REPO = process.env.E2E_REPO || 'noersy/auto-review-sandbox';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const JENKINS_URL = process.env.JENKINS_URL || 'http://localhost:8080';
const JENKINS_TOKEN = process.env.JENKINS_TOKEN || 'headless-agent-webhook';
const PROVIDER = process.env.E2E_PROVIDER || 'gemini';
const BOT_USERNAME = process.env.E2E_BOT_USERNAME || 'fei-reviewer';

if (!GITHUB_TOKEN) {
    console.error('Error: GITHUB_TOKEN environment variable is required.');
    process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps a GitHub API call with retry logic for transient errors (5xx, ECONNRESET, etc.)
 * Transient errors are silently retried; fatal errors (4xx) are rethrown immediately.
 */
async function safeApiCall(fn, retries = 3, delayMs = 3000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const status = err?.status ?? err?.response?.status;
            const isTransient = !status || status >= 500 ||
                ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'other side closed'].some(
                    msg => err.message?.includes(msg)
                );
            if (isTransient && attempt < retries) {
                process.stdout.write(`[retry ${attempt}/${retries - 1}]`);
                await sleep(delayMs);
            } else {
                throw err;
            }
        }
    }
}

async function triggerJenkins(payload) {
    console.log(`\n⚙️  Triggering Jenkins Pipeline (Action: ${payload.action})...`);
    const jenkinsTriggerUrl = `${JENKINS_URL.replace(/\/$/, '')}/generic-webhook-trigger/invoke?token=${JENKINS_TOKEN}`;
    const jenkinsRes = await fetch(jenkinsTriggerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!jenkinsRes.ok) {
        throw new Error(`Jenkins trigger failed: ${jenkinsRes.status} ${jenkinsRes.statusText}`);
    }
    const jenkinsJson = await jenkinsRes.json();
    console.log(`✅ Jenkins triggered successfully:`, jenkinsJson.jobs);
}

async function runE2E() {
    console.log(`🚀 Starting E2E test against Sandbox Repo: ${REPO}`);
    const [owner, repo] = REPO.split('/');
    const runId = crypto.randomBytes(4).toString('hex');
    let prNumber = null;
    let issueNumber = null;
    let branchName = `e2e-test/${runId}`;

    try {
        // --- 1. SETUP ---
        const { data: repoData } = await octokit.repos.get({ owner, repo });
        const defaultBranch = repoData.default_branch;
        const { data: refData } = await octokit.git.getRef({ owner, repo, ref: `heads/${defaultBranch}` });
        const baseSha = refData.object.sha;

        console.log(`\n--- FLOW 1: Auto-Review ---`);
        console.log(`🌿 Creating branch: ${branchName} from ${defaultBranch}`);
        await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branchName}`, sha: baseSha });

        const fileName = `test-file-${runId}.js`;
        // Intentionally bad code so the bot has something to review
        const badCode = `console.log('E2E Run ${runId}');\nvar x = 10; function calculate(){ return x * 2; }`;
        const fileContent = Buffer.from(badCode).toString('base64');

        await octokit.repos.createOrUpdateFileContents({
            owner, repo, path: fileName, message: `E2E Test: Add dummy file ${runId}`, content: fileContent, branch: branchName
        });

        console.log(`🔄 Creating Pull Request from ${branchName} to ${defaultBranch} ...`);
        const { data: prData } = await octokit.pulls.create({
            owner, repo, title: `E2E Test PR ${runId}`, head: branchName, base: defaultBranch, body: `Automated E2E PR.`
        });
        prNumber = prData.number;
        console.log(`✅ PR #${prNumber} created: ${prData.html_url}`);

        // Trigger Auto-Review
        await triggerJenkins({
            action: 'opened', repository: { full_name: REPO },
            pull_request: { number: prNumber, head: { ref: branchName }, merged: false },
            comment: { body: '' }, issue: { number: 0 }, label: { name: '' },
            sender: { login: 'e2e-script' }, provider: PROVIDER
        });

        // Poll for Review
        console.log(`⏳ Waiting for bot review (Timeout: 10 mins)...`);
        let reviewComment = false;
        for (let i = 0; i < 120; i++) {
            await sleep(5000);
            const { data: comments } = await safeApiCall(() =>
                octokit.issues.listComments({ owner, repo, issue_number: prNumber })
            );
            if (comments.some(c => c.body.includes('<!-- auto-review-bot -->'))) {
                reviewComment = true; break;
            }
            process.stdout.write('.');
        }
        console.log('');
        if (!reviewComment) throw new Error("Bot did not post review comment.");
        console.log(`🎉 Auto-Review successful!`);

        // --- FLOW 2: Auto-Reply ---
        console.log(`\n--- FLOW 2: Auto-Reply ---`);
        const userComment = `@fei-reviewer can you explain the code I just wrote?`;
        console.log(`💬 Posting comment to PR #${prNumber} ...`);
        const { data: commentData } = await octokit.issues.createComment({
            owner, repo, issue_number: prNumber, body: userComment
        });

        // Record existing comment IDs before triggering so we can detect NEW bot comments after it
        const { data: initialComments } = await octokit.issues.listComments({ owner, repo, issue_number: prNumber });
        const existingCommentIds = new Set(initialComments.map(c => c.id));

        // Trigger Reply
        await triggerJenkins({
            action: 'created', repository: { full_name: REPO },
            pull_request: { number: prNumber, head: { ref: branchName }, merged: false },
            comment: { body: userComment }, issue: { number: prNumber }, label: { name: '' },
            sender: { login: 'e2e-tester-human' }, provider: PROVIDER
        });

        console.log(`⏳ Waiting for bot reply (Timeout: 10 mins)...`);
        let replyComment = false;
        for (let i = 0; i < 120; i++) {
            await sleep(5000);
            const { data: comments } = await safeApiCall(() =>
                octokit.issues.listComments({ owner, repo, issue_number: prNumber })
            );
            // Look for any NEW comment from the bot.
            // Exclude:
            //   - review comments (marked with <!-- auto-review-bot -->)
            //   - security scan comments (marked with <!-- auto-review-security -->)
            const botReply = comments.find(c =>
                c.user.login === BOT_USERNAME &&
                !existingCommentIds.has(c.id) &&
                !c.body.includes('<!-- auto-review-bot -->') &&
                !c.body.includes('<!-- auto-review-security -->')
            );
            if (botReply) {
                replyComment = true; break;
            }
            process.stdout.write('.');
        }
        console.log('');
        if (!replyComment) throw new Error("Bot did not reply to comment.");
        console.log(`🎉 Auto-Reply successful!`);

        // --- FLOW 3: Auto-Fix ---
        console.log(`\n--- FLOW 3: Auto-Fix ---`);
        console.log(`🐛 Creating Issue asking for fix...`);
        const { data: issueData } = await octokit.issues.create({
            owner, repo, title: `Bug: Fix global variable in ${fileName}`,
            body: `Please fix the var x declaration and make calculate a proper arrow function.`
        });
        issueNumber = issueData.number;
        console.log(`✅ Issue #${issueNumber} created.`);

        console.log(`🏷️  Adding auto-fix label...`);
        await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: ['auto-fix'] });

        // Trigger Auto-Fix
        // NOTE: Do NOT include pull_request in this payload.
        // GitHub sends no pull_request for issue labeled events.
        // If we send pull_request.number=0, Groovy treats "0" as truthy and
        // GH_PR_NUMBER never falls back to GH_ISSUE_NUMBER.
        await triggerJenkins({
            action: 'labeled', repository: { full_name: REPO },
            comment: { body: '' }, issue: { number: issueNumber }, label: { name: 'auto-fix' },
            sender: { login: 'e2e-script' }, provider: PROVIDER
        });

        console.log(`⏳ Waiting for bot to create PR for issue #${issueNumber} (Timeout: 10 mins)...`);
        let fixPrNumber = null;
        for (let i = 0; i < 120; i++) { // Auto-fix takes longer
            await sleep(5000);
            const { data: pulls } = await safeApiCall(() =>
                octokit.pulls.list({ owner, repo, state: 'open', head: `${owner}:auto-fix/issue-${issueNumber}` })
            );
            if (pulls.length > 0) {
                fixPrNumber = pulls[0].number; break;
            }
            process.stdout.write('.');
        }
        console.log('');
        if (!fixPrNumber) throw new Error("Bot did not create auto-fix PR.");
        console.log(`🎉 Auto-Fix successful! PR #${fixPrNumber} created.`);

        // --- FLOW 4: Auto-Close ---
        // We will merge the fix PR and ensure the bot closes the issue.
        console.log(`\n--- FLOW 4: Auto-Close ---`);
        console.log(`🔀 Merging auto-fix PR #${fixPrNumber}...`);
        await octokit.pulls.merge({ owner, repo, pull_number: fixPrNumber });

        // Trigger Auto-Close
        await triggerJenkins({
            action: 'closed', repository: { full_name: REPO },
            pull_request: { number: fixPrNumber, head: { ref: `auto-fix/issue-${issueNumber}` }, merged: true },
            comment: { body: '' }, issue: { number: 0 }, label: { name: '' },
            sender: { login: 'e2e-script' }, provider: PROVIDER
        });

        console.log(`⏳ Waiting for bot to close issue #${issueNumber} (Timeout: 10 mins)...`);
        let issueClosed = false;
        for (let i = 0; i < 120; i++) {
            await sleep(5000);
            const { data: checkIssue } = await safeApiCall(() =>
                octokit.issues.get({ owner, repo, issue_number: issueNumber })
            );
            if (checkIssue.state === 'closed') {
                issueClosed = true; break;
            }
            process.stdout.write('.');
        }
        console.log('');
        if (!issueClosed) throw new Error("Bot did not close the issue after PR merge.");
        console.log(`🎉 Auto-Close successful!`);

    } catch (err) {
        console.error('\n❌ E2E Test Failed:', err.message);
        if (err.response) console.error(err.response.data);
        process.exitCode = 1;
    } finally {
        // --- CLEANUP ---
        console.log(`\n🧹 Cleaning up Sandbox Repo...`);
        try {
            if (prNumber) await octokit.pulls.update({ owner, repo, pull_number: prNumber, state: 'closed' });
        } catch (e) { }
        try {
            if (issueNumber) await octokit.issues.update({ owner, repo, issue_number: issueNumber, state: 'closed' });
        } catch (e) { }
        try {
            await octokit.git.deleteRef({ owner, repo, ref: `heads/${branchName}` });
        } catch (e) { }
        // Also cleanup auto-fix branch if exists
        if (issueNumber) {
            try {
                await octokit.git.deleteRef({ owner, repo, ref: `heads/auto-fix/issue-${issueNumber}` });
            } catch (e) { }
        }
        console.log(`✅ Cleanup complete.`);
    }
}

runE2E();
