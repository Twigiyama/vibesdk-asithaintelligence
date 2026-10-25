import { describe, expect, it } from 'vitest';
import {
	deployConfigSchema,
	parseWranglerConfig,
	verifyWranglerConfig,
	type DeployConfig,
	type WranglerConfig,
} from './verify-wrangler-config';

const expected: DeployConfig = deployConfigSchema.parse({
	workerName: 'vibesdk-production',
	forbiddenHostSuffixes: ['cloudflare.dev'],
	zoneIds: ['zone-1'],
	resources: {
		d1: { binding: 'DB', databaseName: 'vibesdk-db', databaseId: 'd1-id' },
		kv: [{ binding: 'VibecoderStore', id: 'kv-id' }],
		r2: [{ binding: 'TEMPLATES_BUCKET', bucketName: 'vibesdk-templates' }],
		dispatchNamespace: 'vibesdk-default-namespace',
		artifactsNamespace: 'vibesdk-production',
	},
});

const valid = (): WranglerConfig =>
	parseWranglerConfig({
		name: 'vibesdk-production',
		routes: [
			{ pattern: 'vibes.example.com', custom_domain: true },
			{ pattern: '*preview.example.com/*', custom_domain: false, zone_id: 'zone-1' },
		],
		vars: {
			CUSTOM_DOMAIN: 'vibes.example.com',
			MAX_SANDBOX_INSTANCES: '10',
			DISPATCH_NAMESPACE: 'vibesdk-default-namespace',
			ARTIFACTS_NAMESPACE: 'vibesdk-production',
			TEMPLATES_REPOSITORY: 'https://github.com/cloudflare/vibesdk-templates',
			PLATFORM_CAPABILITIES: { features: { app: { enabled: true } } },
		},
		d1_databases: [
			{ binding: 'DB', database_name: 'vibesdk-db', database_id: 'd1-id' },
		],
		kv_namespaces: [{ binding: 'VibecoderStore', id: 'kv-id' }],
		r2_buckets: [{ binding: 'TEMPLATES_BUCKET', bucket_name: 'vibesdk-templates' }],
		dispatch_namespaces: [
			{ binding: 'DISPATCHER', namespace: 'vibesdk-default-namespace' },
		],
		artifacts: [{ binding: 'ARTIFACTS', namespace: 'vibesdk-production' }],
		containers: [
			{
				class_name: 'UserAppSandboxService',
				image: 'registry.cloudflare.com/acct/vibesdk-production-userappsandboxservice:abc123',
				max_instances: 10,
			},
		],
		migrations: [{ tag: 'v1' }, { tag: 'v2' }, { tag: 'v3' }, { tag: 'v5' }, { tag: 'v6' }],
	});

const rules = (config: WranglerConfig, overrides: Partial<DeployConfig> = {}) =>
	verifyWranglerConfig(config, { ...expected, ...overrides }).map((f) => f.rule);

describe('parseWranglerConfig', () => {
	it('keeps unrelated keys and rejects wrongly typed ones', () => {
		expect(parseWranglerConfig({ name: 'a', compatibility_date: '2026-01-01' }).name).toBe('a');
		expect(() => parseWranglerConfig({ d1_databases: 'nope' })).toThrow();
	});

	it('accepts the string form of a route', () => {
		const config = parseWranglerConfig({ routes: ['example.com/*'] });

		expect(config.routes).toEqual(['example.com/*']);
	});
});

describe('deployConfigSchema', () => {
	it('defaults the forbidden host list to empty', () => {
		expect(deployConfigSchema.parse({ workerName: 'w' }).forbiddenHostSuffixes).toEqual([]);
	});

	it('rejects an empty worker name', () => {
		expect(() => deployConfigSchema.parse({ workerName: '' })).toThrow();
	});

	it('is advisory unless enforcement is switched on', () => {
		expect(deployConfigSchema.parse({ workerName: 'w' }).enforce).toBe(false);
		expect(deployConfigSchema.parse({ workerName: 'w', enforce: true }).enforce).toBe(true);
	});
});

describe('verifyWranglerConfig', () => {
	it('accepts a correctly re-homed configuration', () => {
		expect(verifyWranglerConfig(valid(), expected)).toEqual([]);
	});

	it('reports every upstream value in a configuration copied from the template', () => {
		const upstream = parseWranglerConfig({
			name: 'vibesdk-production',
			routes: [
				{ pattern: 'build.cloudflare.dev', custom_domain: true },
				{ pattern: '*build-preview.cloudflare.dev/*', custom_domain: false, zone_id: 'db01fac4' },
			],
			vars: {
				CUSTOM_DOMAIN: 'attest',
				MAX_SANDBOX_INSTANCES: '10',
				DISPATCH_NAMESPACE: 'vibesdk-default-namespace',
			},
			containers: [{ class_name: 'S', image: './SandboxDockerfile', max_instances: 1400 }],
			d1_databases: [
				{ binding: 'DB', database_name: 'vibesdk-db', database_id: 'e1a508b4' },
			],
		});

		const found = new Set(rules(upstream));

		expect(found).toEqual(
			new Set([
				'foreign-host',
				'custom-domain',
				'zone-id',
				'resource-id',
				'container-image',
				'container-instances',
			]),
		);
	});

	describe('worker-name', () => {
		it('flags a different worker name', () => {
			const config = { ...valid(), name: 'vibesdk-staging' };

			expect(rules(config)).toEqual(['worker-name']);
		});

		it('flags a missing worker name', () => {
			const { name: _name, ...rest } = valid();

			expect(rules(rest)).toEqual(['worker-name']);
		});
	});

	describe('foreign-host', () => {
		it('flags a forbidden suffix in a route pattern', () => {
			const config = {
				...valid(),
				routes: [{ pattern: 'app.cloudflare.dev', custom_domain: true }],
			};

			expect(rules(config)).toContain('foreign-host');
		});

		it('flags the singular route key, which wrangler also accepts', () => {
			const config = { ...valid(), route: 'build.cloudflare.dev/*' };

			const found = verifyWranglerConfig(config, expected).find((f) => f.rule === 'foreign-host');

			expect(found?.message).toContain('route');
		});

		it('flags a forbidden suffix inside a named environment', () => {
			const config = {
				...valid(),
				env: { production: { routes: [{ pattern: 'app.cloudflare.dev', custom_domain: true }] } },
			};

			const found = verifyWranglerConfig(config, expected).find((f) => f.rule === 'foreign-host');

			expect(found?.message).toContain('env.production.routes[0].pattern');
		});

		it('flags a forbidden suffix in a string route', () => {
			expect(rules({ ...valid(), routes: ['*.cloudflare.dev/*'] })).toContain('foreign-host');
		});

		it('flags a forbidden suffix in any var, including nested values', () => {
			const config = valid();
			config.vars = { ...config.vars, NESTED: { url: 'https://x.build.cloudflare.dev/path' } };

			const [finding] = verifyWranglerConfig(config, expected);

			expect(finding.rule).toBe('foreign-host');
			expect(finding.message).toContain('vars.NESTED.url');
		});

		it('does not flag a longer name that merely ends the same way', () => {
			const config = valid();
			config.vars = { ...config.vars, OTHER: 'notcloudflare.dev' };

			expect(rules(config)).toEqual([]);
		});

		it('does not flag github.com/cloudflare repositories', () => {
			expect(rules(valid())).toEqual([]);
		});

		it('is skipped when no suffix is forbidden', () => {
			const config = {
				...valid(),
				routes: [{ pattern: 'app.cloudflare.dev', custom_domain: true }],
			};

			expect(rules(config, { forbiddenHostSuffixes: [] })).toEqual([]);
		});
	});

	describe('custom-domain', () => {
		it.each(['attest', 'localhost:5173', 'https://vibes.example.com', 'Vibes.Example.com', '*.example.com', 'a..com', ''])(
			'rejects %j',
			(value) => {
				const config = valid();
				config.vars = { ...config.vars, CUSTOM_DOMAIN: value };

				expect(rules(config)).toContain('custom-domain');
			},
		);

		it('rejects a missing CUSTOM_DOMAIN', () => {
			const config = valid();
			const { CUSTOM_DOMAIN: _domain, ...vars } = config.vars ?? {};
			config.vars = vars;

			expect(rules(config)).toContain('custom-domain');
		});

		it.each(['vibes.example.com', 'a.b.example.co.uk', 'xn--bcher-kva.example'])(
			'accepts %j',
			(value) => {
				const config = valid();
				config.vars = { ...config.vars, CUSTOM_DOMAIN: value };

				expect(rules(config)).not.toContain('custom-domain');
			},
		);
	});

	describe('zone-id', () => {
		it('flags a route zone that is not in the allow-list', () => {
			const config = valid();
			config.routes = [{ pattern: '*p.example.com/*', custom_domain: false, zone_id: 'other-zone' }];

			expect(rules(config)).toEqual(['zone-id']);
		});

		it('is skipped when no zones are declared', () => {
			const config = valid();
			config.routes = [{ pattern: '*p.example.com/*', custom_domain: false, zone_id: 'other-zone' }];

			expect(rules(config, { zoneIds: undefined })).toEqual([]);
		});
	});

	describe('resource-id', () => {
		it('flags a different D1 database id', () => {
			const config = valid();
			config.d1_databases = [{ binding: 'DB', database_name: 'vibesdk-db', database_id: 'upstream' }];

			expect(rules(config)).toEqual(['resource-id']);
		});

		it('flags a missing D1 binding', () => {
			expect(rules({ ...valid(), d1_databases: [] })).toEqual(['resource-id']);
		});

		it('flags a different KV namespace id', () => {
			const config = valid();
			config.kv_namespaces = [{ binding: 'VibecoderStore', id: 'upstream' }];

			expect(rules(config)).toEqual(['resource-id']);
		});

		it('flags a different R2 bucket', () => {
			const config = valid();
			config.r2_buckets = [{ binding: 'TEMPLATES_BUCKET', bucket_name: 'other' }];

			expect(rules(config)).toEqual(['resource-id']);
		});

		it('flags a different dispatch namespace', () => {
			const config = valid();
			config.dispatch_namespaces = [{ binding: 'DISPATCHER', namespace: 'upstream' }];

			expect(rules(config)).toContain('resource-id');
		});

		it('flags a different Artifacts namespace', () => {
			const config = valid();
			config.artifacts = [{ binding: 'ARTIFACTS', namespace: 'upstream' }];

			expect(rules(config)).toContain('resource-id');
		});

		it('flags an Artifacts binding when the live Worker has none', () => {
			const resources = { ...expected.resources, artifactsNamespace: null };

			expect(rules(valid(), { resources })).toEqual(['resource-id']);
		});

		it('flags a missing Artifacts binding when one is expected', () => {
			const { artifacts: _artifacts, ...rest } = valid();

			expect(rules(rest)).toEqual(['resource-id']);
		});

		it('skips values the deploy config does not declare', () => {
			const resources = { d1: { binding: 'DB' } };

			expect(rules(valid(), { resources })).toEqual([]);
		});
	});

	describe('resource-consistency', () => {
		it('flags a DISPATCH_NAMESPACE var that differs from the binding', () => {
			const config = valid();
			config.vars = { ...config.vars, DISPATCH_NAMESPACE: 'other' };

			expect(rules(config)).toEqual(['resource-consistency']);
		});

		it('flags an ARTIFACTS_NAMESPACE var that differs from the binding', () => {
			const config = valid();
			config.vars = { ...config.vars, ARTIFACTS_NAMESPACE: 'other' };

			expect(rules(config)).toEqual(['resource-consistency']);
		});
	});

	describe('container-image', () => {
		it('flags a Dockerfile path, which would make every CI run build an image', () => {
			const config = valid();
			config.containers = [{ class_name: 'S', image: './SandboxDockerfile', max_instances: 10 }];

			expect(rules(config)).toEqual(['container-image']);
		});

		it('flags a missing image', () => {
			const config = valid();
			config.containers = [{ class_name: 'S', max_instances: 10 }];

			expect(rules(config)).toEqual(['container-image']);
		});

		it('does not require containers to exist', () => {
			const { containers: _containers, ...rest } = valid();

			expect(rules(rest)).toEqual([]);
		});
	});

	describe('container-instances', () => {
		it('flags max_instances above MAX_SANDBOX_INSTANCES', () => {
			const config = valid();
			config.containers = [
				{ class_name: 'S', image: 'registry.cloudflare.com/a/b:c', max_instances: 1400 },
			];

			expect(rules(config)).toEqual(['container-instances']);
		});

		it('accepts max_instances equal to MAX_SANDBOX_INSTANCES', () => {
			expect(rules(valid())).toEqual([]);
		});

		it.each(['', 'ten', '-1', '1.5', '0'])(
			'flags MAX_SANDBOX_INSTANCES=%j when containers are configured',
			(value) => {
				const config = valid();
				config.vars = { ...config.vars, MAX_SANDBOX_INSTANCES: value };

				expect(rules(config)).toEqual(['container-instances']);
			},
		);
	});

	describe('migration-tags', () => {
		it('accepts ascending tags that skip numbers', () => {
			expect(rules(valid())).toEqual([]);
		});

		it('flags a tag that is lower than its predecessor', () => {
			const config = { ...valid(), migrations: [{ tag: 'v1' }, { tag: 'v3' }, { tag: 'v2' }] };

			const [finding] = verifyWranglerConfig(config, expected);

			expect(finding.rule).toBe('migration-tags');
			expect(finding.message).toContain('v2');
		});

		it('flags a duplicate tag', () => {
			const config = { ...valid(), migrations: [{ tag: 'v1' }, { tag: 'v1' }] };

			expect(rules(config)).toEqual(['migration-tags']);
		});

		it('flags a tag that is not v<number>', () => {
			const config = { ...valid(), migrations: [{ tag: 'v1' }, { tag: 'second' }] };

			expect(rules(config)).toEqual(['migration-tags']);
		});

		it('orders by number, not by string', () => {
			const config = { ...valid(), migrations: [{ tag: 'v9' }, { tag: 'v10' }] };

			expect(rules(config)).toEqual([]);
		});
	});
});
