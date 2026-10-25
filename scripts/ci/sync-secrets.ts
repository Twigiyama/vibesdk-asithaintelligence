#!/usr/bin/env bun
/**
 * Pushes the WORKER_SECRETS JSON to the Worker. Additive: only the names in the
 * JSON are written, and secrets that are not listed stay as they are.
 *
 *   bun scripts/ci/sync-secrets.ts --config wrangler.jsonc [--apply] [--allow-delete] [--allow-missing-worker]
 *
 * Environment: WORKER_SECRETS (a JSON object of name to value, null to delete),
 * CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and optionally WORKER_NAME.
 *
 * Without --apply it validates and prints what would change, by name only.
 * Values are masked in the logs and never printed or passed on a command line.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { formatReport } from './lib/annotations';
import { fetchLiveWorker } from './lib/cloudflare';
import { assertWorkerName, readCloudflareEnv } from './lib/env';
import { activeDeployment, committedVarNames, isRollbackDeployment } from './lib/preflight';
import { planSecretSync, validateWorkerSecrets, type SecretEntries } from './lib/secrets';
import { parseWranglerConfig } from './lib/verify-wrangler-config';
import { fail, isGitHubActions, readJsonc } from './support';

const MIN_MASKED_LENGTH = 8;

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		config: { type: 'string', default: 'wrangler.jsonc' },
		apply: { type: 'boolean', default: false },
		'allow-delete': { type: 'boolean', default: false },
		'allow-missing-worker': { type: 'boolean', default: false },
	},
});

const github = isGitHubActions();
const report = (level: 'error' | 'warning', message: string) =>
	console.log(formatReport({ level, title: 'Secrets sync', message }, github));

/** Registers every value with the runner before anything can print it. */
function maskValues(raw: string): void {
	if (!github) return;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return;
		for (const value of Object.values(parsed)) {
			if (typeof value === 'string' && value.length >= MIN_MASKED_LENGTH) {
				console.log(`::add-mask::${value}`);
			}
		}
	} catch {
		// Invalid JSON is reported by validation, without echoing it.
	}
}

function wrangler(args: string[]): void {
	const env = { ...process.env };
	delete env.WORKER_SECRETS;
	execFileSync('bunx', ['wrangler', ...args], { stdio: 'inherit', env });
}

function upload(entries: SecretEntries, workerName: string): void {
	const upserts = Object.fromEntries(
		Object.entries(entries).filter((entry): entry is [string, string] => entry[1] !== null),
	);
	if (Object.keys(upserts).length === 0) return;

	const file = join(process.env.RUNNER_TEMP ?? tmpdir(), `worker-secrets-${randomUUID()}.json`);
	try {
		writeFileSync(file, JSON.stringify(upserts), { mode: 0o600 });
		wrangler(['secret', 'bulk', file, '--name', workerName]);
	} finally {
		rmSync(file, { force: true });
	}
}

try {
	const raw = process.env.WORKER_SECRETS;
	if (!raw) throw new Error('WORKER_SECRETS is empty or not set.');
	maskValues(raw);

	const credentials = readCloudflareEnv(process.env);
	const config = parseWranglerConfig(readJsonc(values.config));
	assertWorkerName(config.name, credentials.expectedWorkerName);
	if (!config.name) throw new Error(`${values.config} does not name a Worker.`);

	const { errors, entries } = validateWorkerSecrets(raw, {
		committedVarNames: committedVarNames(config),
		ciToken: credentials.token,
		allowDelete: values['allow-delete'],
	});
	if (errors.length > 0) {
		for (const error of errors) report('error', error);
		process.exit(1);
	}

	const live = await fetchLiveWorker({
		accountId: credentials.accountId,
		token: credentials.token,
		baseUrl: credentials.apiBaseUrl,
		workerName: config.name,
	});

	if (!live.exists && !values['allow-missing-worker']) {
		throw new Error(
			`Worker ${config.name} does not exist; wrangler would create a draft Worker to hold the secrets. Re-run with allow_missing_worker if that is intended.`,
		);
	}

	const active = activeDeployment(live.deployments);
	if (active && isRollbackDeployment(active)) {
		throw new Error(
			'The active deployment is a rollback. A secret change would be applied on top of the rolled-back version and rolling back may have reverted earlier secret changes; deploy forward first.',
		);
	}

	const plan = planSecretSync(entries, live.secretNames);
	console.log(`Worker ${config.name}: ${Object.keys(entries).length} secret(s) in WORKER_SECRETS`);
	for (const name of plan.create) console.log(`  + create  ${name}`);
	for (const name of plan.update) console.log(`  ~ update  ${name}`);
	for (const name of plan.delete) console.log(`  - delete  ${name}`);
	console.log(`  ${plan.untouched.length} existing secret(s) not listed stay unchanged`);

	if (!values.apply) {
		console.log('Dry run: nothing was written.');
	} else {
		upload(entries, config.name);
		for (const name of plan.delete) wrangler(['secret', 'delete', name, '--name', config.name]);
		console.log('Secrets written.');
	}
} catch (error) {
	fail(error);
}
