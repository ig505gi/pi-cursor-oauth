import { describe, expect, test } from "bun:test";
import {
	buildTailMessage,
	clearSplitState,
	hasVisibleAssistantContent,
	isCursorAssistantEvent,
	patchCursorAssistantEvent,
	subtractSnapshotBlock,
} from "../src/pi-native-tool-hack-helpers";

describe("pi-native-tool-hack-helpers", () => {
	test("recognizes Cursor assistant streaming events and visible content", () => {
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
				type: "message_update",
				message: {
					role: "assistant",
					provider: "openai",
				},
			}),
		).toBe(false);
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
				content: [{ type: "thinking", thinking: "" }],
			}),
		).toBe(false);
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
				{ type: "thinking", thinking: "hello" },
			),
		).toBe(null);
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

	test("patchCursorAssistantEvent tracks split state across message start and agent end", () => {
		const interactiveMode: any = {};
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
		expect(
			interactiveMode.__cursorNativeSplitState.lastFullMessage.content,
		).toEqual([{ type: "text", text: "hello" }]);

		patchCursorAssistantEvent(interactiveMode, {
			type: "agent_end",
			message: {
				role: "assistant",
				provider: "cursor",
				content: [],
			},
		});
		expect(interactiveMode.__cursorNativeSplitState).toBeUndefined();

		interactiveMode.__cursorNativeSplitState = {
			snapshot: {},
			lastFullMessage: {},
		};
		clearSplitState(interactiveMode);
		expect(interactiveMode.__cursorNativeSplitState).toBeUndefined();
	});
});
