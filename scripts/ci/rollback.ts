#!/usr/bin/env bun
/**
 * Puts an earlier version of the Worker back on 100% of traffic.
 *
 *   bun scripts/ci/rollback.ts --worker <name> --message <reason> [--version <id>] [--force-secret-revert]
 *
 * Without --version it returns to the version that served before the current
 * deployment. It does not use `wrangler rollback`: in a non-interactive run that
 * command answers "yes" to its own warning and forces the rollback even when
 * secrets changed after the target version, which would bring their old values
 * back. Here that case stops the run unless --force-secret-revert is given.
 *
 * Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, and checks WORKER_NAME
 * against --worker when it is set.
 */
import { parseArgs } from 'node:util';
import { formatReport } from './lib/annotations';
import { createDeployment, fetchLiveWorker } from './lib/cloudflare';
import { assertWorkerName, readCloudflareEnv } from './lib/env';
import { activeDeployment, servingVersionId } from './lib/preflight';
import { defaultRollbackVersion } from './lib/rollback';
import { fail, isGitHubActions, setOutputs } from './support';

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		worker: { type: 'string' },
		message: { type: 'string' },
		version: { type: 'string' },
		'force-secret-revert': { type: 'boolean', default: false },
	},
});

try {
	if (!values.worker || !values.message) {
		throw new Error(
			'usage: rollback.ts --worker <name> --message <reason> [--version <id>] [--force-secret-revert]',
		);
	}

	const credentials = readCloudflareEnv(process.env);
	assertWorkerName(values.worker, credentials.expectedWorkerName);
	const client = {
		accountId: credentials.accountId,
		token: credentials.token,
		baseUrl: credentials.apiBaseUrl,
	};

	const live = await fetchLiveWorker({ ...client, workerName: values.worker });
	if (!live.exists) throw new Error(`Worker ${values.worker} does not exist on this account.`);

	const versionId = values.version ?? defaultRollbackVersion(live.deployments);
	if (!versionId) {
		throw new Error('There is no earlier stable version to return to; pass --version explicitly.');
	}
	if (versionId === servingVersionId(activeDeployment(live.deployments))) {
		throw new Error(`Version ${versionId} is already serving traffic.`);
	}

	const result = await createDeployment({
		...client,
		workerName: values.worker,
		versionId,
		message: values.message,
		force: values['force-secret-revert'],
	});

	if (!result.created) {
		const names = result.secrets.length > 0 ? result.secrets.join(', ') : 'one or more secrets';
		console.log(
			formatReport(
				{
					level: 'error',
					title: 'Rollback refused',
					message: `Secrets changed after version ${versionId} was deployed (${names}). Rolling back would bring their old values back. Roll back to a newer version, or repeat with force_secret_revert if reverting them is intended.`,
				},
				isGitHubActions(),
			),
		);
		process.exit(1);
	}

	console.log(`Version ${versionId} is now serving 100% of traffic.`);
	setOutputs({ version_id: versionId });
} catch (error) {
	fail(error);
}
