import { describe, expect, it } from 'vitest';
import { assertWorkerName, readCloudflareEnv } from './env';

const TOKEN = 'cf-token-sentinel-0123456789';

describe('readCloudflareEnv', () => {
	it('returns the credentials and the expected Worker name', () => {
		expect(
			readCloudflareEnv({
				CLOUDFLARE_API_TOKEN: TOKEN,
				CLOUDFLARE_ACCOUNT_ID: 'acct123',
				WORKER_NAME: 'vibesdk-production',
			}),
		).toEqual({ token: TOKEN, accountId: 'acct123', expectedWorkerName: 'vibesdk-production' });
	});

	it('treats the expected Worker name as optional', () => {
		const env = readCloudflareEnv({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: 'acct123' });

		expect(env.expectedWorkerName).toBeUndefined();
	});

	it('treats an empty Worker name as unset', () => {
		const env = readCloudflareEnv({
			CLOUDFLARE_API_TOKEN: TOKEN,
			CLOUDFLARE_ACCOUNT_ID: 'acct123',
			WORKER_NAME: '',
		});

		expect(env.expectedWorkerName).toBeUndefined();
	});

	it('lists every missing variable by name, without revealing the others', () => {
		expect(() => readCloudflareEnv({ CLOUDFLARE_API_TOKEN: TOKEN })).toThrow(
			'Missing environment variable(s): CLOUDFLARE_ACCOUNT_ID',
		);

		let message = '';
		try {
			readCloudflareEnv({ CLOUDFLARE_ACCOUNT_ID: 'acct123' });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain('CLOUDFLARE_API_TOKEN');
		expect(message).not.toContain('acct123');
	});

	it('treats an empty token as missing', () => {
		expect(() =>
			readCloudflareEnv({ CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: 'acct123' }),
		).toThrow('CLOUDFLARE_API_TOKEN');
	});
});

describe('readCloudflareEnv API base URL', () => {
	const base = { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: 'acct123' };

	it('defaults to the real API', () => {
		expect(readCloudflareEnv(base).apiBaseUrl).toBeUndefined();
	});

	it.each(['http://127.0.0.1:8787', 'http://localhost:9000/client/v4', 'http://localhost'])(
		'allows the local test server %s',
		(url) => {
			expect(readCloudflareEnv({ ...base, CLOUDFLARE_API_BASE_URL: url }).apiBaseUrl).toBe(url);
		},
	);

	it.each([
		'https://api.cloudflare.com/client/v4',
		'https://evil.example.com',
		'http://localhost.evil.example.com',
		'http://127.0.0.1.evil.example.com',
		'http://user@evil.example.com',
		'ftp://localhost',
	])('refuses %s so the token can only be sent to Cloudflare or localhost', (url) => {
		expect(() => readCloudflareEnv({ ...base, CLOUDFLARE_API_BASE_URL: url })).toThrow(
			'CLOUDFLARE_API_BASE_URL may only point at localhost',
		);
	});
});

describe('assertWorkerName', () => {
	it('accepts a matching name', () => {
		expect(() => assertWorkerName('vibesdk-production', 'vibesdk-production')).not.toThrow();
	});

	it('is satisfied when no name is expected', () => {
		expect(() => assertWorkerName('vibesdk-production', undefined)).not.toThrow();
	});

	it('refuses to act on a different Worker than the one configured for the environment', () => {
		expect(() => assertWorkerName('vibesdk-staging', 'vibesdk-production')).toThrow(
			'WORKER_NAME is vibesdk-production but the configuration names vibesdk-staging',
		);
	});

	it('refuses a configuration with no name when one is expected', () => {
		expect(() => assertWorkerName(undefined, 'vibesdk-production')).toThrow(
			'the configuration names no Worker',
		);
	});
});
