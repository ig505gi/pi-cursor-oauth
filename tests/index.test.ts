import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createCursorExtension } from "../src/index";

const fallbackModels = [
	{
		id: "default",
		name: "Cursor Auto",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
];

function createDeps(): any {
	return {
		baseUrl: "https://cursor.example.test",
		fallbackModels: [...fallbackModels],
		fetchCursorUsableModels: mock(async () => null),
		loginCursor: mock(async () => ({
			access: "access",
			refresh: "refresh",
			expires: Date.now() + 60_000,
		})),
		refreshCursorToken: mock(async () => ({
			access: "access",
			refresh: "refresh",
			expires: Date.now() + 60_000,
		})),
		streamCursorChat: mock(() => ({}) as any),
		resetCursorConversation: mock(() => {}),
		createCursorExecBridge: mock((cwd: string) => ({ cwd })),
		setCursorExecBridge: mock(() => {}),
		installPiNativeToolHack: mock(async () => {}),
	};
}

function createPiHarness() {
	const commands = new Map<
		string,
		{ description: string; handler: Function }
	>();
	const events = new Map<string, Function>();
	const providers: Array<{ name: string; config: any }> = [];

	return {
		commands,
		events,
		providers,
		pi: {
			registerProvider(name: string, config: any) {
				providers.push({ name, config });
			},
			registerCommand(
				name: string,
				command: { description: string; handler: Function },
			) {
				commands.set(name, command);
			},
			on(name: string, handler: Function) {
				events.set(name, handler);
			},
		},
	};
}

function createExtensionContext() {
	return {
		cwd: "/workspace/project",
		model: { provider: "cursor" },
		modelRegistry: {
			getApiKeyForProvider: mock(async () => "cursor-access-token"),
		},
		ui: {
			notify: mock(() => {}),
			setStatus: mock(() => {}),
		},
	};
}

describe("index", () => {
	let deps: ReturnType<typeof createDeps>;

	beforeEach(() => {
		deps = createDeps();
	});

	test("activation registers the provider, commands, and lifecycle handlers", async () => {
		const harness = createPiHarness();
		createCursorExtension(deps as any)(harness.pi as any);

		expect(harness.providers).toHaveLength(1);
		expect(harness.providers[0]).toMatchObject({
			name: "cursor",
			config: expect.objectContaining({
				baseUrl: "https://cursor.example.test",
				apiKey: "CURSOR_ACCESS_TOKEN",
				api: "cursor-chat-api",
				models: fallbackModels,
				streamSimple: deps.streamCursorChat,
				oauth: expect.objectContaining({
					name: "Cursor",
					login: deps.loginCursor,
					refreshToken: deps.refreshCursorToken,
				}),
			}),
		});
		expect(harness.commands.has("cursor-sync-models")).toBe(true);
		expect(harness.commands.has("cursor-reset-conversation")).toBe(true);
		expect(harness.events.has("session_start")).toBe(true);
		expect(harness.events.has("session_switch")).toBe(true);
		expect(harness.events.has("session_fork")).toBe(true);
		expect(harness.events.has("model_select")).toBe(true);
		expect(harness.events.has("session_shutdown")).toBe(true);
		expect(deps.installPiNativeToolHack).toHaveBeenCalledTimes(1);
	});

	test("cursor-sync-models warns when credentials are missing or model fetch fails", async () => {
		const harness = createPiHarness();
		createCursorExtension(deps as any)(harness.pi as any);

		const noCredentialsCtx = createExtensionContext();
		noCredentialsCtx.modelRegistry.getApiKeyForProvider.mockResolvedValueOnce(
			null as any,
		);
		await harness.commands
			.get("cursor-sync-models")!
			.handler([], noCredentialsCtx);
		expect(noCredentialsCtx.ui.notify).toHaveBeenCalledWith(
			"No Cursor credentials found. Run /login cursor first.",
			"warning",
		);

		const failedFetchCtx = createExtensionContext();
		deps.fetchCursorUsableModels.mockResolvedValueOnce(null);
		await harness.commands
			.get("cursor-sync-models")!
			.handler([], failedFetchCtx);
		expect(failedFetchCtx.ui.notify).toHaveBeenCalledWith(
			"Failed to fetch usable Cursor models. Keeping fallback model list.",
			"warning",
		);
	});

	test("cursor-sync-models refreshes the provider when models are returned", async () => {
		const harness = createPiHarness();
		createCursorExtension(deps as any)(harness.pi as any);

		deps.fetchCursorUsableModels.mockResolvedValueOnce([
			{
				id: "grok-code-fast-1",
				name: "Grok Code Fast 1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 64_000,
			},
		] as any);

		const ctx = createExtensionContext();
		await harness.commands.get("cursor-sync-models")!.handler([], ctx);

		expect(deps.fetchCursorUsableModels).toHaveBeenCalledWith({
			apiKey: "cursor-access-token",
			baseUrl: "https://cursor.example.test",
		});
		expect(harness.providers.at(-1)).toMatchObject({
			config: expect.objectContaining({
				models: [
					expect.objectContaining({
						id: "grok-code-fast-1",
					}),
				],
			}),
		});
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Registered 1 Cursor models.",
			"info",
		);
	});

	test("session lifecycle handlers reset conversation state and refresh the exec bridge", async () => {
		const harness = createPiHarness();
		createCursorExtension(deps as any)(harness.pi as any);
		const ctx = createExtensionContext();

		await harness.events.get("session_start")!({}, ctx);
		await harness.events.get("session_switch")!({}, ctx);
		await harness.events.get("session_fork")!({}, ctx);

		expect(deps.resetCursorConversation).toHaveBeenCalledTimes(3);
		expect(deps.createCursorExecBridge).toHaveBeenCalledWith(
			"/workspace/project",
		);
		expect(deps.setCursorExecBridge).toHaveBeenCalledWith({
			cwd: "/workspace/project",
		});
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("cursor-oauth", undefined);
	});

	test("model_select refreshes the bridge and only syncs Cursor models for the Cursor provider", async () => {
		const harness = createPiHarness();
		createCursorExtension(deps as any)(harness.pi as any);

		const cursorCtx = createExtensionContext();
		deps.fetchCursorUsableModels.mockResolvedValueOnce([] as any);
		await harness.events.get("model_select")!({}, cursorCtx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(deps.createCursorExecBridge).toHaveBeenCalledWith(
			"/workspace/project",
		);
		expect(deps.fetchCursorUsableModels).toHaveBeenCalledTimes(1);

		const otherCtx = createExtensionContext();
		otherCtx.model.provider = "openai";
		await harness.events.get("model_select")!({}, otherCtx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(deps.fetchCursorUsableModels).toHaveBeenCalledTimes(1);
	});

	test("session shutdown clears the exec bridge", async () => {
		const harness = createPiHarness();
		createCursorExtension(deps as any)(harness.pi as any);

		await harness.events.get("session_shutdown")!({}, createExtensionContext());

		expect(deps.setCursorExecBridge).toHaveBeenCalledWith(null);
	});
});
