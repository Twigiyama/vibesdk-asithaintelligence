import { describe, expect, it } from 'vitest';
import { planSecretSync, validateWorkerSecrets } from './secrets';

const STRONG_JWT = 'Zk8$mP2vQx9LwT4nBc7YhR1aSd6FgJ3e';

const context = {
	committedVarNames: ['CUSTOM_DOMAIN', 'MAX_SANDBOX_INSTANCES'],
	ciToken: 'ci-token-0123456789',
	allowDelete: false,
};

const validate = (secrets: unknown, overrides: Partial<typeof context> = {}) =>
	validateWorkerSecrets(JSON.stringify(secrets), { ...context, ...overrides });

describe('validateWorkerSecrets', () => {
	it('accepts a well-formed object and returns its entries', () => {
		const result = validate({ JWT_SECRET: STRONG_JWT, ANTHROPIC_API_KEY: 'sk-ant-xyz' });

		expect(result.errors).toEqual([]);
		expect(result.entries).toEqual({ JWT_SECRET: STRONG_JWT, ANTHROPIC_API_KEY: 'sk-ant-xyz' });
	});

	it('reports invalid JSON without echoing any of the input', () => {
		const result = validateWorkerSecrets('{"JWT_SECRET": "super-sensitive-value" oops', context);

		expect(result.errors).toEqual(['WORKER_SECRETS is not valid JSON.']);
		expect(JSON.stringify(result)).not.toContain('super-sensitive-value');
	});

	it.each([
		['an array', '[]'],
		['a string', '"text"'],
		['null', 'null'],
		['a number', '3'],
	])('rejects %s', (_label, raw) => {
		expect(validateWorkerSecrets(raw, context).errors).toEqual([
			'WORKER_SECRETS must be a JSON object of secret names to values.',
		]);
	});

	it('rejects an empty object, which would silently do nothing', () => {
		expect(validate({}).errors).toEqual(['WORKER_SECRETS contains no secrets.']);
	});

	it('rejects more than 100 secrets, the limit of one bulk upload', () => {
		const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`SECRET_${i}`, 'value-1234']));

		expect(validate(many).errors).toEqual([
			'WORKER_SECRETS has 101 secrets; one upload accepts at most 100.',
		]);
	});

	it.each(['1STARTS_WITH_DIGIT', 'has-dash', 'has space', 'has.dot', ''])(
		'rejects the invalid secret name %j',
		(name) => {
			expect(validate({ [name]: 'value-12345678' }).errors).toEqual([
				`Secret name ${JSON.stringify(name)} is not a valid binding name.`,
			]);
		},
	);

	it.each([
		['a number', 5],
		['a boolean', true],
		['an object', { nested: 'x' }],
		['an empty string', ''],
	])('rejects a value that is %s, naming only the secret', (_label, value) => {
		expect(validate({ ANTHROPIC_API_KEY: value }).errors).toEqual([
			'Secret ANTHROPIC_API_KEY must be a non-empty string (or null to delete).',
		]);
	});

	describe('deletion', () => {
		it('rejects null unless deletion is allowed', () => {
			expect(validate({ OLD_KEY: null }).errors).toEqual([
				'Secret OLD_KEY is null (delete) but deletion was not allowed; enable allow_delete.',
			]);
		});

		it('keeps null entries when deletion is allowed', () => {
			const result = validate({ OLD_KEY: null }, { allowDelete: true });

			expect(result.errors).toEqual([]);
			expect(result.entries).toEqual({ OLD_KEY: null });
		});
	});

	describe('collisions with committed vars', () => {
		it('rejects a secret that shadows a committed var', () => {
			expect(validate({ CUSTOM_DOMAIN: 'chat.example.com' }).errors).toEqual([
				'Secret CUSTOM_DOMAIN is also a committed var in wrangler.jsonc; keep non-secret configuration in vars only.',
			]);
		});

		it('still allows deleting such a secret', () => {
			expect(validate({ CUSTOM_DOMAIN: null }, { allowDelete: true }).errors).toEqual([]);
		});
	});

	describe('JWT_SECRET', () => {
		it('reports the Worker rules without echoing the value', () => {
			const weak = 'aaaa-unique-weak-sentinel';
			const result = validate({ JWT_SECRET: weak });

			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors.every((e) => e.startsWith('JWT_SECRET is rejected by the Worker: '))).toBe(true);
			expect(JSON.stringify(result.errors)).not.toContain(weak);
		});

		it('is not checked when it is being deleted', () => {
			expect(validate({ JWT_SECRET: null }, { allowDelete: true }).errors).toEqual([]);
		});
	});

	describe('CLOUDFLARE_API_TOKEN', () => {
		it('must differ from the token that deploys', () => {
			expect(validate({ CLOUDFLARE_API_TOKEN: context.ciToken }).errors).toEqual([
				'CLOUDFLARE_API_TOKEN must differ from the CI deploy token: the Worker needs a narrower token.',
			]);
		});

		it('accepts a different token', () => {
			expect(validate({ CLOUDFLARE_API_TOKEN: 'runtime-token-9876543210' }).errors).toEqual([]);
		});

		it('is not compared when the deploy token is unknown', () => {
			expect(
				validate({ CLOUDFLARE_API_TOKEN: context.ciToken }, { ciToken: undefined }).errors,
			).toEqual([]);
		});
	});

	it('collects every error', () => {
		const result = validate({ 'bad-name': 'x', CUSTOM_DOMAIN: 'y', JWT_SECRET: 'short' });

		expect(result.errors.length).toBeGreaterThanOrEqual(3);
	});
});

describe('planSecretSync', () => {
	it('separates new, existing and deleted secrets and lists what stays untouched', () => {
		const plan = planSecretSync(
			{ NEW_ONE: 'a', EXISTING: 'b', GONE: null, ALREADY_GONE: null },
			['EXISTING', 'GONE', 'OTHER', 'ANOTHER'],
		);

		expect(plan).toEqual({
			create: ['NEW_ONE'],
			update: ['EXISTING'],
			delete: ['GONE'],
			untouched: ['ANOTHER', 'OTHER'],
		});
	});

	it('sorts every list for stable output', () => {
		const plan = planSecretSync({ B: 'x', A: 'x' }, []);

		expect(plan.create).toEqual(['A', 'B']);
	});
});
