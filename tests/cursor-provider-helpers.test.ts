import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
	AgentClientMessageSchema,
	ConversationStateStructureSchema,
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

function getRunRequest(requestBytes: Uint8Array) {
	const clientMessage = fromBinary(AgentClientMessageSchema, requestBytes);
	if (clientMessage.message.case !== "runRequest") {
		throw new Error("Expected runRequest message");
	}
	return clientMessage.message.value;
}

describe("cursor-provider-helpers", () => {
	afterEach(() => {
		mock.restore();
	});

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

	test("message extractors return empty strings for unsupported inputs and trim string content", () => {
		expect(extractUserMessageText(undefined)).toBe("");
		expect(
			extractUserMessageText({
				role: "assistant",
				content: "ignored",
			} as any),
		).toBe("");
		expect(
			extractUserMessageText({
				role: "developer",
				content: "  keep this  ",
			} as any),
		).toBe("keep this");
		expect(
			extractAssistantMessageText({
				role: "user",
				content: [{ type: "text", text: "ignored" }],
			} as any),
		).toBe("");
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

	test("buildConversationTurns skips non-user history, blank turns, and empty assistant steps", () => {
		spyOn(crypto, "randomUUID").mockReturnValue(
			"66666666-6666-6666-6666-666666666666",
		);

		const turns = buildConversationTurns([
			{
				role: "assistant",
				content: [{ type: "text", text: "leading assistant message" }],
			},
			{ role: "user", content: "   " },
			{
				role: "assistant",
				content: [{ type: "text", text: "skipped after blank user" }],
			},
			{ role: "developer", content: "  historical instruction  " },
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "hidden reasoning" }],
			},
			{ role: "toolResult", content: [] },
			{ role: "user", content: "final prompt" },
		] as any);

		expect(turns).toHaveLength(1);
		const turn = fromBinary(ConversationTurnStructureSchema, turns[0]!);
		if (turn.turn.case !== "agentConversationTurn") {
			throw new Error("Expected agentConversationTurn");
		}
		const agentTurn = turn.turn.value;
		expect(fromBinary(UserMessageSchema, agentTurn.userMessage).text).toBe(
			"historical instruction",
		);
		expect(agentTurn.steps).toHaveLength(0);
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

	test("buildGrpcRequest uses the default prompt, accepts developer messages, and resets mismatched state", () => {
		spyOn(crypto, "randomUUID").mockReturnValue(
			"77777777-7777-7777-7777-777777777777",
		);

		const staleState = create(ConversationStateStructureSchema, {
			rootPromptMessagesJson: [Uint8Array.from([1, 2, 3])],
			turns: [Uint8Array.from([9, 9, 9])],
			todos: [],
			pendingToolCalls: [],
			previousWorkspaceUris: [],
			fileStates: {},
			fileStatesV2: {},
			summaryArchives: [],
			turnTimings: [],
			subagentStates: {},
			selfSummaryCount: 4,
			readPaths: ["/tmp/stale"],
		});

		const result = buildGrpcRequest(
			{
				id: "fast",
				name: "Fast Model",
			} as any,
			{
				messages: [
					{ role: "developer", content: "  follow instructions  " },
				] as any,
			},
			{
				conversationId: "conversation-2",
				blobStore: new Map<string, Uint8Array>(),
				conversationState: staleState,
			},
		);

		const runRequest = getRunRequest(result.requestBytes) as any;
		expect(runRequest.conversationId).toBe("conversation-2");
		expect(runRequest.modelDetails).toMatchObject({
			modelId: "fast",
			displayModelId: "fast",
			displayName: "Fast Model",
		});
		expect(runRequest.action.action.case).toBe("userMessageAction");
		expect(runRequest.action.action.value.userMessage.text).toBe(
			"follow instructions",
		);
		expect(result.conversationState.turns).toHaveLength(0);
		expect(result.conversationState.selfSummaryCount).toBe(0);
		expect(result.conversationState.readPaths).toEqual([]);
		expect(
			Buffer.from(
				[...result.blobStore.values()][0] ?? new Uint8Array(),
			).toString("utf8"),
		).toContain('"content":"You are a helpful assistant."');
	});

	test("processInteractionUpdate handles text, thinking, summary, and token usage changes", () => {
		const output = createOutput();
		output.usage.input = 1;
		output.usage.cacheRead = 2;
		output.usage.cacheWrite = 3;
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
		expect(output.usage.totalTokens).toBe(48);
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

	test("processInteractionUpdate ignores empty deltas and handles turn completion", () => {
		const output = createOutput();
		output.stopReason = "max-tokens";
		const { events, stream } = createStream();
		const state = createBlockState();
		const usageState: UsageState = { sawTokenDelta: false };

		processInteractionUpdate(
			{ message: { case: "textDelta", value: { text: "" } } },
			output,
			stream as any,
			state,
			usageState,
		);
		processInteractionUpdate(
			{ message: { case: "thinkingDelta", value: { text: "" } } },
			output,
			stream as any,
			state,
			usageState,
		);
		processInteractionUpdate(
			{ message: { case: "summary", value: { summary: "" } } },
			output,
			stream as any,
			state,
			usageState,
		);
		processInteractionUpdate(
			{ message: { case: "turnEnded", value: {} } },
			output,
			stream as any,
			state,
			usageState,
		);

		expect(state.firstTokenTime).toBeDefined();
		expect(output.content).toEqual([]);
		expect(events).toEqual([]);
		expect(output.stopReason).toBe("stop");
	});

	test("processInteractionUpdate closes active blocks and completes thinking streams", () => {
		const output = createOutput();
		const { events, stream } = createStream();
		const state = createBlockState();
		const usageState: UsageState = { sawTokenDelta: false };
		const existingThinkingBlock = {
			type: "thinking",
			thinking: "Plan",
			index: 0,
		} as any;

		output.content.push(existingThinkingBlock);
		state.setThinkingBlock(existingThinkingBlock);

		processInteractionUpdate(
			{ message: { case: "textDelta", value: { text: "Answer" } } },
			output,
			stream as any,
			state,
			usageState,
		);
		processInteractionUpdate(
			{ message: { case: "thinkingDelta", value: { text: "Follow up" } } },
			output,
			stream as any,
			state,
			usageState,
		);
		processInteractionUpdate(
			{ message: { case: "thinkingCompleted", value: {} } },
			output,
			stream as any,
			state,
			usageState,
		);
		processInteractionUpdate(
			{ message: { case: "thinkingCompleted", value: {} } },
			output,
			stream as any,
			state,
			usageState,
		);

		expect(output.content).toEqual([
			expect.objectContaining({ type: "thinking", thinking: "Plan" }),
			expect.objectContaining({ type: "text", text: "Answer" }),
			expect.objectContaining({ type: "thinking", thinking: "Follow up" }),
		]);
		expect(events.map((event) => event.type)).toEqual([
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
		]);
	});

	test("processInteractionUpdate appends only new summary text", () => {
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
			{ message: { case: "summary", value: { summary: "Hello" } } },
			output,
			stream as any,
			state,
			usageState,
		);
		processInteractionUpdate(
			{ message: { case: "summary", value: { summary: "Hello world" } } },
			output,
			stream as any,
			state,
			usageState,
		);
		processInteractionUpdate(
			{ message: { case: "summary", value: { summary: "world" } } },
			output,
			stream as any,
			state,
			usageState,
		);
		processInteractionUpdate(
			{ message: { case: "summary", value: { summary: "Different" } } },
			output,
			stream as any,
			state,
			usageState,
		);

		expect(output.content).toEqual([
			expect.objectContaining({ type: "text", text: "Hello world\nDifferent" }),
		]);
		expect(events.map((event) => event.type)).toEqual([
			"text_start",
			"text_delta",
			"text_delta",
			"text_delta",
		]);
		expect(events.map((event) => event.delta).filter(Boolean)).toEqual([
			"Hello",
			" world",
			"\nDifferent",
		]);
	});

	test("processInteractionUpdate tolerates block states that reject new blocks", () => {
		const usageState: UsageState = { sawTokenDelta: false };
		const createRejectingState = (): BlockState => ({
			currentTextBlock: null,
			currentThinkingBlock: null,
			firstTokenTime: undefined,
			setTextBlock() {},
			setThinkingBlock() {},
			setFirstTokenTime() {},
		});

		const textOutput = createOutput();
		const textStream = createStream();
		processInteractionUpdate(
			{ message: { case: "textDelta", value: { text: "Hello" } } },
			textOutput,
			textStream.stream as any,
			createRejectingState(),
			usageState,
		);
		expect(textOutput.content).toEqual([
			expect.objectContaining({ type: "text", text: "" }),
		]);
		expect(textStream.events.map((event) => event.type)).toEqual([
			"text_start",
		]);

		const thinkingOutput = createOutput();
		const thinkingStream = createStream();
		processInteractionUpdate(
			{ message: { case: "thinkingDelta", value: { text: "Plan" } } },
			thinkingOutput,
			thinkingStream.stream as any,
			createRejectingState(),
			usageState,
		);
		expect(thinkingOutput.content).toEqual([
			expect.objectContaining({ type: "thinking", thinking: "" }),
		]);
		expect(thinkingStream.events.map((event) => event.type)).toEqual([
			"thinking_start",
		]);

		const summaryOutput = createOutput();
		const summaryStream = createStream();
		processInteractionUpdate(
			{ message: { case: "summary", value: { summary: "Summary" } } },
			summaryOutput,
			summaryStream.stream as any,
			createRejectingState(),
			usageState,
		);
		expect(summaryOutput.content).toEqual([
			expect.objectContaining({ type: "text", text: "" }),
		]);
		expect(summaryStream.events.map((event) => event.type)).toEqual([
			"text_start",
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

	test("handleConversationCheckpointUpdate reports checkpoints, ignores zero tokens, and recalculates totals", () => {
		const output = createOutput();
		output.usage.input = 2;
		output.usage.cacheRead = 3;
		output.usage.cacheWrite = 4;
		const usageState: UsageState = { sawTokenDelta: false };
		const onConversationCheckpoint = mock(() => {});
		const checkpoint = { tokenDetails: { usedTokens: 11 } } as any;

		handleConversationCheckpointUpdate(
			checkpoint,
			output,
			usageState,
			onConversationCheckpoint,
		);
		expect(onConversationCheckpoint).toHaveBeenCalledWith(checkpoint);
		expect(output.usage.output).toBe(11);
		expect(output.usage.totalTokens).toBe(20);

		handleConversationCheckpointUpdate(
			{ tokenDetails: { usedTokens: 0 } } as any,
			output,
			usageState,
		);
		expect(output.usage.output).toBe(11);
		expect(output.usage.totalTokens).toBe(20);
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

	test("parseConnectEndStream returns null for successful payloads and fills unknown error fields", () => {
		expect(
			parseConnectEndStream(new TextEncoder().encode(JSON.stringify({}))),
		).toBeNull();
		expect(
			parseConnectEndStream(
				new TextEncoder().encode(JSON.stringify({ error: {} })),
			)?.message,
		).toBe("Connect error unknown: Unknown error");
	});
});
