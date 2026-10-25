/**
 * Static guard for the Wrangler configuration that ships.
 *
 * The committed wrangler.jsonc started life as Cloudflare's own template, so a
 * careless upstream merge could reintroduce foreign hostnames, resource ids or
 * a container build that CI must never run. These rules compare the config
 * (and the generated dist/<worker>/wrangler.json, which is what actually
 * deploys) against the production identity declared in .github/deploy.config.json.
 */
import { z } from 'zod';

const registryImagePrefix = 'registry.cloudflare.com/';

const fqdn =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

const routeSchema = z.union([
	z.string(),
	z.looseObject({
		pattern: z.string(),
		custom_domain: z.boolean().optional(),
		zone_id: z.string().optional(),
		zone_name: z.string().optional(),
	}),
]);

const wranglerConfigSchema = z.looseObject({
	name: z.string().optional(),
	routes: z.array(routeSchema).optional(),
	vars: z.record(z.string(), z.unknown()).optional(),
	d1_databases: z
		.array(
			z.looseObject({
				binding: z.string(),
				database_name: z.string().optional(),
				database_id: z.string().optional(),
			}),
		)
		.optional(),
	kv_namespaces: z
		.array(z.looseObject({ binding: z.string(), id: z.string().optional() }))
		.optional(),
	r2_buckets: z
		.array(
			z.looseObject({ binding: z.string(), bucket_name: z.string().optional() }),
		)
		.optional(),
	dispatch_namespaces: z
		.array(z.looseObject({ binding: z.string(), namespace: z.string() }))
		.optional(),
	artifacts: z
		.array(z.looseObject({ binding: z.string(), namespace: z.string() }))
		.optional(),
	containers: z
		.array(
			z.looseObject({
				class_name: z.string(),
				image: z.string().optional(),
				max_instances: z.number().optional(),
			}),
		)
		.optional(),
	migrations: z.array(z.looseObject({ tag: z.string() })).optional(),
	durable_objects: z
		.looseObject({
			bindings: z
				.array(z.looseObject({ name: z.string(), class_name: z.string() }))
				.optional(),
		})
		.optional(),
	ai: z.looseObject({ binding: z.string() }).optional(),
	browser: z.looseObject({ binding: z.string() }).optional(),
	assets: z.looseObject({ binding: z.string().optional() }).optional(),
	version_metadata: z.looseObject({ binding: z.string() }).optional(),
	worker_loaders: z.array(z.looseObject({ binding: z.string() })).optional(),
	unsafe: z
		.looseObject({
			bindings: z
				.array(z.looseObject({ name: z.string(), type: z.string() }))
				.optional(),
		})
		.optional(),
});

export const deployConfigSchema = z.looseObject({
	workerName: z.string().min(1),
	/**
	 * When false, pull request CI reports findings as warnings instead of
	 * failing. Switch it on once the config is re-homed; deploys always enforce.
	 */
	enforce: z.boolean().default(false),
	forbiddenHostSuffixes: z.array(z.string().min(1)).default([]),
	zoneIds: z.array(z.string().min(1)).optional(),
	resources: z
		.looseObject({
			d1: z
				.looseObject({
					binding: z.string(),
					databaseName: z.string().optional(),
					databaseId: z.string().optional(),
				})
				.optional(),
			kv: z
				.array(z.looseObject({ binding: z.string(), id: z.string().optional() }))
				.optional(),
			r2: z
				.array(
					z.looseObject({
						binding: z.string(),
						bucketName: z.string().optional(),
					}),
				)
				.optional(),
			dispatchNamespace: z.string().optional(),
			/** A string pins the namespace; null requires that no binding exists. */
			artifactsNamespace: z.string().nullable().optional(),
		})
		.optional(),
});

export type WranglerConfig = z.infer<typeof wranglerConfigSchema>;
export type DeployConfig = z.infer<typeof deployConfigSchema>;

export type ConfigRule =
	| 'worker-name'
	| 'foreign-host'
	| 'custom-domain'
	| 'zone-id'
	| 'resource-id'
	| 'resource-consistency'
	| 'container-image'
	| 'container-instances'
	| 'migration-tags';

export interface ConfigFinding {
	rule: ConfigRule;
	message: string;
}

export function parseWranglerConfig(raw: unknown): WranglerConfig {
	return wranglerConfigSchema.parse(raw);
}

const finding = (rule: ConfigRule, message: string): ConfigFinding => ({
	rule,
	message,
});

function* walkStrings(
	value: unknown,
	path: string,
): Generator<{ path: string; value: string }> {
	if (typeof value === 'string') {
		yield { path, value };
	} else if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			yield* walkStrings(item, `${path}[${index}]`);
		}
	} else if (typeof value === 'object' && value !== null) {
		for (const [key, item] of Object.entries(value)) {
			yield* walkStrings(item, path === '' ? key : `${path}.${key}`);
		}
	}
}

function hostPattern(suffix: string): RegExp {
	const escaped = suffix.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(^|[^a-z0-9-])${escaped}($|[^a-z0-9-])`);
}

function checkWorkerName(config: WranglerConfig, expected: DeployConfig) {
	if (config.name === expected.workerName) return [];
	return [
		finding(
			'worker-name',
			`Worker name is ${config.name ?? 'unset'}, expected ${expected.workerName}.`,
		),
	];
}

function checkForeignHosts(config: WranglerConfig, expected: DeployConfig) {
	const patterns = expected.forbiddenHostSuffixes.map((suffix) => ({
		suffix,
		regex: hostPattern(suffix),
	}));
	if (patterns.length === 0) return [];

	// Every string in the config: besides routes and vars, wrangler accepts a
	// singular `route` and per-environment copies of both under `env`.
	return [...walkStrings(config, '')].flatMap(({ path, value }) =>
		patterns
			.filter(({ regex }) => regex.test(value.toLowerCase()))
			.map(({ suffix }) =>
				finding(
					'foreign-host',
					`${path} references ${suffix} (${value}), which belongs to the upstream template, not this deployment.`,
				),
			),
	);
}

function checkCustomDomain(config: WranglerConfig) {
	const domain = config.vars?.CUSTOM_DOMAIN;
	if (typeof domain === 'string' && fqdn.test(domain)) return [];
	return [
		finding(
			'custom-domain',
			`vars.CUSTOM_DOMAIN must be a lowercase fully qualified domain name without scheme, port or wildcard (got ${JSON.stringify(domain ?? null)}).`,
		),
	];
}

function checkZoneIds(config: WranglerConfig, expected: DeployConfig) {
	const allowed = expected.zoneIds;
	if (!allowed || allowed.length === 0) return [];

	return (config.routes ?? []).flatMap((route) => {
		if (typeof route === 'string' || route.zone_id === undefined) return [];
		if (allowed.includes(route.zone_id)) return [];
		return [
			finding(
				'zone-id',
				`Route ${route.pattern} uses zone_id ${route.zone_id}, which is not one of the declared zones.`,
			),
		];
	});
}

function checkResources(config: WranglerConfig, expected: DeployConfig) {
	const resources = expected.resources;
	if (!resources) return [];
	const findings: ConfigFinding[] = [];
	const mismatch = (message: string) =>
		findings.push(finding('resource-id', message));

	const { d1 } = resources;
	if (d1) {
		const actual = config.d1_databases?.find((b) => b.binding === d1.binding);
		if (!actual) {
			mismatch(`D1 binding ${d1.binding} is not configured.`);
		} else {
			if (d1.databaseId !== undefined && actual.database_id !== d1.databaseId) {
				mismatch(
					`D1 ${d1.binding} database_id is ${actual.database_id ?? 'unset'}, expected ${d1.databaseId}.`,
				);
			}
			if (
				d1.databaseName !== undefined &&
				actual.database_name !== d1.databaseName
			) {
				mismatch(
					`D1 ${d1.binding} database_name is ${actual.database_name ?? 'unset'}, expected ${d1.databaseName}.`,
				);
			}
		}
	}

	for (const kv of resources.kv ?? []) {
		const actual = config.kv_namespaces?.find((b) => b.binding === kv.binding);
		if (!actual) {
			mismatch(`KV binding ${kv.binding} is not configured.`);
		} else if (kv.id !== undefined && actual.id !== kv.id) {
			mismatch(`KV ${kv.binding} id is ${actual.id ?? 'unset'}, expected ${kv.id}.`);
		}
	}

	for (const r2 of resources.r2 ?? []) {
		const actual = config.r2_buckets?.find((b) => b.binding === r2.binding);
		if (!actual) {
			mismatch(`R2 binding ${r2.binding} is not configured.`);
		} else if (r2.bucketName !== undefined && actual.bucket_name !== r2.bucketName) {
			mismatch(
				`R2 ${r2.binding} bucket_name is ${actual.bucket_name ?? 'unset'}, expected ${r2.bucketName}.`,
			);
		}
	}

	if (resources.dispatchNamespace !== undefined) {
		const bindings = config.dispatch_namespaces ?? [];
		if (bindings.length === 0) {
			mismatch('No dispatch namespace binding is configured.');
		}
		for (const binding of bindings) {
			if (binding.namespace !== resources.dispatchNamespace) {
				mismatch(
					`Dispatch namespace ${binding.binding} is ${binding.namespace}, expected ${resources.dispatchNamespace}.`,
				);
			}
		}
	}

	if (resources.artifactsNamespace === null) {
		if ((config.artifacts ?? []).length > 0) {
			mismatch(
				'An Artifacts binding is configured, but the live Worker has none; the upload would be rejected.',
			);
		}
	} else if (resources.artifactsNamespace !== undefined) {
		const bindings = config.artifacts ?? [];
		if (bindings.length === 0) {
			mismatch('No Artifacts binding is configured.');
		}
		for (const binding of bindings) {
			if (binding.namespace !== resources.artifactsNamespace) {
				mismatch(
					`Artifacts ${binding.binding} namespace is ${binding.namespace}, expected ${resources.artifactsNamespace}.`,
				);
			}
		}
	}

	return findings;
}

function checkNamespaceConsistency(config: WranglerConfig) {
	const findings: ConfigFinding[] = [];
	const pairs: Array<{
		name: string;
		varName: string;
		bindings: ReadonlyArray<{ binding: string; namespace: string }>;
	}> = [
		{
			name: 'dispatch namespace',
			varName: 'DISPATCH_NAMESPACE',
			bindings: config.dispatch_namespaces ?? [],
		},
		{
			name: 'Artifacts namespace',
			varName: 'ARTIFACTS_NAMESPACE',
			bindings: config.artifacts ?? [],
		},
	];

	for (const { name, varName, bindings } of pairs) {
		const value = config.vars?.[varName];
		if (typeof value !== 'string') continue;
		for (const binding of bindings) {
			if (binding.namespace !== value) {
				findings.push(
					finding(
						'resource-consistency',
						`vars.${varName} (${value}) differs from the ${name} of binding ${binding.binding} (${binding.namespace}).`,
					),
				);
			}
		}
	}

	return findings;
}

function checkContainers(config: WranglerConfig) {
	const containers = config.containers ?? [];
	if (containers.length === 0) return [];

	const findings: ConfigFinding[] = [];

	for (const [index, container] of containers.entries()) {
		if (!container.image?.startsWith(registryImagePrefix)) {
			findings.push(
				finding(
					'container-image',
					`containers[${index}] (${container.class_name}) image must be a ${registryImagePrefix} reference so deploys never build an image (got ${JSON.stringify(container.image ?? null)}).`,
				),
			);
		}
	}

	const rawLimit = config.vars?.MAX_SANDBOX_INSTANCES;
	if (!/^[1-9]\d*$/.test(String(rawLimit ?? ''))) {
		findings.push(
			finding(
				'container-instances',
				`vars.MAX_SANDBOX_INSTANCES must be a positive integer to bound containers[].max_instances (got ${JSON.stringify(rawLimit ?? null)}).`,
			),
		);
		return findings;
	}

	const limit = Number(rawLimit);
	for (const [index, container] of containers.entries()) {
		if (container.max_instances !== undefined && container.max_instances > limit) {
			findings.push(
				finding(
					'container-instances',
					`containers[${index}].max_instances is ${container.max_instances}, above MAX_SANDBOX_INSTANCES (${limit}).`,
				),
			);
		}
	}

	return findings;
}

function checkMigrationTags(config: WranglerConfig) {
	const findings: ConfigFinding[] = [];
	let previous: { tag: string; number: number } | undefined;

	for (const { tag } of config.migrations ?? []) {
		const match = /^v(\d+)$/.exec(tag);
		if (!match) {
			findings.push(
				finding('migration-tags', `Migration tag ${JSON.stringify(tag)} must look like v<number>.`),
			);
			continue;
		}

		const number = Number(match[1]);
		if (previous && number <= previous.number) {
			findings.push(
				finding(
					'migration-tags',
					`Migration tag ${tag} must be greater than the preceding ${previous.tag}; Durable Object migrations are append-only.`,
				),
			);
		}
		previous = { tag, number };
	}

	return findings;
}

export function verifyWranglerConfig(
	config: WranglerConfig,
	expected: DeployConfig,
): ConfigFinding[] {
	return [
		...checkWorkerName(config, expected),
		...checkForeignHosts(config, expected),
		...checkCustomDomain(config),
		...checkZoneIds(config, expected),
		...checkResources(config, expected),
		...checkNamespaceConsistency(config),
		...checkContainers(config),
		...checkMigrationTags(config),
	];
}
