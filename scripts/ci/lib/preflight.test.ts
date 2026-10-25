import { describe, expect, it } from 'vitest';
import {
	activeDeployment,
	committedVarNames,
	compareBindings,
	compareD1Migrations,
	compareMigrationTag,
	compareSecrets,
	expectedBindings,
	isRollbackDeployment,
	servingVersionId,
	type LiveBinding,
	type LiveDeployment,
} from './preflight';
import { parseWranglerConfig } from './verify-wrangler-config';

const config = parseWranglerConfig({
	name: 'vibesdk-production',
	vars: { CUSTOM_DOMAIN: 'vibes.example.com', MAX_SANDBOX_INSTANCES: '10' },
	kv_namespaces: [{ binding: 'VibecoderStore', id: 'kv-id' }],
	d1_databases: [{ binding: 'DB', database_name: 'vibesdk-db', database_id: 'd1-id' }],
	r2_buckets: [{ binding: 'TEMPLATES_BUCKET', bucket_name: 'vibesdk-templates' }],
	durable_objects: {
		bindings: [
			{ name: 'CodeGenObject', class_name: 'CodeGeneratorAgent' },
			{ name: 'THINK_DO', class_name: 'ThinkAgent' },
		],
	},
	dispatch_namespaces: [{ binding: 'DISPATCHER', namespace: 'vibesdk-default-namespace' }],
	artifacts: [{ binding: 'ARTIFACTS', namespace: 'vibesdk-production' }],
	ai: { binding: 'AI' },
	browser: { binding: 'BROWSER' },
	assets: { binding: 'ASSETS' },
	version_metadata: { binding: 'CF_VERSION_METADATA' },
	worker_loaders: [{ binding: 'LOADER' }],
	unsafe: { bindings: [{ name: 'API_RATE_LIMITER', type: 'ratelimit' }] },
	migrations: [{ tag: 'v1' }, { tag: 'v2' }, { tag: 'v3' }],
});

const liveBindings = (): LiveBinding[] => [
	{ name: 'VibecoderStore', type: 'kv_namespace', namespace_id: 'kv-id' },
	{ name: 'DB', type: 'd1', id: 'd1-id' },
	{ name: 'TEMPLATES_BUCKET', type: 'r2_bucket', bucket_name: 'vibesdk-templates' },
	{ name: 'CodeGenObject', type: 'durable_object_namespace', class_name: 'CodeGeneratorAgent' },
	{ name: 'THINK_DO', type: 'durable_object_namespace', class_name: 'ThinkAgent' },
	{ name: 'DISPATCHER', type: 'dispatch_namespace', namespace: 'vibesdk-default-namespace' },
	{ name: 'ARTIFACTS', type: 'artifacts' },
	{ name: 'AI', type: 'ai' },
	{ name: 'BROWSER', type: 'browser' },
	{ name: 'ASSETS', type: 'assets' },
	{ name: 'CF_VERSION_METADATA', type: 'version_metadata' },
	{ name: 'LOADER', type: 'worker_loader' },
	{ name: 'API_RATE_LIMITER', type: 'ratelimit' },
	{ name: 'CUSTOM_DOMAIN', type: 'plain_text', text: 'vibes.example.com' },
	{ name: 'JWT_SECRET', type: 'secret_text' },
	{ name: 'ENABLE_ARTIFACTS', type: 'plain_text', text: 'true' },
];

const summarize = (findings: ReturnType<typeof compareBindings>) =>
	findings.map((f) => `${f.severity}:${f.rule}`);

describe('expectedBindings', () => {
	it('lists every resource binding of the config with its identity', () => {
		const expected = expectedBindings(config);

		expect(expected).toContainEqual({ name: 'DB', type: 'd1', identity: { key: 'id', value: 'd1-id' } });
		expect(expected).toContainEqual({
			name: 'VibecoderStore',
			type: 'kv_namespace',
			identity: { key: 'namespace_id', value: 'kv-id' },
		});
		expect(expected).toContainEqual({
			name: 'TEMPLATES_BUCKET',
			type: 'r2_bucket',
			identity: { key: 'bucket_name', value: 'vibesdk-templates' },
		});
		expect(expected).toContainEqual({
			name: 'THINK_DO',
			type: 'durable_object_namespace',
			identity: { key: 'class_name', value: 'ThinkAgent' },
		});
		expect(expected).toContainEqual({
			name: 'DISPATCHER',
			type: 'dispatch_namespace',
			identity: { key: 'namespace', value: 'vibesdk-default-namespace' },
		});
	});

	it('lists simple bindings by name and type', () => {
		const expected = expectedBindings(config);

		for (const [name, type] of [
			['AI', 'ai'],
			['BROWSER', 'browser'],
			['ASSETS', 'assets'],
			['CF_VERSION_METADATA', 'version_metadata'],
		] as const) {
			expect(expected).toContainEqual({ name, type });
		}
	});

	it('lists bindings whose live type is not known by name only', () => {
		const expected = expectedBindings(config);

		expect(expected).toContainEqual({ name: 'ARTIFACTS' });
		expect(expected).toContainEqual({ name: 'API_RATE_LIMITER' });
		expect(expected).toContainEqual({ name: 'LOADER' });
	});

	it('does not list vars, which are not resource bindings', () => {
		expect(expectedBindings(config).map((b) => b.name)).not.toContain('CUSTOM_DOMAIN');
	});
});

describe('committedVarNames', () => {
	it('returns the names of the vars', () => {
		expect(committedVarNames(config)).toEqual(['CUSTOM_DOMAIN', 'MAX_SANDBOX_INSTANCES']);
	});

	it('returns nothing when there are no vars', () => {
		expect(committedVarNames(parseWranglerConfig({ name: 'x' }))).toEqual([]);
	});
});

describe('compareBindings', () => {
	it('reports nothing when live matches, ignoring secrets and dashboard vars', () => {
		expect(compareBindings(config, liveBindings())).toEqual([]);
	});

	it('flags a binding that points at a different resource', () => {
		const live = liveBindings().map((b) => (b.name === 'DB' ? { ...b, id: 'someone-elses-db' } : b));

		expect(compareBindings(config, live)).toEqual([
			{
				severity: 'error',
				rule: 'binding-drift',
				message: expect.stringContaining('DB'),
			},
		]);
	});

	it('names both the live and the committed value in a drift message', () => {
		const live = liveBindings().map((b) => (b.name === 'DB' ? { ...b, id: 'live-id' } : b));

		const [finding] = compareBindings(config, live);

		expect(finding.message).toContain('live-id');
		expect(finding.message).toContain('d1-id');
	});

	it('flags a binding whose type changed', () => {
		const live = liveBindings().map((b) => (b.name === 'AI' ? { name: 'AI', type: 'plain_text' } : b));

		expect(summarize(compareBindings(config, live))).toEqual(['error:binding-drift']);
	});

	it('flags a live resource binding the config would remove', () => {
		const live = [...liveBindings(), { name: 'LEGACY_KV', type: 'kv_namespace', namespace_id: 'x' }];

		expect(compareBindings(config, live)).toEqual([
			{
				severity: 'error',
				rule: 'binding-removed',
				message: expect.stringContaining('LEGACY_KV'),
			},
		]);
	});

	it('reports a new committed binding as information', () => {
		const live = liveBindings().filter((b) => b.name !== 'LOADER');

		expect(compareBindings(config, live)).toEqual([
			{ severity: 'info', rule: 'binding-new', message: expect.stringContaining('LOADER') },
		]);
	});

	it('does not compare identity for bindings the live type is not known for', () => {
		const live = liveBindings().map((b) => (b.name === 'ARTIFACTS' ? { name: 'ARTIFACTS', type: 'whatever', namespace: 'z' } : b));

		expect(compareBindings(config, live)).toEqual([]);
	});

	it('treats a live binding without the identity field as drift', () => {
		const live = liveBindings().map((b) => (b.name === 'DB' ? { name: 'DB', type: 'd1' } : b));

		expect(summarize(compareBindings(config, live))).toEqual(['error:binding-drift']);
	});
});

describe('compareSecrets', () => {
	it('flags a live secret that shares a name with a committed var', () => {
		expect(compareSecrets(config, ['JWT_SECRET', 'CUSTOM_DOMAIN'])).toEqual([
			{
				severity: 'error',
				rule: 'secret-collision',
				message: expect.stringContaining('CUSTOM_DOMAIN'),
			},
		]);
	});

	it('is quiet when secrets and vars are disjoint', () => {
		expect(compareSecrets(config, ['JWT_SECRET', 'ANTHROPIC_API_KEY'])).toEqual([]);
	});
});

describe('compareMigrationTag', () => {
	it('is quiet when the live tag is the latest committed one', () => {
		expect(compareMigrationTag(config, 'v3')).toEqual({ findings: [], pendingTags: [] });
	});

	it('reports tags this release will apply as a warning', () => {
		const result = compareMigrationTag(config, 'v1');

		expect(result.pendingTags).toEqual(['v2', 'v3']);
		expect(result.findings).toEqual([
			{ severity: 'warning', rule: 'do-migration-pending', message: expect.stringContaining('v2, v3') },
		]);
	});

	it('flags a live tag the config does not know, which would replay migrations', () => {
		const result = compareMigrationTag(config, 'v9');

		expect(result.findings).toEqual([
			{ severity: 'error', rule: 'migration-tag', message: expect.stringContaining('v9') },
		]);
		expect(result.pendingTags).toEqual([]);
	});

	it('treats a Worker with no migration tag as needing every migration', () => {
		const result = compareMigrationTag(config, null);

		expect(result.pendingTags).toEqual(['v1', 'v2', 'v3']);
		expect(result.findings[0]).toMatchObject({ severity: 'warning', rule: 'do-migration-pending' });
	});

	it('is quiet when the config has no migrations and the Worker has no tag', () => {
		expect(compareMigrationTag(parseWranglerConfig({ name: 'x' }), null)).toEqual({
			findings: [],
			pendingTags: [],
		});
	});
});

describe('compareD1Migrations', () => {
	const repo = ['0000_a.sql', '0001_b.sql', '0002_c.sql'];

	it('lists migrations the database has not applied', () => {
		const result = compareD1Migrations(repo, ['0000_a.sql', '0001_b.sql']);

		expect(result.pending).toEqual(['0002_c.sql']);
		expect(result.findings).toEqual([
			{ severity: 'info', rule: 'd1-migrations', message: expect.stringContaining('0002_c.sql') },
		]);
	});

	it('is quiet when everything is applied', () => {
		expect(compareD1Migrations(repo, [...repo])).toEqual({ findings: [], pending: [] });
	});

	it('flags migrations the database recorded that the repository lacks', () => {
		const result = compareD1Migrations(repo, [...repo, '0003_generated_at_deploy.sql']);

		expect(result.findings).toEqual([
			{
				severity: 'error',
				rule: 'd1-migrations',
				message: expect.stringContaining('0003_generated_at_deploy.sql'),
			},
		]);
	});

	it('treats a missing migrations table as nothing applied', () => {
		expect(compareD1Migrations(repo, null).pending).toEqual(repo);
	});
});

describe('deployments', () => {
	const deployment = (overrides: Partial<LiveDeployment> = {}): LiveDeployment => ({
		id: 'dep-1',
		createdOn: '2026-10-25T10:00:00Z',
		versions: [{ versionId: 'ver-1', percentage: 100 }],
		...overrides,
	});

	it('takes the first deployment as the active one', () => {
		const deployments = [deployment({ id: 'newest' }), deployment({ id: 'older' })];

		expect(activeDeployment(deployments)?.id).toBe('newest');
	});

	it('returns undefined when the Worker has never been deployed', () => {
		expect(activeDeployment([])).toBeUndefined();
	});

	it('picks the version serving the most traffic as the one to return to', () => {
		const split = deployment({
			versions: [
				{ versionId: 'canary', percentage: 10 },
				{ versionId: 'stable', percentage: 90 },
			],
		});

		expect(servingVersionId(split)).toBe('stable');
		expect(servingVersionId(deployment())).toBe('ver-1');
	});

	it('has no version to return to without a deployment', () => {
		expect(servingVersionId(undefined)).toBeUndefined();
		expect(servingVersionId(deployment({ versions: [] }))).toBeUndefined();
	});

	it('recognizes a rollback by its trigger annotation', () => {
		expect(isRollbackDeployment(deployment({ triggeredBy: 'rollback' }))).toBe(true);
		expect(isRollbackDeployment(deployment({ triggeredBy: 'upload' }))).toBe(false);
		expect(isRollbackDeployment(deployment({ triggeredBy: 'secret' }))).toBe(false);
		expect(isRollbackDeployment(deployment())).toBe(false);
	});
});
