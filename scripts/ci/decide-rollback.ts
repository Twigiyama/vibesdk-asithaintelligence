#!/usr/bin/env bun
/**
 * Decides what to do after a deploy whose smoke checks ran.
 *
 *   bun scripts/ci/decide-rollback.ts --smoke-failed true|false --d1-applied N \
 *     --do-migration-applied true|false [--previous-version <id>]
 *
 * Writes `action` (none, rollback or manual) and `version_id` to the step
 * outputs. A manual outcome prints why as error annotations.
 */
import { parseArgs } from 'node:util';
import { formatReport } from './lib/annotations';
import { decideRollback } from './lib/deploy-guards';
import { fail, isGitHubActions, setOutputs } from './support';

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		'smoke-failed': { type: 'string' },
		'd1-applied': { type: 'string' },
		'do-migration-applied': { type: 'string' },
		'previous-version': { type: 'string', default: '' },
	},
});

function readBoolean(name: string, raw: string | undefined): boolean {
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	throw new Error(`--${name} must be "true" or "false".`);
}

try {
	const d1Applied = Number(values['d1-applied']);
	if (!Number.isInteger(d1Applied) || d1Applied < 0) {
		throw new Error('--d1-applied must be a non-negative integer.');
	}

	const decision = decideRollback({
		smokeFailed: readBoolean('smoke-failed', values['smoke-failed']),
		d1MigrationsApplied: d1Applied,
		durableObjectMigrationApplied: readBoolean('do-migration-applied', values['do-migration-applied']),
		previousVersionId: values['previous-version'] || undefined,
	});

	setOutputs({
		action: decision.action,
		version_id: decision.action === 'rollback' ? decision.versionId : '',
	});

	if (decision.action === 'manual') {
		for (const reason of decision.reasons) {
			console.log(
				formatReport(
					{ level: 'error', title: 'Automatic rollback skipped', message: reason },
					isGitHubActions(),
				),
			);
		}
	}
	console.log(`Rollback decision: ${decision.action}`);
} catch (error) {
	fail(error);
}
