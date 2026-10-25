import { describe, expect, it } from 'vitest';
import { jwtSecretProblems } from './jwt-secret';

const STRONG = 'Zk8$mP2vQx9LwT4nBc7YhR1aSd6FgJ3e';

describe('jwtSecretProblems', () => {
	it('accepts a long secret with several character classes', () => {
		expect(STRONG).toHaveLength(32);
		expect(jwtSecretProblems(STRONG)).toEqual([]);
	});

	it('requires at least 32 characters', () => {
		expect(jwtSecretProblems(STRONG.slice(0, 31))).toEqual([
			'JWT_SECRET must be at least 32 characters long for security',
		]);
	});

	it('rejects well-known default values, after the length check', () => {
		expect(jwtSecretProblems('Password')).toContain(
			'JWT_SECRET contains a weak/default value. Please use a cryptographically secure random string',
		);
		expect(jwtSecretProblems('Password')[0]).toBe(
			'JWT_SECRET must be at least 32 characters long for security',
		);
	});

	it.each([
		['lowercase only', 'abcdefghijklmnopqrstuvwxyzabcdefgh'],
		['lowercase and digits', 'abcdefgh12345678abcdefgh12345678'],
		['uppercase and symbols', 'ABCDEFGH!@#$%^&*ABCDEFGH!@#$%^&*'],
	])('requires three character classes (%s)', (_label, secret) => {
		expect(jwtSecretProblems(secret)).toEqual([
			'JWT_SECRET must contain at least 3 different character types',
		]);
	});

	it.each([
		['lowercase, uppercase, digits', 'AbcdefGh12345678AbcdefGh12345678'],
		['lowercase, uppercase, symbols', 'AbcdefGh!@#$%^&*AbcdefGh!@#$%^&*'],
		['lowercase, digits, symbols', 'abcdefgh1234!@#$abcdefgh1234!@#$'],
	])('accepts three classes (%s)', (_label, secret) => {
		expect(jwtSecretProblems(secret)).toEqual([]);
	});

	it('rejects a run of four identical characters but allows three', () => {
		expect(jwtSecretProblems(`${STRONG}aaaa`)).toEqual([
			'JWT_SECRET contains repetitive patterns',
		]);
		expect(jwtSecretProblems(`${STRONG}aaa`)).toEqual([]);
	});

	it('reports every problem, in the order the Worker checks them', () => {
		expect(jwtSecretProblems('aaaa')).toEqual([
			'JWT_SECRET must be at least 32 characters long for security',
			'JWT_SECRET must contain at least 3 different character types',
			'JWT_SECRET contains repetitive patterns',
		]);
	});
});
