import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import {
	type CursorAuthRuntime,
	generateCursorAuthParams,
	isCursorTokenExpiringSoon,
	loginCursor,
	pollCursorAuth,
	refreshCursorToken,
} from "../src/cursor-oauth";

function createJwt(exp: number): string {
	const header = Buffer.from(
		JSON.stringify({ alg: "none", typ: "JWT" }),
	).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
	return `${header}.${payload}.signature`;
}

describe("cursor-oauth", () => {
	beforeEach(() => {
		spyOn(crypto, "randomUUID").mockReturnValue(
			"11111111-1111-1111-1111-111111111111",
		);
		spyOn(crypto, "getRandomValues").mockImplementation((array) => {
			const bytes = array as Uint8Array | null;
			if (!bytes) {
				return array;
			}
			for (let index = 0; index < bytes.length; index += 1) {
				bytes[index] = index + 1;
			}
			return array;
		});
	});

	afterEach(() => {
		mock.restore();
		setSystemTime();
	});

	test("generateCursorAuthParams returns PKCE values and login URL parameters", async () => {
		const auth = await generateCursorAuthParams();
		const url = new URL(auth.loginUrl);

		expect(auth.verifier.length).toBeGreaterThan(0);
		expect(auth.challenge.length).toBeGreaterThan(0);
		expect(auth.uuid).toBe("11111111-1111-1111-1111-111111111111");
		expect(url.origin).toBe("https://cursor.com");
		expect(url.pathname).toBe("/loginDeepControl");
		expect(url.searchParams.get("challenge")).toBe(auth.challenge);
		expect(url.searchParams.get("uuid")).toBe(auth.uuid);
		expect(url.searchParams.get("mode")).toBe("login");
		expect(url.searchParams.get("redirectTarget")).toBe("cli");
	});

	test("pollCursorAuth retries 404 responses with backoff and returns tokens", async () => {
		const fetchCalls: string[] = [];
		const sleepDelays: number[] = [];
		const runtime: CursorAuthRuntime = {
			sleep: async (delay) => {
				sleepDelays.push(delay);
			},
			fetch: (async (url: string | URL | Request) => {
				fetchCalls.push(String(url));
				if (fetchCalls.length < 3) {
					return new Response("", { status: 404 });
				}
				return new Response(
					JSON.stringify({
						accessToken: "access-token",
						refreshToken: "refresh-token",
					}),
				);
			}) as unknown as typeof fetch,
		};

		await expect(
			pollCursorAuth("cursor uuid", "verifier value", undefined, runtime),
		).resolves.toEqual({
			accessToken: "access-token",
			refreshToken: "refresh-token",
		});
		expect(fetchCalls).toEqual([
			"https://api2.cursor.sh/auth/poll?uuid=cursor%20uuid&verifier=verifier%20value",
			"https://api2.cursor.sh/auth/poll?uuid=cursor%20uuid&verifier=verifier%20value",
			"https://api2.cursor.sh/auth/poll?uuid=cursor%20uuid&verifier=verifier%20value",
		]);
		expect(sleepDelays).toEqual([1000, 1200, 1440]);
	});

	test("pollCursorAuth throws after three consecutive fetch errors", async () => {
		const runtime: CursorAuthRuntime = {
			sleep: async () => {},
			fetch: (async () => {
				throw new Error("network down");
			}) as unknown as typeof fetch,
		};

		await expect(
			pollCursorAuth("uuid", "verifier", undefined, runtime),
		).rejects.toThrow(
			"Too many consecutive errors during Cursor auth polling: network down",
		);
	});

	test("pollCursorAuth throws on timeout and abort", async () => {
		const runtime: CursorAuthRuntime = {
			sleep: async () => {},
			fetch: (async () =>
				new Response("", { status: 404 })) as unknown as typeof fetch,
		};
		const controller = new AbortController();
		controller.abort();

		await expect(
			pollCursorAuth("uuid", "verifier", undefined, runtime),
		).rejects.toThrow("Cursor authentication polling timeout");
		await expect(
			pollCursorAuth("uuid", "verifier", controller.signal, runtime),
		).rejects.toThrow("Cursor authentication cancelled");
	});

	test("loginCursor emits callbacks and maps Cursor tokens into OAuth credentials", async () => {
		const runtime: CursorAuthRuntime = {
			sleep: async () => {},
			fetch: (async () =>
				new Response(
					JSON.stringify({
						accessToken: createJwt(1_900_000_000),
						refreshToken: "refresh-token",
					}),
				)) as unknown as typeof fetch,
		};
		const onAuth = mock(() => {});
		const onProgress = mock(() => {});
		const onPrompt = mock(async () => "");

		const credentials = await loginCursor(
			{
				onAuth,
				onProgress,
				onPrompt,
				signal: undefined,
			},
			runtime,
		);

		expect(onAuth).toHaveBeenCalledTimes(1);
		expect(onProgress).toHaveBeenCalledWith(
			"Waiting for Cursor authentication...",
		);
		expect(credentials.refresh).toBe("refresh-token");
		expect(credentials.access).toContain(".");
		expect(credentials.expires).toBe(1_900_000_000_000 - 5 * 60 * 1000);
	});

	test("refreshCursorToken uses refresh token when present and surfaces failure text", async () => {
		const fetchSpy = spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						accessToken: createJwt(1_800_000_000),
						refreshToken: "new-refresh",
					}),
				),
			)
			.mockResolvedValueOnce(new Response("bad refresh", { status: 401 }));

		await expect(
			refreshCursorToken({
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
			}),
		).resolves.toMatchObject({
			access: expect.stringContaining("."),
			refresh: "new-refresh",
		});
		expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
			method: "POST",
			headers: expect.objectContaining({
				Authorization: "Bearer refresh-token",
			}),
		});
		await expect(
			refreshCursorToken({
				access: "access-token",
				refresh: "",
				expires: Date.now() + 60_000,
			}),
		).rejects.toThrow("Cursor token refresh failed: bad refresh");
		expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({
			headers: expect.objectContaining({
				Authorization: "Bearer access-token",
			}),
		});
	});

	test("isCursorTokenExpiringSoon handles valid, malformed, and threshold-based tokens", () => {
		setSystemTime(new Date("2026-03-20T00:00:00Z"));
		const now = Math.floor(Date.parse("2026-03-20T00:00:00Z") / 1000);

		expect(isCursorTokenExpiringSoon(createJwt(now + 600))).toBe(false);
		expect(isCursorTokenExpiringSoon(createJwt(now + 200))).toBe(true);
		expect(isCursorTokenExpiringSoon(createJwt(now + 250), 200)).toBe(false);
		expect(isCursorTokenExpiringSoon("malformed.token")).toBe(true);
	});
});
