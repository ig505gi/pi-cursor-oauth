import { describe, expect, spyOn, test } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";
import {
	AgentClientMessageSchema,
	ConversationStepSchema,
	ConversationTurnStructureSchema,
	UserMessageSchema,
} from "../src/cursor-gen/agent_pb";
import {
	type BlockState,
	buildConversationTurns,
	buildGrpcRequest,
	extractAssistantMessageText,
	extractUserMessageText,
	handleConversationCheckpointUpdate,
	parseConnectEndStream,
	processInteractionUpdate,
	toolResultToText,
	type UsageState,
} from "../src/cursor-provider-helpers";

function createOutput() {
	return {
		role: "assistant",
		content: [],
		api: "cursor-chat-api",
		provider: "cursor",
		model: "default",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as any;
}

function createBlockState(): BlockState {
	let currentTextBlock: any = null;
	let currentThinkingBlock: any = null;
	let firstTokenTime: number | undefined;

	return {
		get currentTextBlock() {
			return currentTextBlock;
		},
		get currentThinkingBlock() {
			return currentThinkingBlock;
		},
		get firstTokenTime() {
			return firstTokenTime;
		},
		setTextBlock(block) {
			currentTextBlock = block;
		},
		setThinkingBlock(block) {
			currentThinkingBlock = block;
		},
		setFirstTokenTime() {
			firstTokenTime ??= Date.now();
		},
	};
}

function createStream() {
	const events: any[] = [];

	return {
		events,
		stream: {
			push(event: any) {
				events.push(event);
			},
		},
	};
}

function getConversationStepText(stepBytes: Uint8Array): string {
	const step = fromBinary(ConversationStepSchema, stepBytes);
	if (step.message.case !== "assistantMessage") {
		throw new Error("Expected assistantMessage step");
	}
	return step.message.value.text;
}

describe("cursor-provider-helpers", () => {
	test("message text extractors handle user, assistant, and tool result content", () => {
		expect(
			extractUserMessageText({
				role: "user",
				content: [
					{ type: "text", text: "hello" },
					{ type: "image", mimeType: "image/png" },
					{ type: "audio" },
				],
			} as any),
		).toBe("hello\n[image/png image omitted]\n[audio omitted]");
		expect(
			extractAssistantMessageText({
				role: "assistant",
				content: [
					{ type: "text", text: "line one" },
					{ type: "thinking", thinking: "secret" },
					{ type: "text", text: "line two" },
				],
			} as any),
		).toBe("line one\nline two");
		expect(
			toolResultToText({
				role: "toolResult",
				content: [
					{ type: "text", text: "stdout" },
					{ type: "image", mimeType: "image/jpeg" },
				],
			} as any),
		).toBe("stdout\n[image/jpeg image]");
	});

	test("buildConversationTurns serializes prior turns and excludes the final prompt turn", () => {
		spyOn(crypto, "randomUUID")
			.mockReturnValueOnce("11111111-1111-1111-1111-111111111111")
			.mockReturnValueOnce("22222222-2222-2222-2222-222222222222");
		const turns = buildConversationTurns([
			{ role: "user", content: "first question" },
			{
				role: "assistant",
				content: [{ type: "text", text: "first answer" }],
			},
			{
				role: "toolResult",
				content: [{ type: "text", text: "tool output" }],
			},
			{ role: "developer", content: "latest instruction" },
		] as any);

		expect(turns).toHaveLength(1);
		const turn = fromBinary(ConversationTurnStructureSchema, turns[0]!);
		if (turn.turn.case !== "agentConversationTurn") {
			throw new Error("Expected agentConversationTurn");
		}
		const agentTurn = turn.turn.value;
		expect(fromBinary(UserMessageSchema, agentTurn.userMessage).text).toBe(
			"first question",
		);
		expect(agentTurn.steps).toHaveLength(2);
		expect(getConversationStepText(agentTurn.steps[0]!)).toBe("first answer");
		expect(getConversationStepText(agentTurn.steps[1]!)).toBe(
			"[Tool Result]\ntool output",
		);
	});

	test("buildGrpcRequest stores the system prompt blob, reuses matching state, and rejects empty final user input", () => {
		spyOn(crypto, "randomUUID")
			.mockReturnValueOnce("33333333-3333-3333-3333-333333333333")
			.mockReturnValueOnce("44444444-4444-4444-4444-444444444444")
			.mockReturnValueOnce("55555555-5555-5555-5555-555555555555");

		const first = buildGrpcRequest(
			{
				id: "default",
				name: "Cursor Auto",
			} as any,
			{
				systemPrompt: "System prompt",
				messages: [
					{ role: "user", content: "first question" },
					{
						role: "assistant",
						content: [{ type: "text", text: "first answer" }],
					},
					{ role: "user", content: "current question" },
				] as any,
			},
			{
				conversationId: "conversation-1",
				blobStore: new Map<string, Uint8Array>(),
			},
		);

		const clientMessage = fromBinary(
			AgentClientMessageSchema,
			first.requestBytes,
		);
		expect(clientMessage.message.case).toBe("runRequest");
		expect(first.blobStore.size).toBe(1);
		expect(
			Buffer.from(
				[...first.blobStore.values()][0] ?? new Uint8Array(),
			).toString("utf8"),
		).toContain('"content":"System prompt"');
		expect(first.conversationState.turns).toHaveLength(1);

		const second = buildGrpcRequest(
			{
				id: "default",
				name: "Cursor Auto",
			} as any,
			{
				systemPrompt: "System prompt",
				messages: [{ role: "user", content: "follow up" }] as any,
			},
			{
				conversationId: "conversation-1",
				blobStore: first.blobStore,
				conversationState: first.conversationState,
			},
		);
		expect(second.conversationState.turns).toHaveLength(1);

		expect(() =>
			buildGrpcRequest(
				{
					id: "default",
					name: "Cursor Auto",
				} as any,
				{
					messages: [{ role: "user", content: "   " }] as any,
				},
				{
					conversationId: "conversation-1",
					blobStore: new Map<string, Uint8Array>(),
				},
			),
		).toThrow("Cannot send empty user message to Cursor API");
	});

	test("processInteractionUpdate handles text, thinking, summary, and token usage changes", () => {
		const output = createOutput();
		const { events, stream } = createStream();
		const state = createBlockState();
		const usageState: UsageState = { sawTokenDelta: false };

		processInteractionUpdate(
			{ message: { case: "textDelta", value: { text: "Hello" } } },
			output,
			stream as any,
			state,
			usageState,
		);
		processInteractionUpdate(
			{ message: { case: "thinkingDelta", value: { text: "Reasoning" } } },
			output,
			stream as any,
			state,
			usageState,
		);
		processInteractionUpdate(
			{ message: { case: "summary", value: { summary: "Hello summary" } } },
			output,
			stream as any,
			state,
			usageState,
		);
		processInteractionUpdate(
			{ message: { case: "tokenDelta", value: { tokens: 42 } } },
			output,
			stream as any,
			state,
			usageState,
		);

		expect(output.content).toEqual([
			expect.objectContaining({ type: "text", text: "Hello" }),
			expect.objectContaining({ type: "thinking", thinking: "Reasoning" }),
			expect.objectContaining({ type: "text", text: "Hello summary" }),
		]);
		expect(usageState.sawTokenDelta).toBe(true);
		expect(output.usage.output).toBe(42);
		expect(events.map((event) => event.type)).toEqual([
			"text_start",
			"text_delta",
			"text_end",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
		]);
	});

	test("handleConversationCheckpointUpdate uses checkpoint tokens only before tokenDelta arrives", () => {
		const output = createOutput();
		const usageState: UsageState = { sawTokenDelta: false };

		handleConversationCheckpointUpdate(
			{ tokenDetails: { usedTokens: 11 } } as any,
			output,
			usageState,
		);
		expect(output.usage.output).toBe(11);

		usageState.sawTokenDelta = true;
		handleConversationCheckpointUpdate(
			{ tokenDetails: { usedTokens: 99 } } as any,
			output,
			usageState,
		);
		expect(output.usage.output).toBe(11);
	});

	test("parseConnectEndStream surfaces connect errors and malformed payloads", () => {
		expect(
			parseConnectEndStream(
				new TextEncoder().encode(
					JSON.stringify({
						error: {
							code: "permission_denied",
							message: "Access denied",
						},
					}),
				),
			)?.message,
		).toBe("Connect error permission_denied: Access denied");
		expect(parseConnectEndStream(new Uint8Array([1, 2, 3]))?.message).toBe(
			"Failed to parse Connect end stream",
		);
	});
});
