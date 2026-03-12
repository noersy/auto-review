import { logger } from './logger.js';
import config from './config.js';

/**
 * Build a JSON payload that matches the Jenkinsfile GenericTrigger variables.
 *
 * @param {'review'|'fix'} triggerType
 * @param {string} repo          – "owner/repo"
 * @param {string|number} number – PR or issue number
 * @param {string} provider      – "claude" or "gemini"
 * @returns {object}
 */
export function buildWebhookPayload(triggerType, repo, number, provider) {
    const isReview = triggerType === 'review';
    return {
        action: 'labeled',
        repository: { full_name: repo },
        pull_request: {
            number: isReview ? Number(number) : 0,
            head: { ref: '' },
            merged: false,
        },
        label: { name: isReview ? config.AUTO_REVIEW_LABEL : config.AUTO_FIX_LABEL },
        sender: { login: 'cli-trigger' },
        comment: { body: '' },
        issue: { number: isReview ? 0 : Number(number) },
        provider,
    };
}

/**
 * Send a POST to the Jenkins Generic Webhook Trigger endpoint.
 *
 * @param {string} jenkinsUrl    – base URL, e.g. "http://jenkins:8080"
 * @param {string} webhookToken  – GenericTrigger token
 * @param {object} payload       – webhook body
 * @param {{ user?: string, apiToken?: string }} [auth] – optional Basic Auth
 * @returns {Promise<object>}    – parsed Jenkins response
 */
export async function triggerJenkinsJob(jenkinsUrl, webhookToken, payload, auth) {
    const url = `${jenkinsUrl.replace(/\/+$/, '')}/generic-webhook-trigger/invoke?token=${encodeURIComponent(webhookToken)}`;

    const headers = { 'Content-Type': 'application/json' };
    if (auth?.user && auth?.apiToken) {
        const encoded = Buffer.from(`${auth.user}:${auth.apiToken}`).toString('base64');
        headers['Authorization'] = `Basic ${encoded}`;
    }

    logger.info(`POST ${url}`);

    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });
    } catch (err) {
        throw new Error(`Gagal terhubung ke Jenkins: ${err.message}`);
    }

    if (res.status === 401) {
        throw new Error('Jenkins menolak request (401 Unauthorized). Cek JENKINS_USER / JENKINS_API_TOKEN.');
    }
    if (res.status === 403) {
        throw new Error('Jenkins menolak request (403 Forbidden). Cek permission user atau CSRF setting.');
    }
    if (res.status === 404) {
        throw new Error(`Endpoint tidak ditemukan (404). Pastikan URL benar dan Generic Webhook Trigger plugin terinstall.`);
    }

    const body = await res.text();
    let data;
    try {
        data = JSON.parse(body);
    } catch {
        if (!res.ok) throw new Error(`Jenkins responded ${res.status}: ${body.slice(0, 200)}`);
        return { raw: body };
    }

    if (!res.ok) {
        throw new Error(`Jenkins responded ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    }

    return data;
}

/**
 * Pretty-print the Jenkins trigger response.
 */
export function logTriggerResult(data) {
    if (data.jobs) {
        for (const [name, info] of Object.entries(data.jobs)) {
            if (info.triggered) {
                logger.info(`✅ Job "${name}" triggered — build #${info.id ?? '?'}`);
                if (info.url) logger.info(`   ${info.url}`);
            } else {
                logger.warn(`⚠️  Job "${name}" NOT triggered (${info.regexpFilterExpression ?? 'unknown reason'})`);
            }
        }
    } else {
        logger.info(`Jenkins response: ${JSON.stringify(data).slice(0, 300)}`);
    }
}
