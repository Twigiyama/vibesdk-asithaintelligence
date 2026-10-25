/** Credentials and targets read from the environment by the deploy scripts. */

// The API token is sent to this origin, so the override is limited to a local
// test server; it cannot point the token anywhere else.
const LOCAL_BASE_URL = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?(?:\/[^\s@]*)?$/;

export interface CloudflareEnv {
	token: string;
	accountId: string;
	/** The Worker the environment is meant to deploy, from the WORKER_NAME variable. */
	expectedWorkerName?: string;
	/** A local test server standing in for the Cloudflare API. */
	apiBaseUrl?: string;
}

/**
 * Reads the Cloudflare credentials. Errors name the missing variables and never
 * echo any value.
 */
export function readCloudflareEnv(
	env: Readonly<Record<string, string | undefined>>,
): CloudflareEnv {
	const missing = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'].filter((name) => !env[name]);
	if (missing.length > 0) {
		throw new Error(`Missing environment variable(s): ${missing.join(', ')}`);
	}

	const apiBaseUrl = env.CLOUDFLARE_API_BASE_URL || undefined;
	if (apiBaseUrl !== undefined && !LOCAL_BASE_URL.test(apiBaseUrl)) {
		throw new Error('CLOUDFLARE_API_BASE_URL may only point at localhost.');
	}

	return {
		token: env.CLOUDFLARE_API_TOKEN as string,
		accountId: env.CLOUDFLARE_ACCOUNT_ID as string,
		expectedWorkerName: env.WORKER_NAME || undefined,
		apiBaseUrl,
	};
}

/**
 * Stops a run that would act on a different Worker than the environment is
 * configured for, for example after a merge brought in another name.
 */
export function assertWorkerName(
	configured: string | undefined,
	expected: string | undefined,
): void {
	if (expected === undefined) return;
	if (configured === undefined) {
		throw new Error(`WORKER_NAME is ${expected} but the configuration names no Worker.`);
	}
	if (configured !== expected) {
		throw new Error(`WORKER_NAME is ${expected} but the configuration names ${configured}.`);
	}
}
