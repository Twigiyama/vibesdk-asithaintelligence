/**
 * Guards for D1 migrations, on pull requests and at deploy time.
 *
 * Migrations are applied before the new Worker code is deployed, so every new
 * migration has to be safe for the release that is still serving traffic.
 * Destructive statements therefore need an explicit opt-in, and migrations that
 * already shipped must never change.
 */

const MIGRATION_PATH = /^migrations\/[^/]+\.sql$/;
const MIGRATION_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$/;

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
	/\bDROP\s+(?:TABLE|COLUMN|INDEX|VIEW|TRIGGER)\b/i,
	/\bALTER\s+TABLE\s+\S+\s+DROP\b/i,
	/\bRENAME\s+(?:TO|COLUMN)\b/i,
	/\bDELETE\s+FROM\b/i,
	/\bTRUNCATE\b/i,
];

const MAX_STATEMENT_LENGTH = 100;

export type MigrationChangeStatus = 'added' | 'modified' | 'deleted';

export interface MigrationChange {
	status: MigrationChangeStatus;
	path: string;
	/** SQL text at the head commit. Required for added files. */
	sql?: string;
}

export type MigrationRule = 'immutable' | 'destructive' | 'unreadable';

export interface MigrationFinding {
	path: string;
	rule: MigrationRule;
	message: string;
	line?: number;
}

export interface CheckMigrationsOptions {
	allowDestructive: boolean;
}

export interface DestructiveStatement {
	statement: string;
	line: number;
}

/**
 * Replaces SQL comments and string literals with spaces. Line breaks are kept
 * and the result has the same length as the input, so offsets map back to the
 * original text. Quoted identifiers are left intact because statements are
 * matched against table names.
 */
export function maskSql(sql: string): string {
	const out = sql.split('');
	const blank = (from: number, to: number): void => {
		for (let k = from; k < to; k++) {
			if (out[k] !== '\n') out[k] = ' ';
		}
	};

	let i = 0;
	while (i < sql.length) {
		const ch = sql[i];
		const next = sql[i + 1];

		if (ch === '-' && next === '-') {
			const end = sql.indexOf('\n', i);
			const stop = end === -1 ? sql.length : end;
			blank(i, stop);
			i = stop;
		} else if (ch === '/' && next === '*') {
			const end = sql.indexOf('*/', i + 2);
			const stop = end === -1 ? sql.length : end + 2;
			blank(i, stop);
			i = stop;
		} else if (ch === "'") {
			let j = i + 1;
			while (j < sql.length) {
				if (sql[j] === "'") {
					if (sql[j + 1] === "'") {
						j += 2;
						continue;
					}
					break;
				}
				j++;
			}
			blank(i + 1, j);
			i = j + 1;
		} else {
			i++;
		}
	}

	return out.join('');
}

function lineOf(text: string, offset: number): number {
	let line = 1;
	for (let k = 0; k < offset; k++) {
		if (text[k] === '\n') line++;
	}
	return line;
}

function truncate(statement: string): string {
	const flat = statement.replace(/\s+/g, ' ');
	return flat.length > MAX_STATEMENT_LENGTH
		? `${flat.slice(0, MAX_STATEMENT_LENGTH - 1)}…`
		: flat;
}

/** Finds the statements in a migration that could break the running release. */
export function findDestructiveStatements(sql: string): DestructiveStatement[] {
	const masked = maskSql(sql);
	const found: DestructiveStatement[] = [];

	let start = 0;
	while (start < masked.length) {
		const semicolon = masked.indexOf(';', start);
		const end = semicolon === -1 ? masked.length : semicolon;
		const chunk = masked.slice(start, end);

		if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(chunk))) {
			const leading = chunk.length - chunk.trimStart().length;
			found.push({
				statement: truncate(chunk.trim()),
				line: lineOf(masked, start + leading),
			});
		}

		start = end + 1;
	}

	return found;
}

export function checkMigrations(
	changes: readonly MigrationChange[],
	{ allowDestructive }: CheckMigrationsOptions,
): MigrationFinding[] {
	const findings: MigrationFinding[] = [];

	for (const change of changes) {
		if (!MIGRATION_PATH.test(change.path)) continue;

		if (change.status !== 'added') {
			findings.push({
				path: change.path,
				rule: 'immutable',
				message: `${change.path} was ${change.status}. Applied migrations are immutable; add a new migration instead.`,
			});
			continue;
		}

		if (change.sql === undefined) {
			findings.push({
				path: change.path,
				rule: 'unreadable',
				message: `${change.path} could not be read, so it was not checked.`,
			});
			continue;
		}

		if (allowDestructive) continue;

		for (const { statement, line } of findDestructiveStatements(change.sql)) {
			findings.push({
				path: change.path,
				rule: 'destructive',
				line,
				message: `Destructive statement \`${statement}\`. Migrations run before the new code deploys, so the previous release must keep working against the new schema: split the change into expand and contract steps, or add the destructive-migration label if this is intentional.`,
			});
		}
	}

	return findings.sort(
		(a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0),
	);
}

export interface PendingMigration {
	name: string;
	sql: string;
}

/** Parses a comma separated list of migration file names; anything but a plain `.sql` name is rejected. */
export function parsePendingNames(raw: string): string[] {
	const names = raw
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean);

	for (const name of names) {
		if (!MIGRATION_FILE_NAME.test(name)) {
			throw new Error(`${JSON.stringify(name)} is not a migration file name.`);
		}
	}
	return names;
}

/**
 * Deploy-time guard. The pull-request guard only sees what a pull request adds;
 * this one reads the migrations a deploy is about to apply to the live database,
 * so it also covers history and anything merged past the label.
 */
export function checkPendingMigrations(
	pending: readonly PendingMigration[],
	{ allowDestructive }: CheckMigrationsOptions,
): MigrationFinding[] {
	if (allowDestructive) return [];

	return pending
		.flatMap(({ name, sql }) =>
			findDestructiveStatements(sql).map(
				({ statement, line }): MigrationFinding => ({
					path: `migrations/${name}`,
					rule: 'destructive',
					line,
					message: `Pending migration has a destructive statement \`${statement}\`. A deploy applies pending migrations to the live database before the new code uploads. Review it, take a restore point if the tables hold data, then run the deploy manually with allow_destructive.`,
				}),
			),
		)
		.sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));
}
