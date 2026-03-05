import 'dotenv/config';
import { Octokit } from '@octokit/rest';
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const { data } = await octokit.issues.listComments({ owner: 'noersy', repo: 'auto-review-sandbox', issue_number: 5 });
data.forEach(c => {
    console.log('--- ID:', c.id, '| User:', c.user.login, '(', c.user.type, ') | Created:', c.created_at);
    console.log('Has marker:', c.body.includes('<!-- auto-review-bot -->'));
    console.log('Body preview:', c.body.substring(0, 400));
    console.log('');
});
