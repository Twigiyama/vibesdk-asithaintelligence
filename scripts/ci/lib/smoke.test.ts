import { describe, expect, it } from 'vitest';
import { smokeChecks, type SmokeResponse } from './smoke';

const json = (body: unknown, status = 200): SmokeResponse => ({
	status,
	contentType: 'application/json; charset=UTF-8',
	body: JSON.stringify(body),
	headers: {},
});

const check = (name: string) => {
	const found = smokeChecks.find((c) => c.name === name);
	if (!found) throw new Error(`no smoke check named ${name}`);
	return found;
};

describe('smokeChecks', () => {
	it('covers liveness, shipped vars, a D1 query and the static assets', () => {
		expect(smokeChecks.map((c) => c.path)).toEqual([
			'/api/health',
			'/api/capabilities',
			'/api/apps/public?limit=1',
			'/',
		]);
	});

	describe('health', () => {
		const health = check('health');

		it('passes on {"status":"ok"}', () => {
			expect(health.validate(json({ status: 'ok' }))).toBeNull();
		});

		it('fails on another status value', () => {
			expect(health.validate(json({ status: 'degraded' }))).toMatch(/status/);
		});

		it('fails on an error status code', () => {
			expect(health.validate(json({ status: 'ok' }, 503))).toMatch(/503/);
		});

		it.each([301, 302, 404])('fails on HTTP %d, which is not a healthy answer', (status) => {
			expect(health.validate(json({ status: 'ok' }, status))).toContain(String(status));
		});
	});

	describe('capabilities', () => {
		const capabilities = check('capabilities');
		const ok = { success: true, data: { features: [{ id: 'app', enabled: true }], version: '1.0.0' } };

		it('passes when the platform lists features', () => {
			expect(capabilities.validate(json(ok))).toBeNull();
		});

		it('fails when the feature list is missing', () => {
			expect(capabilities.validate(json({ success: true, data: {} }))).toMatch(/features/);
		});

		it('fails when the response is not JSON', () => {
			expect(
				capabilities.validate({ status: 200, contentType: 'text/html', body: '<html>', headers: {} }),
			).toMatch(/JSON/);
		});
	});

	describe('public apps', () => {
		const apps = check('public apps');

		it('passes on a successful list, even when empty', () => {
			expect(apps.validate(json({ success: true, data: { apps: [] } }))).toBeNull();
		});

		it('fails when the D1 query errors', () => {
			expect(
				apps.validate(json({ success: false, error: { message: 'Failed to fetch public apps' } }, 500)),
			).toMatch(/500/);
		});

		it('fails when success is true but the list is missing', () => {
			expect(apps.validate(json({ success: true, data: {} }))).toMatch(/apps/);
		});
	});

	describe('assets', () => {
		const assets = check('assets');

		it('passes on an HTML document', () => {
			expect(
				assets.validate({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html>', headers: {} }),
			).toBeNull();
		});

		it.each([301, 302, 404])('fails on HTTP %d even when the body is HTML', (status) => {
			expect(
				assets.validate({ status, contentType: 'text/html', body: '<!doctype html>', headers: {} }),
			).toContain(String(status));
		});

		it('fails on a JSON response, which means the Worker answered instead of the assets', () => {
			expect(assets.validate(json({ error: 'x' }))).toMatch(/HTML/);
		});
	});

	describe('Cloudflare challenges', () => {
		it('points at the WAF when a check is challenged', () => {
			const blocked: SmokeResponse = {
				status: 403,
				contentType: 'text/html',
				body: 'Just a moment...',
				headers: { 'cf-mitigated': 'challenge' },
			};

			for (const c of smokeChecks) {
				expect(c.validate(blocked)).toMatch(/challenge.*WAF|WAF.*challenge/i);
			}
		});
	});
});
