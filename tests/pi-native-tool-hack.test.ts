import { afterEach, describe, expect, mock, test } from "bun:test";
import * as nativeToolHack from "../src/pi-native-tool-hack";

const PI_INTERACTIVE_MODE_PATH =
	"/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
const PI_ASSISTANT_MESSAGE_COMPONENT_PATH =
	"/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/components/assistant-message.js";

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

function setupPiNativeToolModules(
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

	mock.module(PI_INTERACTIVE_MODE_PATH, () =>
		options.exportInteractiveMode === false ? {} : { InteractiveMode },
	);
	mock.module(PI_ASSISTANT_MESSAGE_COMPONENT_PATH, () => ({
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
		const harness = setupPiNativeToolModules();

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
		const harness = setupPiNativeToolModules({
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
		const harness = setupPiNativeToolModules();

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
		const missingHarness = setupPiNativeToolModules({
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
		const errorHarness = setupPiNativeToolModules({
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
		const harness = setupPiNativeToolModules();

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
		const noPrototypeHarness = setupPiNativeToolModules({
			exportInteractiveMode: false,
		});

		await expect(
			nativeToolHack.installPiNativeToolHack(),
		).resolves.toBeUndefined();
		expect(noPrototypeHarness.assistantSegments).toHaveLength(0);

		nativeToolHack.__resetPiNativeToolHackForTests();
		const noHandleEventHarness = setupPiNativeToolModules({
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
		const alreadyInstalledHarness = setupPiNativeToolModules({
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
