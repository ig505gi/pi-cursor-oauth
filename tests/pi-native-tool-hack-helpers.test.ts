import { describe, expect, test } from "bun:test";
import {
	buildTailMessage,
	clearSplitState,
	cloneAssistantMessage,
	cloneContentBlock,
	getOrCreateSplitState,
	getSplitState,
	hasVisibleAssistantContent,
	isCursorAssistantEvent,
	patchCursorAssistantEvent,
	setSplitState,
	subtractSnapshotBlock,
} from "../src/pi-native-tool-hack-helpers";

describe("pi-native-tool-hack-helpers", () => {
	test("recognizes Cursor assistant streaming events and visible content", () => {
		expect(
			isCursorAssistantEvent({
				type: "message_start",
				message: {
					role: "assistant",
					provider: "cursor",
				},
			}),
		).toBe(true);
		expect(
			isCursorAssistantEvent({
				type: "message_update",
				message: {
					role: "assistant",
					provider: "cursor",
				},
			}),
		).toBe(true);
		expect(
			isCursorAssistantEvent({
				type: "message_end",
				message: {
					role: "assistant",
					provider: "cursor",
				},
			}),
		).toBe(true);
		expect(
			isCursorAssistantEvent({
				type: "message_update",
				message: {
					role: "assistant",
					provider: "openai",
				},
			}),
		).toBe(false);
		expect(
			isCursorAssistantEvent({
				type: "message_end",
				message: {
					role: "user",
					provider: "cursor",
				},
			}),
		).toBe(false);
		expect(isCursorAssistantEvent({ type: "agent_end" })).toBe(false);

		expect(
			hasVisibleAssistantContent({
				content: [
					{ type: "thinking", thinking: "  " },
					{ type: "text", text: "Visible" },
				],
			}),
		).toBe(true);
		expect(
			hasVisibleAssistantContent({
				content: [{ type: "thinking", thinking: "planned" }],
			}),
		).toBe(true);
		expect(
			hasVisibleAssistantContent({
				content: [{ type: "thinking", thinking: "" }],
			}),
		).toBe(false);
		expect(hasVisibleAssistantContent({ content: "not-an-array" })).toBe(false);
	});

	test("subtractSnapshotBlock returns the remaining text or thinking delta", () => {
		expect(
			subtractSnapshotBlock(
				{ type: "text", text: "hello world" },
				{ type: "text", text: "hello" },
			),
		).toEqual({ type: "text", text: " world" });
		expect(
			subtractSnapshotBlock(
				{ type: "thinking", thinking: "reasoning++" },
				{ type: "thinking", thinking: "reasoning" },
			),
		).toEqual({ type: "thinking", thinking: "++" });
		expect(
			subtractSnapshotBlock(
				{ type: "text", text: "hello" },
				{ type: "text", text: "hello" },
			),
		).toBeUndefined();
		expect(
			subtractSnapshotBlock(
				{ type: "thinking", thinking: "reasoning" },
				{ type: "thinking", thinking: "reasoning" },
			),
		).toBeUndefined();
		expect(
			subtractSnapshotBlock(
				{ type: "text", text: "hello" },
				{ type: "text", text: "bye" },
			),
		).toBe(null);
		expect(
			subtractSnapshotBlock(
				{ type: "thinking", thinking: "reasoning" },
				{ type: "thinking", thinking: "plan" },
			),
		).toBe(null);
		expect(
			subtractSnapshotBlock(
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "hello" },
			),
		).toBe(null);
		expect(
			subtractSnapshotBlock(
				{ type: "tool_result", text: "hello" },
				{ type: "tool_result", text: "hello" },
			),
		).toBe(null);
		expect(subtractSnapshotBlock(null, { type: "text", text: "x" })).toBe(null);
		expect(subtractSnapshotBlock({ type: "text", text: "x" }, null)).toBe(null);
	});

	test("buildTailMessage clones the full message when no snapshot exists", () => {
		const fullMessage = {
			role: "assistant",
			provider: "cursor",
			content: [{ type: "text", text: "hello world" }],
		};

		const tailMessage = buildTailMessage(fullMessage, null);

		expect(tailMessage).toEqual(fullMessage);
		expect(tailMessage).not.toBe(fullMessage);
		expect(tailMessage.content).not.toBe(fullMessage.content);
	});

	test("buildTailMessage removes already-rendered assistant content", () => {
		expect(
			buildTailMessage(
				{
					role: "assistant",
					provider: "cursor",
					content: [
						{ type: "text", text: "hello world" },
						{ type: "thinking", thinking: "reasoning++" },
					],
				},
				{
					role: "assistant",
					provider: "cursor",
					content: [
						{ type: "text", text: "hello" },
						{ type: "thinking", thinking: "reasoning" },
					],
				},
			),
		).toEqual({
			role: "assistant",
			provider: "cursor",
			content: [
				{ type: "text", text: " world" },
				{ type: "thinking", thinking: "++" },
			],
		});
	});

	test("buildTailMessage drops exact-prefix matches and keeps the rest after a mismatch", () => {
		expect(
			buildTailMessage(
				{
					role: "assistant",
					provider: "cursor",
					content: [
						{ type: "text", text: "hello" },
						{ type: "thinking", thinking: "different" },
						{ type: "text", text: "later block" },
					],
				},
				{
					role: "assistant",
					provider: "cursor",
					content: [
						{ type: "text", text: "hello" },
						{ type: "thinking", thinking: "reasoning" },
					],
				},
			),
		).toEqual({
			role: "assistant",
			provider: "cursor",
			content: [
				{ type: "thinking", thinking: "different" },
				{ type: "text", text: "later block" },
			],
		});
		expect(
			buildTailMessage(
				{
					role: "assistant",
					provider: "cursor",
					content: [
						{ type: "text", text: "hello world" },
						{ type: "thinking", thinking: "++" },
					],
				},
				{
					role: "assistant",
					provider: "cursor",
					content: [{ type: "text", text: "hello" }],
				},
			),
		).toEqual({
			role: "assistant",
			provider: "cursor",
			content: [
				{ type: "text", text: " world" },
				{ type: "thinking", thinking: "++" },
			],
		});
		expect(
			buildTailMessage(
				{
					role: "assistant",
					provider: "cursor",
					content: [{ type: "text", text: "hello" }],
				},
				{
					role: "assistant",
					provider: "cursor",
					content: [{ type: "text", text: "hello" }],
				},
			),
		).toEqual({
			role: "assistant",
			provider: "cursor",
			content: [],
		});
	});

	test("patchCursorAssistantEvent passes through non-cursor events and initializes on message start", () => {
		const interactiveMode: any = {};
		const nonCursorEvent = {
			type: "message_update",
			message: {
				role: "assistant",
				provider: "openai",
				content: [{ type: "text", text: "hello" }],
			},
		};
		expect(patchCursorAssistantEvent(interactiveMode, nonCursorEvent)).toBe(
			nonCursorEvent,
		);
		expect(getSplitState(interactiveMode)).toBeNull();

		const startEvent = patchCursorAssistantEvent(interactiveMode, {
			type: "message_start",
			message: {
				role: "assistant",
				provider: "cursor",
				content: [{ type: "text", text: "hello" }],
			},
		});

		expect(startEvent.message.content).toEqual([
			{ type: "text", text: "hello" },
		]);
		expect(getSplitState(interactiveMode)?.lastFullMessage.content).toEqual([
			{ type: "text", text: "hello" },
		]);
	});

	test("patchCursorAssistantEvent rewrites message_update tails and stores the full message", () => {
		const interactiveMode: any = {};
		setSplitState(interactiveMode, {
			snapshot: {
				role: "assistant",
				provider: "cursor",
				content: [{ type: "text", text: "hello" }],
			},
			lastFullMessage: null,
		});

		const event = {
			type: "message_update",
			message: {
				role: "assistant",
				provider: "cursor",
				content: [{ type: "text", text: "hello world" }],
			},
			assistantMessageEvent: {
				partial: {
					role: "assistant",
					provider: "cursor",
					content: [],
				},
				other: true,
			},
		};

		const patchedEvent = patchCursorAssistantEvent(interactiveMode, event);

		expect(patchedEvent).toEqual({
			type: "message_update",
			message: {
				role: "assistant",
				provider: "cursor",
				content: [{ type: "text", text: " world" }],
			},
			assistantMessageEvent: {
				partial: {
					role: "assistant",
					provider: "cursor",
					content: [{ type: "text", text: " world" }],
				},
				other: true,
			},
		});
		expect(getSplitState(interactiveMode)?.lastFullMessage).toEqual(
			event.message,
		);
		expect(getSplitState(interactiveMode)?.lastFullMessage).not.toBe(
			event.message,
		);
	});

	test("patchCursorAssistantEvent rewrites message_end tails without altering assistantMessageEvent", () => {
		const interactiveMode: any = {};
		const assistantMessageEvent = { done: true };

		const patchedEvent = patchCursorAssistantEvent(interactiveMode, {
			type: "message_end",
			message: {
				role: "assistant",
				provider: "cursor",
				content: [{ type: "thinking", thinking: "reasoning++" }],
			},
			assistantMessageEvent,
		});

		expect(patchedEvent).toEqual({
			type: "message_end",
			message: {
				role: "assistant",
				provider: "cursor",
				content: [{ type: "thinking", thinking: "reasoning++" }],
			},
			assistantMessageEvent,
		});
		expect(patchedEvent.assistantMessageEvent).toBe(assistantMessageEvent);
		expect(getSplitState(interactiveMode)?.lastFullMessage).toEqual({
			role: "assistant",
			provider: "cursor",
			content: [{ type: "thinking", thinking: "reasoning++" }],
		});
	});

	test("patchCursorAssistantEvent clears split state on agent_end and clearSplitState is null-safe", () => {
		const interactiveMode: any = {
			__cursorNativeSplitState: {
				snapshot: {},
				lastFullMessage: {},
			},
		};

		const agentEndEvent = {
			type: "agent_end",
			message: {
				role: "assistant",
				provider: "cursor",
				content: [],
			},
		};

		expect(patchCursorAssistantEvent(interactiveMode, agentEndEvent)).toBe(
			agentEndEvent,
		);
		expect(interactiveMode.__cursorNativeSplitState).toBeUndefined();

		clearSplitState(undefined);
	});

	test("split state helpers create, read, set, and clear state", () => {
		const interactiveMode: any = {};
		expect(getSplitState(interactiveMode)).toBeNull();

		const state = getOrCreateSplitState(interactiveMode);

		expect(state).toEqual({
			snapshot: null,
			lastFullMessage: null,
		});
		expect(getOrCreateSplitState(interactiveMode)).toBe(state);

		const nextState = {
			snapshot: { content: [] },
			lastFullMessage: { content: [{ type: "text", text: "hello" }] },
		};
		setSplitState(interactiveMode, nextState);
		expect(getSplitState(interactiveMode)).toBe(nextState);

		clearSplitState(interactiveMode);
		expect(getSplitState(interactiveMode)).toBeNull();
	});

	test("clone helpers fall back to JSON cloning when structuredClone is unavailable", () => {
		const originalStructuredClone = globalThis.structuredClone;
		const message = {
			role: "assistant",
			provider: "cursor",
			content: [{ type: "text", text: "hello", meta: { count: 1 } }],
		};
		const block = {
			type: "thinking",
			thinking: "reasoning",
			meta: { count: 1 },
		};

		try {
			globalThis.structuredClone =
				undefined as unknown as typeof structuredClone;

			const clonedMessage = cloneAssistantMessage(message);
			const clonedBlock = cloneContentBlock(block);

			expect(clonedMessage).toEqual(message);
			expect(clonedMessage).not.toBe(message);
			expect(clonedMessage.content).not.toBe(message.content);
			expect(clonedBlock).toEqual(block);
			expect(clonedBlock).not.toBe(block);
			expect(clonedBlock.meta).not.toBe(block.meta);
		} finally {
			globalThis.structuredClone = originalStructuredClone;
		}
	});
});
