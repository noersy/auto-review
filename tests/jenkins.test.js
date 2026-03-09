import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../src/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { logger } = await import('../src/logger.js');
const { buildWebhookPayload, triggerJenkinsJob, logTriggerResult } = await import('../src/jenkins.js');

// ─── buildWebhookPayload ───────────────────────────────────────────────────

describe('buildWebhookPayload', () => {
    it('sets pull_request.number and label=auto-review for "review" type', () => {
        const payload = buildWebhookPayload('review', 'owner/repo', 42, 'gemini');
        expect(payload.pull_request.number).toBe(42);
        expect(payload.label.name).toBe('auto-review');
        expect(payload.issue.number).toBe(0);
    });

    it('sets issue.number and label=auto-fix for "fix" type', () => {
        const payload = buildWebhookPayload('fix', 'owner/repo', 7, 'claude');
        expect(payload.issue.number).toBe(7);
        expect(payload.label.name).toBe('auto-fix');
        expect(payload.pull_request.number).toBe(0);
    });

    it('coerces string number to integer', () => {
        const payload = buildWebhookPayload('review', 'owner/repo', '15', 'gemini');
        expect(payload.pull_request.number).toBe(15);
        expect(typeof payload.pull_request.number).toBe('number');
    });

    it('includes repo full_name', () => {
        const payload = buildWebhookPayload('review', 'myorg/myapp', 1, 'gemini');
        expect(payload.repository.full_name).toBe('myorg/myapp');
    });

    it('includes provider', () => {
        const payload = buildWebhookPayload('review', 'o/r', 1, 'claude');
        expect(payload.provider).toBe('claude');
    });

    it('sets action to "labeled"', () => {
        const payload = buildWebhookPayload('review', 'o/r', 1, 'gemini');
        expect(payload.action).toBe('labeled');
    });

    it('sets sender.login to "cli-trigger"', () => {
        const payload = buildWebhookPayload('fix', 'o/r', 1, 'gemini');
        expect(payload.sender.login).toBe('cli-trigger');
    });

    it('sets merged to false', () => {
        const payload = buildWebhookPayload('review', 'o/r', 1, 'gemini');
        expect(payload.pull_request.merged).toBe(false);
    });
});

// ─── triggerJenkinsJob ────────────────────────────────────────────────────

describe('triggerJenkinsJob', () => {
    const mockFetch = jest.fn();
    const payload = { action: 'labeled' };

    beforeEach(() => {
        mockFetch.mockReset();
        global.fetch = mockFetch;
    });

    it('POSTs to the correct Jenkins endpoint with token', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ jobs: {} }),
        });
        await triggerJenkinsJob('http://jenkins:8080', 'my-token', payload);
        const [url, opts] = mockFetch.mock.calls[0];
        expect(url).toContain('/generic-webhook-trigger/invoke');
        expect(url).toContain('token=my-token');
        expect(opts.method).toBe('POST');
        expect(opts.headers['Content-Type']).toBe('application/json');
    });

    it('adds Basic Auth header when user+apiToken provided', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => '{}',
        });
        await triggerJenkinsJob('http://jenkins', 'tok', payload, { user: 'admin', apiToken: 'secret' });
        const [, opts] = mockFetch.mock.calls[0];
        expect(opts.headers['Authorization']).toMatch(/^Basic /);
        const decoded = Buffer.from(opts.headers['Authorization'].split(' ')[1], 'base64').toString();
        expect(decoded).toBe('admin:secret');
    });

    it('does not add Authorization header when auth is missing', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => '{}',
        });
        await triggerJenkinsJob('http://jenkins', 'tok', payload);
        const [, opts] = mockFetch.mock.calls[0];
        expect(opts.headers['Authorization']).toBeUndefined();
    });

    it('strips trailing slash from base URL', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => '{}',
        });
        await triggerJenkinsJob('http://jenkins:8080///', 'tok', payload);
        const [url] = mockFetch.mock.calls[0];
        expect(url).not.toContain('///');
    });

    it('throws on 401', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' });
        await expect(triggerJenkinsJob('http://j', 'tok', payload)).rejects.toThrow('401 Unauthorized');
    });

    it('throws on 403', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 403, text: async () => 'Forbidden' });
        await expect(triggerJenkinsJob('http://j', 'tok', payload)).rejects.toThrow('403 Forbidden');
    });

    it('throws on 404', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 404, text: async () => 'Not Found' });
        await expect(triggerJenkinsJob('http://j', 'tok', payload)).rejects.toThrow('404');
    });

    it('throws when fetch itself fails (network error)', async () => {
        mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
        await expect(triggerJenkinsJob('http://j', 'tok', payload)).rejects.toThrow('Gagal terhubung ke Jenkins');
    });

    it('returns parsed JSON on success', async () => {
        const responseData = { jobs: { 'my-job': { triggered: true, id: 10 } } };
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify(responseData),
        });
        const result = await triggerJenkinsJob('http://j', 'tok', payload);
        expect(result).toEqual(responseData);
    });

    it('returns { raw: body } when response is OK but body is not JSON', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => 'Triggered.',
        });
        const result = await triggerJenkinsJob('http://j', 'tok', payload);
        expect(result).toEqual({ raw: 'Triggered.' });
    });

    it('throws with status info when response is not OK and body is not JSON', async () => {
        mockFetch.mockResolvedValue({
            ok: false,
            status: 500,
            text: async () => 'Internal Server Error',
        });
        await expect(triggerJenkinsJob('http://j', 'tok', payload)).rejects.toThrow('500');
    });
});

// ─── logTriggerResult ─────────────────────────────────────────────────────

describe('logTriggerResult', () => {
    beforeEach(() => {
        logger.info.mockReset();
        logger.warn.mockReset();
    });

    it('logs info for each triggered job', () => {
        logTriggerResult({ jobs: { 'build-app': { triggered: true, id: 5, url: 'http://j/job/5' } } });
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('build-app'));
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('#5'));
    });

    it('logs warning for untriggered jobs', () => {
        logTriggerResult({ jobs: { 'build-app': { triggered: false, regexpFilterExpression: 'no match' } } });
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('NOT triggered'));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no match'));
    });

    it('logs raw JSON when no jobs field', () => {
        logTriggerResult({ status: 'ok' });
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Jenkins response'));
    });

    it('logs job URL when present', () => {
        logTriggerResult({ jobs: { 'my-job': { triggered: true, id: 1, url: 'http://j/1' } } });
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('http://j/1'));
    });

    it('uses "?" when job id is missing', () => {
        logTriggerResult({ jobs: { 'my-job': { triggered: true } } });
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('#?'));
    });
});
