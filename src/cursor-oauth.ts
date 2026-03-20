import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@mariozechner/pi-ai";

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY = 1000;
const POLL_MAX_DELAY = 10000;
const POLL_BACKOFF_MULTIPLIER = 1.2;

export interface CursorAuthParams {
	verifier: string;
	challenge: string;
	uuid: string;
	loginUrl: string;
}

async function generatePKCE(): Promise<{
	verifier: string;
	challenge: string;
}> {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	const verifier = btoa(String.fromCharCode(...array))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

	const hash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

	return { verifier, challenge };
}

export async function generateCursorAuthParams(): Promise<CursorAuthParams> {
	const { verifier, challenge } = await generatePKCE();
	const uuid = crypto.randomUUID();

	const params = new URLSearchParams({
		challenge,
		uuid,
		mode: "login",
		redirectTarget: "cli",
	});

	return {
		verifier,
		challenge,
		uuid,
		loginUrl: `${CURSOR_LOGIN_URL}?${params.toString()}`,
	};
}

export async function pollCursorAuth(
	uuid: string,
	verifier: string,
	signal?: AbortSignal,
): Promise<{ accessToken: string; refreshToken: string }> {
	let delay = POLL_BASE_DELAY;
	let consecutiveErrors = 0;

	for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
		if (signal?.aborted) {
			throw new Error("Cursor authentication cancelled");
		}

		await sleep(delay, signal);

		try {
			const response = await fetch(
				`${CURSOR_POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`,
				{
					signal,
				},
			);

			if (response.status === 404) {
				consecutiveErrors = 0;
				delay = Math.min(
					Math.round(delay * POLL_BACKOFF_MULTIPLIER),
					POLL_MAX_DELAY,
				);
				continue;
			}

			if (response.ok) {
				const data = (await response.json()) as {
					accessToken: string;
					refreshToken: string;
				};
				return {
					accessToken: data.accessToken,
					refreshToken: data.refreshToken,
				};
			}

			throw new Error(`Poll failed: ${response.status}`);
		} catch (error) {
			if (signal?.aborted) {
				throw new Error("Cursor authentication cancelled");
			}
			consecutiveErrors += 1;
			if (consecutiveErrors >= 3) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Too many consecutive errors during Cursor auth polling: ${message}`,
				);
			}
		}
	}

	throw new Error("Cursor authentication polling timeout");
}

export async function loginCursor(
	callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
	const { verifier, uuid, loginUrl } = await generateCursorAuthParams();

	callbacks.onAuth({
		url: loginUrl,
		instructions:
			"Approve the Cursor login in your browser. This flow polls automatically.",
	});
	callbacks.onProgress?.("Waiting for Cursor authentication...");

	const { accessToken, refreshToken } = await pollCursorAuth(
		uuid,
		verifier,
		callbacks.signal,
	);
	return {
		refresh: refreshToken,
		access: accessToken,
		expires: getTokenExpiry(accessToken),
	};
}

export async function refreshCursorToken(
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	const bearer =
		typeof credentials.refresh === "string" && credentials.refresh.length > 0
			? credentials.refresh
			: credentials.access;
	const response = await fetch(CURSOR_REFRESH_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${bearer}`,
			"Content-Type": "application/json",
		},
		body: "{}",
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Cursor token refresh failed: ${error}`);
	}

	const data = (await response.json()) as {
		accessToken: string;
		refreshToken: string;
	};

	return {
		refresh: data.refreshToken || bearer,
		access: data.accessToken,
		expires: getTokenExpiry(data.accessToken),
	};
}

export function isCursorTokenExpiringSoon(
	token: string,
	thresholdSeconds = 300,
): boolean {
	try {
		const [, payload] = token.split(".");
		if (!payload) return true;
		const decoded = JSON.parse(
			atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
		) as { exp?: number };
		const currentTime = Math.floor(Date.now() / 1000);
		return (
			typeof decoded.exp !== "number" ||
			decoded.exp - currentTime < thresholdSeconds
		);
	} catch {
		return true;
	}
}

function getTokenExpiry(token: string): number {
	try {
		const [, payload] = token.split(".");
		if (!payload) {
			return Date.now() + 3600 * 1000;
		}
		const decoded = JSON.parse(
			atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
		) as { exp?: number };
		if (typeof decoded.exp === "number") {
			return decoded.exp * 1000 - 5 * 60 * 1000;
		}
	} catch {
		// Fall through to conservative default.
	}
	return Date.now() + 3600 * 1000;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		throw new Error("Cursor authentication cancelled");
	}
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timeout = setTimeout(() => resolve(), ms);
	const onAbort = () => {
		clearTimeout(timeout);
		reject(new Error("Cursor authentication cancelled"));
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await promise;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}
