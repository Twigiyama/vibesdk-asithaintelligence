import { describe, expect, it } from 'vitest';
import {
	CloudflareApiError,
	createDeployment,
	fetchAppliedD1Migrations,
	fetchLiveWorker,
	type FetchLike,
} from './cloudflare';

const TOKEN = 'cf-token-sentinel-0123456789';
const ACCOUNT = 'acct123';
const WORKER = 'vibesdk-production';
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;

interface Route {
	status?: number;
	body: unknown;
}

function fakeFetch(routes: Record<string, Route>) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fetchImpl: FetchLike = async (url, init) => {
		calls.push({ url, init });
		const route = routes[url];
		if (!route) return new Response(JSON.stringify({ success: false, errors: [{ message: 'no route' }] }), { status: 599 });
		return new Response(JSON.stringify(route.body), {
			status: route.status ?? 200,
			headers: { 'content-type': 'application/json' },
		});
	};
	return { fetchImpl, calls };
}

const ok = (result: unknown): Route => ({ body: { success: true, errors: [], result } });

const liveRoutes = (): Record<string, Route> => ({
	[`${BASE}/workers/services/${WORKER}/environments/production`]: ok({
		script: { migration_tag: 'v6', compatibility_date: '2026-05-23' },
	}),
	[`${BASE}/workers/services/${WORKER}/environments/production/bindings`]: ok([
		{ name: 'DB', type: 'd1', id: 'd1-id' },
		{ name: 'JWT_SECRET', type: 'secret_text' },
	]),
	[`${BASE}/workers/scripts/${WORKER}/secrets`]: ok([
		{ name: 'JWT_SECRET', type: 'secret_text' },
		{ name: 'ANTHROPIC_API_KEY', type: 'secret_text' },
	]),
	[`${BASE}/workers/scripts/${WORKER}/deployments`]: ok({
		deployments: [
			{
				id: 'dep-2',
				created_on: '2026-10-25T11:00:00Z',
				source: 'wrangler',
				annotations: { 'workers/triggered_by': 'upload', 'workers/message': 'feat: x' },
				versions: [{ version_id: 'ver-2', percentage: 100 }],
			},
			{
				id: 'dep-1',
				created_on: '2026-10-25T10:00:00Z',
				source: 'api',
				versions: [{ version_id: 'ver-1', percentage: 100 }],
			},
		],
	}),
});

describe('fetchLiveWorker', () => {
	it('assembles the live state of an existing Worker', async () => {
		const { fetchImpl } = fakeFetch(liveRoutes());

		const live = await fetchLiveWorker({ accountId: ACCOUNT, workerName: WORKER, token: TOKEN, fetchImpl });

		expect(live).toEqual({
			exists: true,
			migrationTag: 'v6',
			bindings: [
				{ name: 'DB', type: 'd1', id: 'd1-id' },
				{ name: 'JWT_SECRET', type: 'secret_text' },
			],
			secretNames: ['JWT_SECRET', 'ANTHROPIC_API_KEY'],
			deployments: [
				{
					id: 'dep-2',
					createdOn: '2026-10-25T11:00:00Z',
					source: 'wrangler',
					triggeredBy: 'upload',
					message: 'feat: x',
					versions: [{ versionId: 'ver-2', percentage: 100 }],
				},
				{
					id: 'dep-1',
					createdOn: '2026-10-25T10:00:00Z',
					source: 'api',
					versions: [{ versionId: 'ver-1', percentage: 100 }],
				},
			],
		});
	});

	it('authenticates with a bearer header and never puts the token in a URL', async () => {
		const { fetchImpl, calls } = fakeFetch(liveRoutes());

		await fetchLiveWorker({ accountId: ACCOUNT, workerName: WORKER, token: TOKEN, fetchImpl });

		expect(calls.length).toBeGreaterThan(0);
		for (const { url, init } of calls) {
			expect(url).not.toContain(TOKEN);
			expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
		}
	});

	it('reports a Worker that does not exist, without further requests', async () => {
		const missing = `${BASE}/workers/services/${WORKER}/environments/production`;
		const { fetchImpl, calls } = fakeFetch({
			[missing]: { status: 404, body: { success: false, errors: [{ code: 10090, message: 'not found' }] } },
		});

		const live = await fetchLiveWorker({ accountId: ACCOUNT, workerName: WORKER, token: TOKEN, fetchImpl });

		expect(live).toEqual({ exists: false, migrationTag: null, bindings: [], secretNames: [], deployments: [] });
		expect(calls).toHaveLength(1);
	});

	it('treats an absent migration tag as null', async () => {
		const routes = liveRoutes();
		routes[`${BASE}/workers/services/${WORKER}/environments/production`] = ok({ script: {} });
		const { fetchImpl } = fakeFetch(routes);

		const live = await fetchLiveWorker({ accountId: ACCOUNT, workerName: WORKER, token: TOKEN, fetchImpl });

		expect(live.migrationTag).toBeNull();
	});

	it('fails with the status and message of an API error, never the token', async () => {
		const routes = liveRoutes();
		routes[`${BASE}/workers/scripts/${WORKER}/secrets`] = {
			status: 403,
			body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
		};
		const { fetchImpl } = fakeFetch(routes);

		const failure = await fetchLiveWorker({ accountId: ACCOUNT, workerName: WORKER, token: TOKEN, fetchImpl }).catch(
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(CloudflareApiError);
		expect((failure as CloudflareApiError).message).toContain('403');
		expect((failure as CloudflareApiError).message).toContain('Authentication error');
		expect((failure as CloudflareApiError).message).not.toContain(TOKEN);
	});

	it('names the request when the response has an unexpected shape', async () => {
		const routes = liveRoutes();
		routes[`${BASE}/workers/services/${WORKER}/environments/production/bindings`] = ok({ not: 'a list' });
		const { fetchImpl } = fakeFetch(routes);

		await expect(
			fetchLiveWorker({ accountId: ACCOUNT, workerName: WORKER, token: TOKEN, fetchImpl }),
		).rejects.toThrow(/bindings.*unexpected response/i);
	});

	it('sends requests to a custom base URL when one is given', async () => {
		const local = 'http://127.0.0.1:8787/client/v4';
		const { fetchImpl, calls } = fakeFetch({});

		await fetchLiveWorker({
			accountId: ACCOUNT,
			workerName: WORKER,
			token: TOKEN,
			baseUrl: local,
			fetchImpl,
		}).catch(() => undefined);

		expect(calls[0].url.startsWith(`${local}/accounts/${ACCOUNT}/`)).toBe(true);
	});

	it('encodes the Worker name in the path', async () => {
		const { fetchImpl, calls } = fakeFetch({});

		await fetchLiveWorker({ accountId: ACCOUNT, workerName: 'a/b', token: TOKEN, fetchImpl }).catch(() => undefined);

		expect(calls[0].url).toContain('/services/a%2Fb/');
	});
});

describe('fetchAppliedD1Migrations', () => {
	const DB_ID = 'db-uuid';
	const url = `${BASE}/d1/database/${DB_ID}/query`;

	it('returns the recorded migration names in order', async () => {
		const { fetchImpl, calls } = fakeFetch({
			[url]: ok([{ success: true, results: [{ name: '0000_a.sql' }, { name: '0001_b.sql' }] }]),
		});

		const names = await fetchAppliedD1Migrations({ accountId: ACCOUNT, databaseId: DB_ID, token: TOKEN, fetchImpl });

		expect(names).toEqual(['0000_a.sql', '0001_b.sql']);
		expect(calls[0].init?.method).toBe('POST');
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			sql: 'SELECT name FROM d1_migrations ORDER BY id',
		});
	});

	it('returns null when the database has no migrations table yet', async () => {
		const { fetchImpl } = fakeFetch({
			[url]: {
				status: 400,
				body: { success: false, errors: [{ code: 7500, message: 'no such table: d1_migrations: SQLITE_ERROR' }] },
			},
		});

		const names = await fetchAppliedD1Migrations({ accountId: ACCOUNT, databaseId: DB_ID, token: TOKEN, fetchImpl });

		expect(names).toBeNull();
	});

	it('fails on any other error', async () => {
		const { fetchImpl } = fakeFetch({
			[url]: { status: 500, body: { success: false, errors: [{ message: 'boom' }] } },
		});

		await expect(
			fetchAppliedD1Migrations({ accountId: ACCOUNT, databaseId: DB_ID, token: TOKEN, fetchImpl }),
		).rejects.toThrow(/500.*boom/);
	});
});

describe('createDeployment', () => {
	const url = `${BASE}/workers/scripts/${WORKER}/deployments`;
	const options = { accountId: ACCOUNT, workerName: WORKER, token: TOKEN, versionId: 'ver-1', message: 'rollback: smoke failed' };

	it('puts the version on 100% of traffic with the message as an annotation', async () => {
		const { fetchImpl, calls } = fakeFetch({ [url]: ok({ id: 'dep-9', versions: [] }) });

		const result = await createDeployment({ ...options, fetchImpl });

		expect(result).toEqual({ created: true });
		expect(calls[0].init?.method).toBe('POST');
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			strategy: 'percentage',
			versions: [{ version_id: 'ver-1', percentage: 100 }],
			annotations: { 'workers/message': 'rollback: smoke failed' },
		});
	});

	it('does not force the deployment by default', async () => {
		const { fetchImpl, calls } = fakeFetch({ [url]: ok({}) });

		await createDeployment({ ...options, fetchImpl });

		expect(calls[0].url).toBe(url);
	});

	it('adds the force flag only when asked', async () => {
		const { fetchImpl, calls } = fakeFetch({ [`${url}?force=true`]: ok({}) });

		await createDeployment({ ...options, force: true, fetchImpl });

		expect(calls[0].url).toBe(`${url}?force=true`);
	});

	it('refuses, naming the secrets, when they changed since the version was deployed', async () => {
		const { fetchImpl } = fakeFetch({
			[url]: {
				status: 400,
				body: {
					success: false,
					errors: [{ code: 10220, message: 'Cannot rollback. The following secrets have changed: JWT_SECRET, ANTHROPIC_API_KEY' }],
				},
			},
		});

		const result = await createDeployment({ ...options, fetchImpl });

		expect(result).toEqual({
			created: false,
			reason: 'secrets-changed',
			secrets: ['JWT_SECRET', 'ANTHROPIC_API_KEY'],
		});
	});

	it('still refuses when the secret names cannot be read from the message', async () => {
		const { fetchImpl } = fakeFetch({
			[url]: { status: 400, body: { success: false, errors: [{ code: 10220, message: 'unexpected wording' }] } },
		});

		expect(await createDeployment({ ...options, fetchImpl })).toEqual({
			created: false,
			reason: 'secrets-changed',
			secrets: [],
		});
	});

	it('throws on any other error', async () => {
		const { fetchImpl } = fakeFetch({
			[url]: { status: 500, body: { success: false, errors: [{ code: 1000, message: 'boom' }] } },
		});

		await expect(createDeployment({ ...options, fetchImpl })).rejects.toThrow(/HTTP 500: boom/);
	});

	it('shortens a long message to what the API accepts', async () => {
		const { fetchImpl, calls } = fakeFetch({ [url]: ok({}) });

		await createDeployment({ ...options, message: 'x'.repeat(250), fetchImpl });

		const sent = JSON.parse(String(calls[0].init?.body)).annotations['workers/message'] as string;
		expect(sent).toHaveLength(100);
	});
});
