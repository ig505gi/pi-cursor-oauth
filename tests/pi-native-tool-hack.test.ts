import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as nativeToolHack from "../src/pi-native-tool-hack";

afterEach(() => {
	mock.restore();
	nativeToolHack.__resetPiNativeToolHackForTests();
});

async function flushAsyncWork() {
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function createCursorMessage(text: string) {
	return {
		role: "assistant",
		provider: "cursor",
		content: [{ type: "text", text }],
	};
}

async function setupPiNativeToolModules(
	options: {
		exportInteractiveMode?: boolean;
		handleEvent?: ((this: any, event: any) => unknown) | undefined;
		alreadyInstalled?: boolean;
		chatContainer?: { removeChild?: Function; addChild?: Function } | undefined;
		streamingComponent?: { updateContent?: Function } | undefined;
		pendingTools?: Map<string, unknown>;
		getMarkdownThemeWithSettings?: (() => unknown) | undefined;
		ui?: { requestRender?: Function } | undefined;
		hideThinkingBlock?: boolean;
	} = {},
) {
	const { interactiveModePath, assistantMessagePath } =
		await nativeToolHack.__resolvePiNativeToolHackModulePathsForTests();
	const forwardedEvents: any[] = [];
	const assistantSegments: any[] = [];
	const removeChild: any =
		options.chatContainer?.removeChild ?? mock(() => undefined);
	const addChild: any =
		options.chatContainer?.addChild ?? mock(() => undefined);
	const updateContent: any =
		options.streamingComponent?.updateContent ?? mock(() => undefined);
	const requestRender: any = options.ui?.requestRender ?? mock(() => undefined);

	class AssistantMessageComponent {
		message: any;
		hideThinkingBlock: boolean | undefined;
		theme: unknown;

		constructor(
			message: any,
			hideThinkingBlock: boolean | undefined,
			theme: unknown,
		) {
			this.message = message;
			this.hideThinkingBlock = hideThinkingBlock;
			this.theme = theme;
			assistantSegments.push(this);
		}
	}

	class InteractiveMode {
		chatContainer =
			options.chatContainer === undefined
				? { removeChild, addChild }
				: options.chatContainer;
		streamingComponent =
			options.streamingComponent === undefined
				? { updateContent }
				: options.streamingComponent;
		pendingTools = options.pendingTools ?? new Map<string, unknown>();
		hideThinkingBlock = options.hideThinkingBlock ?? false;
		ui = options.ui === undefined ? { requestRender } : options.ui;
		streamingMessage: any = null;

		getMarkdownThemeWithSettings() {
			return options.getMarkdownThemeWithSettings?.() ?? "mock-theme";
		}
	}

	const originalHandleEvent: any =
		options.handleEvent ??
		mock(async function (this: any, event: any) {
			forwardedEvents.push(event);
		});
	(InteractiveMode.prototype as any).handleEvent = originalHandleEvent;
	if (options.alreadyInstalled) {
		(InteractiveMode.prototype as any).__cursorNativeHackInstalled = true;
	}

	mock.module(interactiveModePath, () =>
		options.exportInteractiveMode === false ? {} : { InteractiveMode },
	);
	mock.module(assistantMessagePath, () => ({
		AssistantMessageComponent,
	}));

	return {
		InteractiveMode,
		AssistantMessageComponent,
		forwardedEvents,
		assistantSegments,
		removeChild,
		addChild,
		updateContent,
		requestRender,
		originalHandleEvent,
	};
}

describe("pi-native-tool-hack", () => {
	test("resolves pi internal module paths from the installed package root", async () => {
		const { interactiveModePath, assistantMessagePath } =
			await nativeToolHack.__resolvePiNativeToolHackModulePathsForTests();

		expect(interactiveModePath).toEndWith(
			path.join(
				"@mariozechner",
				"pi-coding-agent",
				"dist",
				"modes",
				"interactive",
				"interactive-mode.js",
			),
		);
		expect(assistantMessagePath).toEndWith(
			path.join(
				"@mariozechner",
				"pi-coding-agent",
				"dist",
				"modes",
				"interactive",
				"components",
				"assistant-message.js",
			),
		);
	});

	test("prefers argv-derived pi paths over the extension's locally resolved dependency copy", async () => {
		const runtimePrefix = path.join("/tmp", "runtime-prefix");
		const runtimePackageRoot = path.join(
			runtimePrefix,
			"lib",
			"node_modules",
			"@mariozechner",
			"pi-coding-agent",
		);
		const runtimeInteractiveModePath = path.join(
			runtimePackageRoot,
			"dist",
			"modes",
			"interactive",
			"interactive-mode.js",
		);
		const runtimeAssistantMessagePath = path.join(
			runtimePackageRoot,
			"dist",
			"modes",
			"interactive",
			"components",
			"assistant-message.js",
		);
		const localPackageRoot = path.join("/tmp", "local-copy", "pi-coding-agent");
		const localInteractiveModePath = path.join(
			localPackageRoot,
			"dist",
			"modes",
			"interactive",
			"interactive-mode.js",
		);
		const localAssistantMessagePath = path.join(
			localPackageRoot,
			"dist",
			"modes",
			"interactive",
			"components",
			"assistant-message.js",
		);

		const resolved =
			await nativeToolHack.__resolvePiNativeToolHackModulePathsForTests({
				resolveImport: async () =>
					pathToFileURL(path.join(localPackageRoot, "dist", "index.js")).href,
				existsSync: (candidatePath) =>
					candidatePath === runtimeInteractiveModePath ||
					candidatePath === runtimeAssistantMessagePath ||
					candidatePath === localInteractiveModePath ||
					candidatePath === localAssistantMessagePath,
				readFileSync: () => "",
				realpathSync: (candidatePath) => candidatePath,
				argv: [
					path.join(runtimePrefix, "bin", "node"),
					path.join(runtimePrefix, "bin", "pi"),
				],
				execPath: path.join(runtimePrefix, "bin", "node"),
				env: {},
			});

		expect(resolved).toEqual({
			interactiveModePath: runtimeInteractiveModePath,
			assistantMessagePath: runtimeAssistantMessagePath,
		});
	});

	test("falls back to argv-derived npm global paths when package resolution fails", async () => {
		const prefix = path.join("/tmp", "custom-prefix");
		const packageRoot = path.join(
			prefix,
			"lib",
			"node_modules",
			"@mariozechner",
			"pi-coding-agent",
		);
		const interactiveModePath = path.join(
			packageRoot,
			"dist",
			"modes",
			"interactive",
			"interactive-mode.js",
		);
		const assistantMessagePath = path.join(
			packageRoot,
			"dist",
			"modes",
			"interactive",
			"components",
			"assistant-message.js",
		);

		const resolved =
			await nativeToolHack.__resolvePiNativeToolHackModulePathsForTests({
				resolveImport: async () => {
					throw new Error("not exported");
				},
				existsSync: (candidatePath) =>
					candidatePath === interactiveModePath ||
					candidatePath === assistantMessagePath,
				readFileSync: () => "",
				realpathSync: (candidatePath) => candidatePath,
				argv: [
					path.join(prefix, "bin", "node"),
					path.join(prefix, "bin", "pi"),
				],
				execPath: path.join(prefix, "bin", "node"),
				env: {},
			});

		expect(resolved).toEqual({
			interactiveModePath,
			assistantMessagePath,
		});
	});

	test("surfaces a clear fallback error when private pi internals cannot be found and allows retry", async () => {
		const resolved =
			await nativeToolHack.__resolvePiNativeToolHackModulePathsForTests();
		nativeToolHack.__resetPiNativeToolHackForTests();
		const realExistsSync = fs.existsSync;
		spyOn(fs, "existsSync").mockImplementation(((
			candidatePath: fs.PathLike,
		) => {
			if (candidatePath === resolved.assistantMessagePath) {
				return false;
			}
			return realExistsSync(candidatePath);
		}) as typeof fs.existsSync);

		await expect(nativeToolHack.installPiNativeToolHack()).rejects.toThrow(
			"Failed to locate private pi interactive modules for the native tool hack.",
		);
		await expect(nativeToolHack.installPiNativeToolHack()).rejects.toThrow(
			"Expected assistant-message:",
		);

		mock.restore();
		nativeToolHack.__resetPiNativeToolHackForTests();
		await setupPiNativeToolModules();
		await expect(
			nativeToolHack.installPiNativeToolHack(),
		).resolves.toBeUndefined();
	});

	test("emit helpers no-op when no interactive mode has been activated", async () => {
		expect(() =>
			nativeToolHack.emitNativeToolExecutionStart("call-1", "grep", {
				pattern: "needle",
			}),
		).not.toThrow();
		expect(() =>
			nativeToolHack.emitNativeToolExecutionUpdate(
				"call-1",
				"grep",
				{ pattern: "needle" },
				{ content: [{ type: "text", text: "partial" }] },
			),
		).not.toThrow();
		expect(() =>
			nativeToolHack.emitNativeToolExecutionEnd(
				"call-1",
				"grep",
				{ content: [{ type: "text", text: "done" }] },
				false,
			),
		).not.toThrow();
	});

	test("installs once and dispatches native tool lifecycle events to the active interactive mode", async () => {
		const harness = await setupPiNativeToolModules();

		const firstInstall = nativeToolHack.installPiNativeToolHack();
		const secondInstall = nativeToolHack.installPiNativeToolHack();
		expect(firstInstall).toBe(secondInstall);
		await firstInstall;

		expect(
			(harness.InteractiveMode.prototype as any).__cursorNativeHackInstalled,
		).toBe(true);

		const interactiveMode = new harness.InteractiveMode();
		await (interactiveMode as any).handleEvent({
			type: "message_start",
			message: createCursorMessage("hello"),
		});

		nativeToolHack.emitNativeToolExecutionStart("tool-1", "grep", {
			pattern: "needle",
		});
		await flushAsyncWork();
		await (interactiveMode as any).handleEvent({
			type: "message_update",
			message: createCursorMessage("hello world"),
			assistantMessageEvent: {
				partial: createCursorMessage("hello world"),
			},
		});
		nativeToolHack.emitNativeToolExecutionUpdate(
			"tool-1",
			"grep",
			{ pattern: "needle" },
			{ content: [{ type: "text", text: "partial" }] },
		);
		nativeToolHack.emitNativeToolExecutionEnd(
			"tool-1",
			"grep",
			{ content: [{ type: "text", text: "done" }] },
			true,
		);
		await (interactiveMode as any).handleEvent({
			type: "agent_end",
		});
		await flushAsyncWork();

		expect(harness.forwardedEvents).toEqual([
			expect.objectContaining({
				type: "message_start",
				message: createCursorMessage("hello"),
			}),
			expect.objectContaining({
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "grep",
				args: { pattern: "needle" },
				__cursorNativeHack: true,
			}),
			expect.objectContaining({
				type: "message_update",
				message: createCursorMessage(" world"),
				assistantMessageEvent: {
					partial: createCursorMessage(" world"),
				},
			}),
			expect.objectContaining({
				type: "tool_execution_update",
				toolCallId: "tool-1",
				toolName: "grep",
				args: { pattern: "needle" },
				partialResult: { content: [{ type: "text", text: "partial" }] },
				__cursorNativeHack: true,
			}),
			expect.objectContaining({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "grep",
				result: { content: [{ type: "text", text: "done" }] },
				isError: true,
				__cursorNativeHack: true,
			}),
			expect.objectContaining({
				type: "agent_end",
			}),
		]);
		expect((interactiveMode as any).__cursorNativeSplitState).toBeUndefined();

		(interactiveMode as any).handleEvent = undefined;
		expect(() =>
			nativeToolHack.emitNativeToolExecutionStart("tool-2", "grep", {
				pattern: "other",
			}),
		).not.toThrow();
		expect(harness.forwardedEvents).toHaveLength(6);
	});

	test("splits visible assistant output around a tool and refreshes the streaming tail", async () => {
		const toolComponent = { id: "tool-component" };
		const harness = await setupPiNativeToolModules({
			pendingTools: new Map([["tool-1", toolComponent]]),
			hideThinkingBlock: true,
			getMarkdownThemeWithSettings: () => ({ theme: "cursor" }),
		});

		await nativeToolHack.installPiNativeToolHack();
		const interactiveMode = new harness.InteractiveMode();

		await (interactiveMode as any).handleEvent({
			type: "message_start",
			message: createCursorMessage("hello"),
		});
		nativeToolHack.emitNativeToolExecutionStart("bootstrap", "grep", {
			pattern: "hello",
		});
		await flushAsyncWork();

		harness.removeChild.mockClear();
		harness.addChild.mockClear();
		harness.updateContent.mockClear();
		harness.requestRender.mockClear();

		await (interactiveMode as any).handleEvent({
			type: "message_update",
			message: createCursorMessage("hello world"),
			assistantMessageEvent: {
				partial: createCursorMessage("hello world"),
			},
		});

		nativeToolHack.emitNativeToolExecutionStart("tool-1", "grep", {
			pattern: "world",
		});
		await flushAsyncWork();

		expect(harness.assistantSegments.at(-1)).toMatchObject({
			message: createCursorMessage(" world"),
			hideThinkingBlock: true,
			theme: { theme: "cursor" },
		});
		expect(harness.removeChild).toHaveBeenNthCalledWith(
			1,
			interactiveMode.streamingComponent,
		);
		expect(harness.removeChild).toHaveBeenNthCalledWith(2, toolComponent);
		expect(harness.addChild).toHaveBeenNthCalledWith(
			1,
			harness.assistantSegments.at(-1),
		);
		expect(harness.addChild).toHaveBeenNthCalledWith(2, toolComponent);
		expect(harness.addChild).toHaveBeenNthCalledWith(
			3,
			interactiveMode.streamingComponent,
		);
		expect(harness.updateContent).toHaveBeenCalledWith({
			role: "assistant",
			provider: "cursor",
			content: [],
		});
		expect(interactiveMode.streamingMessage).toEqual({
			role: "assistant",
			provider: "cursor",
			content: [],
		});
		expect((interactiveMode as any).__cursorNativeSplitState.snapshot).toEqual(
			createCursorMessage("hello world"),
		);
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
	});

	test("skips assistant segment rendering when the tail has no visible content", async () => {
		const harness = await setupPiNativeToolModules();

		await nativeToolHack.installPiNativeToolHack();
		const interactiveMode = new harness.InteractiveMode();

		await (interactiveMode as any).handleEvent({
			type: "message_start",
			message: {
				role: "assistant",
				provider: "cursor",
				content: [{ type: "thinking", thinking: "   " }],
			},
		});

		nativeToolHack.emitNativeToolExecutionStart("tool-1", "grep", {
			pattern: "blank",
		});
		await flushAsyncWork();

		expect(harness.assistantSegments).toHaveLength(0);
		expect(harness.addChild).toHaveBeenCalledTimes(1);
		expect(harness.addChild).toHaveBeenCalledWith(
			interactiveMode.streamingComponent,
		);
		expect(harness.updateContent).toHaveBeenCalledWith({
			role: "assistant",
			provider: "cursor",
			content: [],
		});
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
	});

	test("returns early when split prerequisites are missing and swallows container errors", async () => {
		const missingHarness = await setupPiNativeToolModules({
			chatContainer: undefined,
			streamingComponent: { updateContent: mock(() => undefined) },
		});

		await nativeToolHack.installPiNativeToolHack();
		const missingInteractiveMode = new missingHarness.InteractiveMode();
		(missingInteractiveMode as any).chatContainer = undefined;

		await (missingInteractiveMode as any).handleEvent({
			type: "message_start",
			message: createCursorMessage("hello"),
		});
		expect(() =>
			nativeToolHack.emitNativeToolExecutionStart("tool-1", "grep", {
				pattern: "hello",
			}),
		).not.toThrow();
		await flushAsyncWork();
		expect(missingHarness.assistantSegments).toHaveLength(0);
		expect(missingHarness.requestRender).not.toHaveBeenCalled();

		const toolComponent = { id: "tool-component" };
		const errorHarness = await setupPiNativeToolModules({
			chatContainer: {
				removeChild: mock(() => {
					throw new Error("remove failed");
				}),
				addChild: mock(() => undefined),
			},
			pendingTools: new Map([["tool-2", toolComponent]]),
		});

		nativeToolHack.__resetPiNativeToolHackForTests();
		await nativeToolHack.installPiNativeToolHack();
		const errorInteractiveMode = new errorHarness.InteractiveMode();
		await (errorInteractiveMode as any).handleEvent({
			type: "message_start",
			message: createCursorMessage("hello"),
		});

		expect(() =>
			nativeToolHack.emitNativeToolExecutionStart("tool-2", "grep", {
				pattern: "hello",
			}),
		).not.toThrow();
		await flushAsyncWork();
		expect(errorHarness.requestRender).not.toHaveBeenCalled();
	});

	test("clears split state on agent_end", async () => {
		const harness = await setupPiNativeToolModules();

		await nativeToolHack.installPiNativeToolHack();
		const interactiveMode = new harness.InteractiveMode();
		await (interactiveMode as any).handleEvent({
			type: "message_start",
			message: createCursorMessage("hello"),
		});

		expect((interactiveMode as any).__cursorNativeSplitState).toBeDefined();

		await (interactiveMode as any).handleEvent({
			type: "agent_end",
		});

		expect((interactiveMode as any).__cursorNativeSplitState).toBeUndefined();
	});

	test("install no-ops when the PI interactive mode prototype cannot be patched", async () => {
		const noPrototypeHarness = await setupPiNativeToolModules({
			exportInteractiveMode: false,
		});

		await expect(
			nativeToolHack.installPiNativeToolHack(),
		).resolves.toBeUndefined();
		expect(noPrototypeHarness.assistantSegments).toHaveLength(0);

		nativeToolHack.__resetPiNativeToolHackForTests();
		const noHandleEventHarness = await setupPiNativeToolModules({
			handleEvent: undefined,
		});
		(noHandleEventHarness.InteractiveMode.prototype as any).handleEvent =
			undefined;

		await expect(
			nativeToolHack.installPiNativeToolHack(),
		).resolves.toBeUndefined();
		expect(
			(noHandleEventHarness.InteractiveMode.prototype as any)
				.__cursorNativeHackInstalled,
		).toBeUndefined();

		nativeToolHack.__resetPiNativeToolHackForTests();
		const alreadyInstalledHarness = await setupPiNativeToolModules({
			alreadyInstalled: true,
		});

		await expect(
			nativeToolHack.installPiNativeToolHack(),
		).resolves.toBeUndefined();
		expect(
			(alreadyInstalledHarness.InteractiveMode.prototype as any).handleEvent,
		).toBe(alreadyInstalledHarness.originalHandleEvent);
	});
});
