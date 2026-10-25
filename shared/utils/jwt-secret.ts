const MIN_LENGTH = 32;
const MIN_CHARACTER_CLASSES = 3;
const WEAK_SECRETS: readonly string[] = ['default', 'secret', 'password', 'changeme', 'admin', 'test'];

/**
 * Everything wrong with a JWT signing secret, in the order the Worker checks
 * it. The Worker throws the first entry at startup; deploy tooling uses the
 * same rules so a rejected secret is caught before it reaches production.
 */
export function jwtSecretProblems(secret: string): string[] {
	const problems: string[] = [];

	if (secret.length < MIN_LENGTH) {
		problems.push(`JWT_SECRET must be at least ${MIN_LENGTH} characters long for security`);
	}

	if (WEAK_SECRETS.includes(secret.toLowerCase())) {
		problems.push('JWT_SECRET contains a weak/default value. Please use a cryptographically secure random string');
	}

	const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((pattern) => pattern.test(secret)).length;
	if (classes < MIN_CHARACTER_CLASSES) {
		problems.push(`JWT_SECRET must contain at least ${MIN_CHARACTER_CLASSES} different character types`);
	}

	if (/(.)\1{3,}/.test(secret)) {
		problems.push('JWT_SECRET contains repetitive patterns');
	}

	return problems;
}
