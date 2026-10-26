#!/usr/bin/env bun
/**
 * Fails when a deploy is about to apply a destructive D1 migration without the
 * manual allow_destructive opt-in.
 *
 *   bun scripts/ci/check-pending-migrations.ts --pending <name,name,...> [--dir migrations] [--allow-destructive]
 *
 * ALLOW_DESTRUCTIVE=true is equivalent to --allow-destructive. The names are the
 * pending migrations the preflight reports as `d1_pending_names`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { formatReport } from './lib/annotations';
import { checkPendingMigrations, parsePendingNames } from './lib/check-migrations';
import { fail, isGitHubActions } from './support';

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		pending: { type: 'string', default: '' },
		dir: { type: 'string', default: 'migrations' },
		'allow-destructive': { type: 'boolean', default: false },
	},
});

try {
	const dir = values.dir ?? 'migrations';
	const names = parsePendingNames(values.pending ?? '');
	const allowDestructive = values['allow-destructive'] || process.env.ALLOW_DESTRUCTIVE === 'true';
	const github = isGitHubActions();

	const findings = checkPendingMigrations(
		names.map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })),
		{ allowDestructive },
	);

	for (const finding of findings) {
		console.log(
			formatReport(
				{
					level: 'error',
					title: `Pending migration guard (${finding.rule})`,
					file: finding.path,
					line: finding.line,
					message: finding.message,
				},
				github,
			),
		);
	}
	if (findings.length > 0) process.exit(1);

	console.log(
		`Pending migration guard: ${names.length} migration(s) pending${allowDestructive ? ' (destructive statements allowed)' : ''}, no findings.`,
	);
} catch (error) {
	fail(error);
}
