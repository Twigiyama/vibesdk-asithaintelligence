import { describe, expect, it } from 'vitest';
import {
	checkMigrations,
	findDestructiveStatements,
	maskSql,
	type MigrationChange,
} from './check-migrations';

const added = (name: string, sql: string): MigrationChange => ({
	status: 'added',
	path: `migrations/${name}`,
	sql,
});

describe('maskSql', () => {
	it('blanks comments and string literals but keeps line breaks', () => {
		const sql =
			"SELECT 1; -- DROP TABLE a\n/* DELETE FROM b\nx */ SELECT 'DROP TABLE c';";
		const masked = maskSql(sql);

		expect(masked.split('\n')).toHaveLength(sql.split('\n').length);
		expect(masked).not.toMatch(/drop|delete/i);
		expect(masked).toContain('SELECT 1;');
	});

	it('preserves the length of the input so offsets map back to the original', () => {
		const sql = "SELECT 'a--b' /* c */ -- d\n;";

		expect(maskSql(sql)).toHaveLength(sql.length);
	});

	it('keeps quoted identifiers, which statements are matched against', () => {
		expect(maskSql('ALTER TABLE `apps` DROP COLUMN `x`;')).toBe(
			'ALTER TABLE `apps` DROP COLUMN `x`;',
		);
	});

	it('treats a doubled quote as an escaped quote inside a string literal', () => {
		const masked = maskSql("INSERT INTO t VALUES ('it''s DROP TABLE x'); SELECT 2;");

		expect(masked).not.toMatch(/drop/i);
		expect(masked).toContain('SELECT 2;');
	});

	it('blanks a trailing comment that has no terminating newline', () => {
		const sql = 'SELECT 1; -- trailing';

		expect(maskSql(sql)).toBe('SELECT 1;'.padEnd(sql.length));
	});
});

describe('findDestructiveStatements', () => {
	it.each([
		['DROP TABLE', 'DROP TABLE `user_secrets`;'],
		['DROP INDEX', 'DROP INDEX idx_apps_user;'],
		['DROP VIEW', 'DROP VIEW v_apps;'],
		['DROP TRIGGER', 'DROP TRIGGER trg_apps;'],
		['DROP COLUMN', 'ALTER TABLE `apps` DROP COLUMN `blueprint`;'],
		['DROP without COLUMN keyword', 'ALTER TABLE apps DROP blueprint;'],
		['RENAME TO', 'ALTER TABLE `__new_apps` RENAME TO `apps`;'],
		['RENAME COLUMN', 'ALTER TABLE apps RENAME COLUMN a TO b;'],
		['DELETE FROM', 'DELETE FROM apps WHERE id = 1;'],
		['lowercase', 'drop table apps;'],
		['mixed whitespace', 'DROP\n\tTABLE apps;'],
	])('flags %s', (_label, sql) => {
		expect(findDestructiveStatements(sql)).toHaveLength(1);
	});

	it.each([
		['CREATE TABLE', 'CREATE TABLE `a` (`id` text PRIMARY KEY NOT NULL);'],
		['ADD COLUMN', 'ALTER TABLE `apps` ADD `screenshot_url` text;'],
		['CREATE INDEX', 'CREATE INDEX idx ON apps (user_id);'],
		['foreign key ON DELETE action', 'CREATE TABLE a (b text REFERENCES c(id) ON DELETE cascade);'],
		['INSERT', "INSERT INTO settings (key, value) VALUES ('a', 'b');"],
		['UPDATE backfill', "UPDATE apps SET status = 'completed' WHERE status IS NULL;"],
		['destructive words only in comments', '-- DROP TABLE apps\nSELECT 1;'],
		['destructive words only in strings', "INSERT INTO log VALUES ('DELETE FROM apps');"],
		['drizzle breakpoint marker', 'CREATE TABLE a (id text);--> statement-breakpoint\nCREATE TABLE b (id text);'],
	])('does not flag %s', (_label, sql) => {
		expect(findDestructiveStatements(sql)).toEqual([]);
	});

	it('reports the 1-based line of each statement', () => {
		const sql = 'CREATE TABLE a (id text);\n\nDROP TABLE b;\nALTER TABLE c DROP COLUMN d;';

		expect(findDestructiveStatements(sql).map((s) => s.line)).toEqual([3, 4]);
	});

	it('returns the statement text without surrounding whitespace', () => {
		const [found] = findDestructiveStatements('CREATE TABLE a (id text);\n  DROP TABLE `b`;  ');

		expect(found.statement).toBe('DROP TABLE `b`');
	});

	it('flags every statement of the drizzle table-recreation pattern', () => {
		const sql = [
			'PRAGMA foreign_keys=OFF;--> statement-breakpoint',
			'CREATE TABLE `__new_apps` (`id` text PRIMARY KEY NOT NULL);--> statement-breakpoint',
			'INSERT INTO `__new_apps`(`id`) SELECT `id` FROM `apps`;--> statement-breakpoint',
			'DROP TABLE `apps`;--> statement-breakpoint',
			'ALTER TABLE `__new_apps` RENAME TO `apps`;--> statement-breakpoint',
			'PRAGMA foreign_keys=ON;',
		].join('\n');

		expect(findDestructiveStatements(sql).map((s) => s.line)).toEqual([4, 5]);
	});
});

describe('checkMigrations', () => {
	it('passes an additive migration', () => {
		const findings = checkMigrations(
			[added('0008_add_column.sql', 'ALTER TABLE `apps` ADD `x` text;')],
			{ allowDestructive: false },
		);

		expect(findings).toEqual([]);
	});

	it('passes when no migration files changed', () => {
		expect(checkMigrations([], { allowDestructive: false })).toEqual([]);
	});

	it('flags destructive statements in a new migration', () => {
		const findings = checkMigrations(
			[added('0008_drop.sql', 'CREATE TABLE a (id text);\nDROP TABLE `b`;')],
			{ allowDestructive: false },
		);

		expect(findings).toEqual([
			{
				path: 'migrations/0008_drop.sql',
				rule: 'destructive',
				line: 2,
				message: expect.stringContaining('DROP TABLE `b`'),
			},
		]);
		expect(findings[0].message).toContain('destructive-migration');
	});

	it('allows destructive statements in a new migration when explicitly permitted', () => {
		const findings = checkMigrations(
			[added('0008_drop.sql', 'DROP TABLE `b`;')],
			{ allowDestructive: true },
		);

		expect(findings).toEqual([]);
	});

	it('always flags a modified migration, because applied migrations are immutable', () => {
		const findings = checkMigrations(
			[{ status: 'modified', path: 'migrations/0007_violet_nebula.sql' }],
			{ allowDestructive: true },
		);

		expect(findings).toEqual([
			{
				path: 'migrations/0007_violet_nebula.sql',
				rule: 'immutable',
				message: expect.stringContaining('immutable'),
			},
		]);
	});

	it('always flags a deleted migration', () => {
		const findings = checkMigrations(
			[{ status: 'deleted', path: 'migrations/0006_puzzling_bloodstrike.sql' }],
			{ allowDestructive: true },
		);

		expect(findings.map((f) => f.rule)).toEqual(['immutable']);
	});

	it('ignores migration metadata and files outside migrations/', () => {
		const findings = checkMigrations(
			[
				{ status: 'modified', path: 'migrations/meta/_journal.json' },
				{ status: 'added', path: 'migrations/meta/0009_snapshot.json', sql: 'DROP TABLE x' },
				{ status: 'modified', path: 'docs/migrations.sql' },
				{ status: 'added', path: 'migrations/nested/0010_x.sql', sql: 'DROP TABLE x' },
			],
			{ allowDestructive: false },
		);

		expect(findings).toEqual([]);
	});

	it('reports findings ordered by path then line', () => {
		const findings = checkMigrations(
			[
				added('0010_b.sql', 'DROP TABLE a;'),
				added('0009_a.sql', 'SELECT 1;\nDROP TABLE x;\nDROP TABLE y;'),
			],
			{ allowDestructive: false },
		);

		expect(findings.map((f) => `${f.path}:${f.line}`)).toEqual([
			'migrations/0009_a.sql:2',
			'migrations/0009_a.sql:3',
			'migrations/0010_b.sql:1',
		]);
	});

	it('treats an added migration without content as a failure to read it', () => {
		const findings = checkMigrations(
			[{ status: 'added', path: 'migrations/0008_x.sql' }],
			{ allowDestructive: false },
		);

		expect(findings).toEqual([
			{
				path: 'migrations/0008_x.sql',
				rule: 'unreadable',
				message: expect.stringContaining('could not be read'),
			},
		]);
	});
});
