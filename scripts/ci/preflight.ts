#!/usr/bin/env bun
/**
 * Compares the generated deploy configuration with the Worker that is running
 * now and fails the deploy when it would do something the repository does not
 * intend: re-point a binding, drop one, or replay Durable Object migrations.
 *
 *   bun scripts/ci/preflight.ts --config dist/<worker>/wrangler.json [--report] [--allow-missing-worker]
 *
 * Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, and checks WORKER_NAME
 * against the configuration when it is set. With --report it prints the live
 * state next to the findings and always exits 0, which is how to collect the
 * committed-versus-live picture before changing the configuration.
 *
 * Secret values are never read: the API only returns their names.
 */
import { readdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { formatReport } from './lib/annotations';
import { fetchAppliedD1Migrations, fetchLiveWorker, type LiveWorker } from './lib/cloudflare';
import { assertWorkerName, readCloudflareEnv } from './lib/env';
import {
	activeDeployment,
	compareBindings,
	compareD1Migrations,
	compareMigrationTag,
	compareSecrets,
	isRollbackDeployment,
	servingVersionId,
	type PreflightFinding,
	type PreflightSeverity,
} from './lib/preflight';
import { parseWranglerConfig, type WranglerConfig } from './lib/verify-wrangler-config';
import { fail, isGitHubActions, readJsonc, setOutputs } from './support';

const RESOURCE_IDENTITY_KEYS = ['id', 'namespace_id', 'bucket_name', 'class_name', 'namespace'] as const;
const VALUE_TYPES: ReadonlySet<string> = new Set(['plain_text', 'json', 'secret_text', 'secret_key']);
const LEVELS: Record<PreflightSeverity, 'error' | 'warning' | 'notice'> = {
	error: 'error',
	warning: 'warning',
	info: 'notice',
};

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		config: { type: 'string' },
		migrations: { type: 'string', default: 'migrations' },
		report: { type: 'boolean', default: false },
		'allow-missing-worker': { type: 'boolean', default: false },
	},
});

if (!values.config) {
	console.error('usage: preflight.ts --config <wrangler.json> [--report] [--allow-missing-worker]');
	process.exit(2);
}

function describeLiveState(live: LiveWorker): void {
	console.log('\nLive state (names and resource ids only; values and secrets are never shown)');
	console.log(`  Durable Object migration tag: ${live.migrationTag ?? 'none'}`);

	console.log('  Bindings:');
	for (const binding of live.bindings) {
		const identity = VALUE_TYPES.has(binding.type)
			? ''
			: RESOURCE_IDENTITY_KEYS.filter((key) => typeof binding[key] === 'string')
					.map((key) => `${key}=${String(binding[key])}`)
					.join(' ');
		console.log(`    ${binding.name.padEnd(32)} ${binding.type.padEnd(26)} ${identity}`);
	}

	console.log(`  Secrets: ${live.secretNames.join(', ') || 'none'}`);

	console.log('  Recent deployments (newest first):');
	for (const deployment of live.deployments.slice(0, 5)) {
		const versions = deployment.versions.map((v) => `${v.versionId}@${v.percentage}%`).join(', ');
		console.log(
			`    ${deployment.createdOn ?? 'unknown time'}  ${deployment.triggeredBy ?? deployment.source ?? 'unknown'}  ${versions}`,
		);
	}
}

async function main(config: WranglerConfig, configPath: string): Promise<void> {
	const credentials = readCloudflareEnv(process.env);
	assertWorkerName(config.name, credentials.expectedWorkerName);
	if (!config.name) throw new Error(`${configPath} does not name a Worker.`);

	const live = await fetchLiveWorker({
		accountId: credentials.accountId,
		token: credentials.token,
		baseUrl: credentials.apiBaseUrl,
		workerName: config.name,
	});

	const findings: PreflightFinding[] = [];
	let pendingTags: string[] = [];

	if (live.exists) {
		findings.push(
			...compareBindings(config, live.bindings),
			...compareSecrets(config, live.secretNames),
		);
		const tags = compareMigrationTag(config, live.migrationTag);
		findings.push(...tags.findings);
		pendingTags = tags.pendingTags;
	} else {
		findings.push({
			severity: values['allow-missing-worker'] ? 'warning' : 'error',
			rule: 'worker-missing',
			message: `Worker ${config.name} does not exist on this account. This would be a first deploy: resources and secrets must exist first (see docs/ci-cd.md).`,
		});
		pendingTags = (config.migrations ?? []).map((migration) => migration.tag);
	}

	let pendingD1: string[] = [];
	const database = config.d1_databases?.[0];
	if (database?.database_id) {
		try {
			const applied = await fetchAppliedD1Migrations({
				accountId: credentials.accountId,
				token: credentials.token,
				baseUrl: credentials.apiBaseUrl,
				databaseId: database.database_id,
			});
			const repoMigrations = readdirSync(values.migrations ?? 'migrations')
				.filter((name) => name.endsWith('.sql'))
				.sort();
			const d1 = compareD1Migrations(repoMigrations, applied);
			findings.push(...d1.findings);
			pendingD1 = d1.pending;
		} catch (error) {
			findings.push({
				severity: live.exists ? 'error' : 'warning',
				rule: 'd1-migrations',
				message: `Could not read the D1 migration state: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	const active = activeDeployment(live.deployments);
	const github = isGitHubActions();

	const order: PreflightSeverity[] = ['error', 'warning', 'info'];
	findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
	for (const item of findings) {
		console.log(
			formatReport(
				{ level: LEVELS[item.severity], title: `Preflight (${item.rule})`, message: item.message },
				github,
			),
		);
	}
	if (findings.length === 0) console.log(`Preflight: ${config.name} matches the live Worker.`);

	if (values.report) describeLiveState(live);

	setOutputs({
		worker_exists: live.exists,
		previous_version_id: servingVersionId(active) ?? '',
		active_is_rollback: active ? isRollbackDeployment(active) : false,
		do_migrations_pending: pendingTags.length > 0,
		d1_pending_count: pendingD1.length,
	});

	const errors = findings.filter((item) => item.severity === 'error').length;
	if (errors > 0 && !values.report) process.exit(1);
}

try {
	const configPath = values.config;
	await main(parseWranglerConfig(readJsonc(configPath)), configPath);
} catch (error) {
	fail(error);
}
