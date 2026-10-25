/**
 * Comparison of what the repository is about to deploy with what the Worker is
 * running now. Everything here is pure; scripts/ci/preflight.ts fetches the live
 * state and prints the findings.
 *
 * An error means the deploy would do something the repository does not intend:
 * point a binding at another resource, drop a binding the live code uses, or
 * replay Durable Object migrations.
 */
import type { WranglerConfig } from './verify-wrangler-config';

export type PreflightSeverity = 'error' | 'warning' | 'info';

export type PreflightRule =
	| 'worker-missing'
	| 'binding-drift'
	| 'binding-removed'
	| 'binding-new'
	| 'secret-collision'
	| 'migration-tag'
	| 'do-migration-pending'
	| 'd1-migrations';

export interface PreflightFinding {
	severity: PreflightSeverity;
	rule: PreflightRule;
	message: string;
}

export interface LiveBinding {
	name: string;
	type: string;
	[key: string]: unknown;
}

export interface LiveDeployment {
	id?: string;
	createdOn?: string;
	source?: string;
	/** The `workers/triggered_by` annotation: upload, secret, rollback or promotion. */
	triggeredBy?: string;
	message?: string;
	versions: Array<{ versionId: string; percentage: number }>;
}

export interface ExpectedBinding {
	name: string;
	/** Omitted when the live type string is not known with certainty. */
	type?: string;
	/** The field of the live binding that says which resource it points at. */
	identity?: { key: string; value: string };
}

// Secrets and plain vars are not resource bindings: they are preserved on
// deploy (keep_vars) or checked separately.
const NON_RESOURCE_TYPES: ReadonlySet<string> = new Set([
	'secret_text',
	'secret_key',
	'plain_text',
	'json',
	'inherit',
]);

const finding = (
	severity: PreflightSeverity,
	rule: PreflightRule,
	message: string,
): PreflightFinding => ({ severity, rule, message });

/** The resource bindings the config declares, in the shape the API reports them. */
export function expectedBindings(config: WranglerConfig): ExpectedBinding[] {
	const expected: ExpectedBinding[] = [];

	for (const kv of config.kv_namespaces ?? []) {
		expected.push(
			kv.id === undefined
				? { name: kv.binding, type: 'kv_namespace' }
				: { name: kv.binding, type: 'kv_namespace', identity: { key: 'namespace_id', value: kv.id } },
		);
	}
	for (const d1 of config.d1_databases ?? []) {
		expected.push(
			d1.database_id === undefined
				? { name: d1.binding, type: 'd1' }
				: { name: d1.binding, type: 'd1', identity: { key: 'id', value: d1.database_id } },
		);
	}
	for (const r2 of config.r2_buckets ?? []) {
		expected.push(
			r2.bucket_name === undefined
				? { name: r2.binding, type: 'r2_bucket' }
				: { name: r2.binding, type: 'r2_bucket', identity: { key: 'bucket_name', value: r2.bucket_name } },
		);
	}
	for (const object of config.durable_objects?.bindings ?? []) {
		expected.push({
			name: object.name,
			type: 'durable_object_namespace',
			identity: { key: 'class_name', value: object.class_name },
		});
	}
	for (const dispatch of config.dispatch_namespaces ?? []) {
		expected.push({
			name: dispatch.binding,
			type: 'dispatch_namespace',
			identity: { key: 'namespace', value: dispatch.namespace },
		});
	}

	if (config.ai) expected.push({ name: config.ai.binding, type: 'ai' });
	if (config.browser) expected.push({ name: config.browser.binding, type: 'browser' });
	if (config.assets?.binding) expected.push({ name: config.assets.binding, type: 'assets' });
	if (config.version_metadata) {
		expected.push({ name: config.version_metadata.binding, type: 'version_metadata' });
	}

	// Newer binding kinds: the name must exist, the type string is not asserted.
	for (const artifacts of config.artifacts ?? []) expected.push({ name: artifacts.binding });
	for (const loader of config.worker_loaders ?? []) expected.push({ name: loader.binding });
	for (const unsafe of config.unsafe?.bindings ?? []) expected.push({ name: unsafe.name });

	return expected;
}

export function committedVarNames(config: WranglerConfig): string[] {
	return Object.keys(config.vars ?? {});
}

export function compareBindings(
	config: WranglerConfig,
	live: readonly LiveBinding[],
): PreflightFinding[] {
	const findings: PreflightFinding[] = [];
	const liveByName = new Map(live.map((binding) => [binding.name, binding]));
	const expected = expectedBindings(config);

	for (const binding of expected) {
		const actual = liveByName.get(binding.name);

		if (!actual) {
			findings.push(finding('info', 'binding-new', `Binding ${binding.name} is new in this release.`));
			continue;
		}

		if (binding.type !== undefined && actual.type !== binding.type) {
			findings.push(
				finding(
					'error',
					'binding-drift',
					`Binding ${binding.name} is a ${actual.type} on the Worker but a ${binding.type} in the config.`,
				),
			);
			continue;
		}

		if (binding.identity) {
			const liveValue = actual[binding.identity.key];
			if (liveValue !== binding.identity.value) {
				findings.push(
					finding(
						'error',
						'binding-drift',
						`Binding ${binding.name}: live ${binding.identity.key} is ${String(liveValue ?? 'unset')}, the config has ${binding.identity.value}.`,
					),
				);
			}
		}
	}

	const expectedNames = new Set(expected.map((binding) => binding.name));
	for (const binding of live) {
		if (NON_RESOURCE_TYPES.has(binding.type) || expectedNames.has(binding.name)) continue;
		findings.push(
			finding(
				'error',
				'binding-removed',
				`Live binding ${binding.name} (${binding.type}) is not in the config; deploying would remove it.`,
			),
		);
	}

	return findings;
}

export function compareSecrets(
	config: WranglerConfig,
	secretNames: readonly string[],
): PreflightFinding[] {
	const vars = new Set(committedVarNames(config));
	return secretNames
		.filter((name) => vars.has(name))
		.map((name) =>
			finding(
				'error',
				'secret-collision',
				`${name} exists as a secret on the Worker and as a var in the config; delete the secret so the committed var takes effect.`,
			),
		);
}

export interface MigrationTagComparison {
	findings: PreflightFinding[];
	/** Tags this release will apply, in order. Empty when nothing changes. */
	pendingTags: string[];
}

export function compareMigrationTag(
	config: WranglerConfig,
	liveTag: string | null,
): MigrationTagComparison {
	const tags = (config.migrations ?? []).map((migration) => migration.tag);

	if (liveTag !== null && !tags.includes(liveTag)) {
		return {
			findings: [
				finding(
					'error',
					'migration-tag',
					`The Worker's Durable Object migration tag is ${liveTag}, which is not in the config (${tags.join(', ') || 'none'}); wrangler would replay migrations.`,
				),
			],
			pendingTags: [],
		};
	}

	const pendingTags = liveTag === null ? tags : tags.slice(tags.indexOf(liveTag) + 1);
	if (pendingTags.length === 0) return { findings: [], pendingTags };

	return {
		findings: [
			finding(
				'warning',
				'do-migration-pending',
				`This release applies Durable Object migrations ${pendingTags.join(', ')}; automatic rollback is disabled for it.`,
			),
		],
		pendingTags,
	};
}

export interface D1MigrationComparison {
	findings: PreflightFinding[];
	pending: string[];
}

/**
 * @param applied Names recorded in the database, or null when the migrations
 *   table does not exist yet.
 */
export function compareD1Migrations(
	repoMigrations: readonly string[],
	applied: readonly string[] | null,
): D1MigrationComparison {
	const appliedSet = new Set(applied ?? []);
	const repoSet = new Set(repoMigrations);
	const pending = repoMigrations.filter((name) => !appliedSet.has(name));
	const unknown = [...appliedSet].filter((name) => !repoSet.has(name));
	const findings: PreflightFinding[] = [];

	if (unknown.length > 0) {
		findings.push(
			finding(
				'error',
				'd1-migrations',
				`The database recorded migrations that are not in the repository: ${unknown.join(', ')}. Reconcile them before deploying.`,
			),
		);
	}
	if (pending.length > 0) {
		findings.push(
			finding('info', 'd1-migrations', `Pending D1 migrations: ${pending.join(', ')}.`),
		);
	}

	return { findings, pending };
}

/** The API lists deployments newest first; the first one serves traffic. */
export function activeDeployment(
	deployments: readonly LiveDeployment[],
): LiveDeployment | undefined {
	return deployments[0];
}

export function isRollbackDeployment(deployment: LiveDeployment): boolean {
	return deployment.triggeredBy === 'rollback';
}

/**
 * The version serving the most traffic in a deployment. Read before a deploy, it
 * is the version to return to if the release fails.
 */
export function servingVersionId(deployment: LiveDeployment | undefined): string | undefined {
	const versions = [...(deployment?.versions ?? [])].sort((a, b) => b.percentage - a.percentage);
	return versions[0]?.versionId;
}
