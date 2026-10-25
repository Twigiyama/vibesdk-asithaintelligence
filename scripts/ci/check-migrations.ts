#!/usr/bin/env bun
/**
 * Fails when a pull request edits an applied D1 migration or adds a destructive
 * one without the destructive-migration label.
 *
 *   bun scripts/ci/check-migrations.ts --base <ref> [--head <ref>] [--allow-destructive]
 *
 * ALLOW_DESTRUCTIVE=true is equivalent to --allow-destructive.
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { formatReport } from './lib/annotations';
import {
	checkMigrations,
	type MigrationChange,
	type MigrationChangeStatus,
} from './lib/check-migrations';
import { isGitHubActions } from './support';

const statuses: Record<string, MigrationChangeStatus> = {
	A: 'added',
	M: 'modified',
	D: 'deleted',
	T: 'modified',
};

function git(...args: string[]): string {
	return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function listChanges(base: string, head: string): MigrationChange[] {
	// --no-renames reports a rename as a delete plus an add, so renaming an
	// applied migration is caught as an edit of the original.
	const raw = git('diff', '--name-status', '-z', '--no-renames', `${base}...${head}`, '--', 'migrations');
	const fields = raw.split('\0').filter(Boolean);
	const changes: MigrationChange[] = [];

	for (let i = 0; i + 1 < fields.length; i += 2) {
		const status = statuses[fields[i]];
		const path = fields[i + 1];
		if (!status) continue;

		let sql: string | undefined;
		if (status === 'added') {
			try {
				sql = git('show', `${head}:${path}`);
			} catch {
				sql = undefined;
			}
		}
		changes.push({ status, path, sql });
	}

	return changes;
}

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		base: { type: 'string' },
		head: { type: 'string', default: 'HEAD' },
		'allow-destructive': { type: 'boolean', default: false },
	},
});

const { base, head } = values;
if (!base) {
	console.error('usage: check-migrations.ts --base <ref> [--head <ref>] [--allow-destructive]');
	process.exit(2);
}

const allowDestructive = values['allow-destructive'] || process.env.ALLOW_DESTRUCTIVE === 'true';
const github = isGitHubActions();

const changes = listChanges(base, head);
const findings = checkMigrations(changes, { allowDestructive });

for (const finding of findings) {
	console.log(
		formatReport(
			{
				level: 'error',
				title: `Migration guard (${finding.rule})`,
				file: finding.path,
				line: finding.line,
				message: finding.message,
			},
			github,
		),
	);
}

if (findings.length > 0) process.exit(1);

const sqlChanges = changes.filter((c) => c.path.endsWith('.sql')).length;
console.log(
	`Migration guard: ${sqlChanges} migration file(s) changed${allowDestructive ? ' (destructive statements allowed)' : ''}, no findings.`,
);
