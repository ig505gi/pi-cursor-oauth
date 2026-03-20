import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	AskQuestionInteractionQuerySchema,
	ConversationStateStructureSchema,
	CreatePlanRequestQuerySchema,
	ExaFetchRequestQuerySchema,
	ExaSearchRequestQuerySchema,
	ExecServerControlMessageSchema,
	ExecServerMessageSchema,
	GetBlobArgsSchema,
	InteractionQuerySchema,
	InteractionUpdateSchema,
	KvServerMessageSchema,
	SetBlobArgsSchema,
	SetupVmEnvironmentArgsSchema,
	SummaryUpdateSchema,
	SwitchModeRequestQuerySchema,
	TextDeltaUpdateSchema,
	ThinkingDeltaUpdateSchema,
	TokenDeltaUpdateSchema,
	WebSearchRequestQuerySchema,
} from "../src/cursor-gen/agent_pb";

type MockStream = {
	events: any[];
	ended: boolean;
	push: (event: any) => void;
	end: () => void;
};

type MockRequest = EventEmitter & {
	writes: Buffer[];
	closed: boolean;
	write: ReturnType<typeof mock>;
	close: ReturnType<typeof mock>;
};

type MockClient = EventEmitter & {
	close: ReturnType<typeof mock>;
	request: (headers: Record<string, string>) => MockRequest;
};

const providerScenario: {
	baseUrls: string[];
	requestHeaders: Record<string, string>[];
	requests: MockRequest[];
	clients: MockClient[];
	streams: MockStream[];
	calculateCostCalls: Array<{ modelId: string; usage: any }>;
	execMessages: any[];
	execControlMessages: any[];
} = {
	baseUrls: [],
	requestHeaders: [],
	requests: [],
	clients: [],
	streams: [],
	calculateCostCalls: [],
	execMessages: [],
	execControlMessages: [],
};

function resetScenario() {
	providerScenario.baseUrls = [];
	providerScenario.requestHeaders = [];
	providerScenario.requests = [];
	providerScenario.clients = [];
	providerScenario.streams = [];
	providerScenario.calculateCostCalls = [];
	providerScenario.execMessages = [];
	providerScenario.execControlMessages = [];
}

function createRequest(): MockRequest {
	const request = new EventEmitter() as MockRequest;
	request.writes = [];
	request.closed = false;
	request.write = mock((chunk: Uint8Array) => {
		request.writes.push(Buffer.from(chunk));
		return true;
	});
	request.close = mock(() => {
		request.closed = true;
	});
	return request;
}

mock.module("node:http2", () => ({
	connect: mock((baseUrl: string) => {
		const client = new EventEmitter() as MockClient;
		client.close = mock(() => {});
		client.request = (headers) => {
			providerScenario.requestHeaders.push(headers);
			const request = createRequest();
			providerScenario.requests.push(request);
			return request;
		};
		providerScenario.baseUrls.push(baseUrl);
		providerScenario.clients.push(client);
		return client;
	}),
}));

mock.module("@mariozechner/pi-ai", () => ({
	createAssistantMessageEventStream: mock(() => {
		const stream: MockStream = {
			events: [],
			ended: false,
			push(event: any) {
				stream.events.push(event);
			},
			end() {
				stream.ended = true;
			},
		};
		providerScenario.streams.push(stream);
		return stream;
	}),
	calculateCost: mock((model: { id: string }, usage: any) => {
		providerScenario.calculateCostCalls.push({
			modelId: model.id,
			usage: structuredClone(usage),
		});
		usage.cost.total = 999;
	}),
}));

mock.module("../src/cursor-exec-bridge", () => ({
	handleExecServerMessage: mock(async (message: unknown) => {
		providerScenario.execMessages.push(message);
	}),
	handleExecServerControlMessage: mock((message: unknown) => {
		providerScenario.execControlMessages.push(message);
	}),
}));

let providerModulePromise:
	| Promise<typeof import("../src/cursor-provider")>
	| undefined;

async function loadProvider() {
	providerModulePromise ??= import("../src/cursor-provider");
	return providerModulePromise;
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5000,
): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error(`Timed out after ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function encodeServerMessage(messageCase: string, value: unknown): Uint8Array {
	return toBinary(
		AgentServerMessageSchema,
		create(AgentServerMessageSchema, {
			message: {
				case: messageCase as never,
				value: value as never,
			},
		}),
	);
}

function decodeClientMessages(writes: Buffer[]) {
	return writes.map((frame) => {
		expect(frame[0]).toBe(0);
		const payloadLength = frame.readUInt32BE(1);
		expect(frame.byteLength).toBe(5 + payloadLength);
		return fromBinary(
			AgentClientMessageSchema,
			new Uint8Array(frame.subarray(5, 5 + payloadLength)),
		);
	});
}

function createModel(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: "cursor-auto",
		name: "Cursor Auto",
		api: "cursor-chat-api",
		provider: "cursor",
		baseUrl: "https://cursor.example.test",
		...overrides,
	} as any;
}

function createContext(
	overrides: Partial<{
		systemPrompt: string;
		messages: any[];
	}> = {},
) {
	return {
		systemPrompt: "System prompt",
		messages: [{ role: "user", content: "Hello Cursor" }],
		...overrides,
	};
}

function getRunRequest(request: MockRequest) {
	const messages = decodeClientMessages(request.writes);
	expect(messages[0]?.message.case).toBe("runRequest");
	return messages[0]!.message.value as any;
}

function asMockStream(stream: unknown): MockStream {
	return stream as MockStream;
}

beforeEach(async () => {
	resetScenario();
	const { resetCursorConversation } = await loadProvider();
	resetCursorConversation();
});

afterEach(() => {
	mock.restore();
});

describe("cursor-provider", () => {
	test("emits an error when no Cursor API key is provided", async () => {
		const { streamCursorChat } = await loadProvider();

		const stream = streamCursorChat(createModel(), createContext());
		const mockStream = asMockStream(stream);

		await waitFor(() => mockStream.ended);

		expect(providerScenario.baseUrls).toEqual([]);
		expect(mockStream.events).toHaveLength(1);
		expect(mockStream.events[0]).toMatchObject({
			type: "error",
			reason: "error",
			error: expect.objectContaining({
				errorMessage:
					"Cursor API key (access token) is required. Run /login cursor.",
			}),
		});
	});

	test("streams text updates over partial frames, ignores malformed frames, and completes successfully", async () => {
		const { streamCursorChat } = await loadProvider();

		const stream = streamCursorChat(createModel(), createContext(), {
			apiKey: "cursor-access-token",
		});
		const mockStream = asMockStream(stream);

		await waitFor(() => providerScenario.requests.length === 1);
		const request = providerScenario.requests[0]!;
		expect(providerScenario.baseUrls).toEqual(["https://cursor.example.test"]);
		expect(providerScenario.requestHeaders[0]).toMatchObject({
			":method": "POST",
			":path": "/agent.v1.AgentService/Run",
			authorization: "Bearer cursor-access-token",
			"x-cursor-client-type": "cli",
			"x-ghost-mode": "true",
		});
		expect(typeof providerScenario.requestHeaders[0]?.["x-request-id"]).toBe(
			"string",
		);
		expect(request.writes).toHaveLength(1);

		const malformedFrame = frameConnectMessage(Uint8Array.from([1, 2, 3]));
		const textUpdateFrame = frameConnectMessage(
			encodeServerMessage(
				"interactionUpdate",
				create(InteractionUpdateSchema, {
					message: {
						case: "textDelta",
						value: create(TextDeltaUpdateSchema, { text: "Hello back" }),
					},
				}),
			),
		);
		const splitIndex = 3;
		request.emit("data", malformedFrame);
		request.emit("data", textUpdateFrame.subarray(0, splitIndex));
		request.emit("data", textUpdateFrame.subarray(splitIndex));
		request.emit("end");

		await waitFor(() => mockStream.ended);

		expect(providerScenario.calculateCostCalls).toHaveLength(1);
		expect(providerScenario.calculateCostCalls[0]?.modelId).toBe("cursor-auto");
		expect(request.close).toHaveBeenCalled();
		expect(providerScenario.clients[0]?.close).toHaveBeenCalled();
		expect(mockStream.events).toEqual([
			expect.objectContaining({ type: "start" }),
			expect.objectContaining({ type: "text_start" }),
			expect.objectContaining({ type: "text_delta", delta: "Hello back" }),
			expect.objectContaining({ type: "text_end", content: "Hello back" }),
			expect.objectContaining({
				type: "done",
				reason: "stop",
				message: expect.objectContaining({
					content: [expect.objectContaining({ text: "Hello back" })],
					usage: expect.objectContaining({
						cost: expect.objectContaining({ total: 999 }),
					}),
				}),
			}),
		]);
	});

	test("uses the default Cursor API URL and closes open thinking blocks on end", async () => {
		const { CURSOR_API_URL, streamCursorChat } = await loadProvider();

		const stream = streamCursorChat(
			createModel({ baseUrl: undefined }),
			createContext(),
			{
				apiKey: "cursor-access-token",
			},
		);
		const mockStream = asMockStream(stream);

		await waitFor(() => providerScenario.requests.length === 1);
		const request = providerScenario.requests[0]!;
		request.emit(
			"data",
			frameConnectMessage(
				encodeServerMessage(
					"interactionUpdate",
					create(InteractionUpdateSchema, {
						message: {
							case: "thinkingDelta",
							value: create(ThinkingDeltaUpdateSchema, { text: "Plan first" }),
						},
					}),
				),
			),
		);
		request.emit("end");

		await waitFor(() => mockStream.ended);

		expect(providerScenario.baseUrls).toEqual([CURSOR_API_URL]);
		expect(mockStream.events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"done",
		]);
		expect(mockStream.events[3]).toMatchObject({
			content: "Plan first",
		});
	});

	test("surfaces gRPC trailer errors", async () => {
		const { streamCursorChat } = await loadProvider();

		const stream = streamCursorChat(createModel(), createContext(), {
			apiKey: "cursor-access-token",
		});
		const mockStream = asMockStream(stream);

		await waitFor(() => providerScenario.requests.length === 1);
		const request = providerScenario.requests[0]!;
		request.emit("trailers", {
			"grpc-status": "13",
			"grpc-message": "bad%20news",
		});

		await waitFor(() => mockStream.ended);

		expect(mockStream.events.at(-1)).toMatchObject({
			type: "error",
			reason: "error",
			error: expect.objectContaining({
				errorMessage: "gRPC error 13: bad news",
			}),
		});
	});

	test("surfaces connect end-stream errors", async () => {
		const { streamCursorChat } = await loadProvider();

		const stream = streamCursorChat(createModel(), createContext(), {
			apiKey: "cursor-access-token",
		});
		const mockStream = asMockStream(stream);

		await waitFor(() => providerScenario.requests.length === 1);
		const request = providerScenario.requests[0]!;
		request.emit(
			"data",
			frameConnectMessage(
				new TextEncoder().encode(
					JSON.stringify({
						error: { code: "permission_denied", message: "No access" },
					}),
				),
				0b00000010,
			),
		);
		request.emit("end");

		await waitFor(() => mockStream.ended);

		expect(request.close).toHaveBeenCalled();
		expect(mockStream.events.at(-1)).toMatchObject({
			type: "error",
			reason: "error",
			error: expect.objectContaining({
				errorMessage: "Connect error permission_denied: No access",
			}),
		});
	});

	test("aborts the request when the caller signal is cancelled", async () => {
		const { streamCursorChat } = await loadProvider();
		const controller = new AbortController();

		const stream = streamCursorChat(createModel(), createContext(), {
			apiKey: "cursor-access-token",
			signal: controller.signal,
		});
		const mockStream = asMockStream(stream);

		await waitFor(() => providerScenario.requests.length === 1);
		const request = providerScenario.requests[0]!;
		controller.abort();

		await waitFor(() => mockStream.ended);

		expect(request.close).toHaveBeenCalled();
		expect(mockStream.events.at(-1)).toMatchObject({
			type: "error",
			reason: "aborted",
			error: expect.objectContaining({
				stopReason: "aborted",
				errorMessage: "Request was aborted",
			}),
		});
	});

	test("routes kv, exec, control, and interaction query messages and reuses cached state until reset", async () => {
		const { resetCursorConversation, streamCursorChat } = await loadProvider();

		const firstStream = streamCursorChat(createModel(), createContext(), {
			apiKey: "cursor-access-token",
		});
		const firstMockStream = asMockStream(firstStream);

		await waitFor(() => providerScenario.requests.length === 1);
		const firstRequest = providerScenario.requests[0]!;
		const firstRunRequest = getRunRequest(firstRequest);
		const promptBlobId =
			firstRunRequest.conversationState.rootPromptMessagesJson[0]!;
		const blobId = Uint8Array.from([0xaa, 0xbb, 0xcc]);
		const blobData = new TextEncoder().encode("blob-data");

		firstRequest.emit(
			"data",
			frameConnectMessage(
				encodeServerMessage(
					"kvServerMessage",
					create(KvServerMessageSchema, {
						id: 7,
						message: {
							case: "setBlobArgs",
							value: create(SetBlobArgsSchema, { blobId, blobData }),
						},
					}),
				),
			),
		);
		firstRequest.emit(
			"data",
			frameConnectMessage(
				encodeServerMessage(
					"conversationCheckpointUpdate",
					create(ConversationStateStructureSchema, {
						rootPromptMessagesJson: [promptBlobId],
						turns: [],
						todos: [],
						pendingToolCalls: [],
						previousWorkspaceUris: [],
						fileStates: {},
						fileStatesV2: {},
						summaryArchives: [],
						turnTimings: [],
						subagentStates: {},
						selfSummaryCount: 7,
						readPaths: ["/tmp/cached"],
					}),
				),
			),
		);
		firstRequest.emit(
			"data",
			frameConnectMessage(
				encodeServerMessage(
					"execServerMessage",
					create(ExecServerMessageSchema, { id: 11 }),
				),
			),
		);
		firstRequest.emit(
			"data",
			frameConnectMessage(
				encodeServerMessage(
					"execServerControlMessage",
					create(ExecServerControlMessageSchema, {}),
				),
			),
		);

		const queries = [
			[
				21,
				"askQuestionInteractionQuery",
				create(AskQuestionInteractionQuerySchema, {}),
			],
			[22, "switchModeRequestQuery", create(SwitchModeRequestQuerySchema, {})],
			[23, "webSearchRequestQuery", create(WebSearchRequestQuerySchema, {})],
			[24, "exaSearchRequestQuery", create(ExaSearchRequestQuerySchema, {})],
			[25, "exaFetchRequestQuery", create(ExaFetchRequestQuerySchema, {})],
			[26, "createPlanRequestQuery", create(CreatePlanRequestQuerySchema, {})],
			[27, "setupVmEnvironmentArgs", create(SetupVmEnvironmentArgsSchema, {})],
			[28, undefined, undefined],
		] as const;

		for (const [id, queryCase, value] of queries) {
			firstRequest.emit(
				"data",
				frameConnectMessage(
					encodeServerMessage(
						"interactionQuery",
						create(InteractionQuerySchema, {
							id,
							query: queryCase
								? {
										case: queryCase as never,
										value: value as never,
									}
								: ({ case: undefined } as never),
						}),
					),
				),
			);
		}

		firstRequest.emit("end");
		await waitFor(() => firstMockStream.ended);

		expect(providerScenario.execMessages).toHaveLength(1);
		expect(providerScenario.execControlMessages).toHaveLength(1);

		const firstMessages = decodeClientMessages(firstRequest.writes);
		expect(firstMessages[1]).toMatchObject({
			message: {
				case: "kvClientMessage",
				value: {
					id: 7,
					message: { case: "setBlobResult" },
				},
			},
		});
		const interactionResponses = firstMessages
			.slice(2)
			.map((message) => message.message.value as any);
		expect(interactionResponses).toHaveLength(7);
		expect(interactionResponses.map((response) => response.id)).toEqual([
			21, 22, 23, 24, 25, 26, 27,
		]);
		expect(interactionResponses[0]?.result.case).toBe(
			"askQuestionInteractionResponse",
		);
		expect(interactionResponses[0]?.result.value.result.result.case).toBe(
			"rejected",
		);
		expect(interactionResponses[1]?.result.case).toBe(
			"switchModeRequestResponse",
		);
		expect(interactionResponses[1]?.result.value.result.case).toBe("rejected");
		expect(interactionResponses[2]?.result.case).toBe(
			"webSearchRequestResponse",
		);
		expect(interactionResponses[2]?.result.value.result.case).toBe("rejected");
		expect(interactionResponses[3]?.result.case).toBe(
			"exaSearchRequestResponse",
		);
		expect(interactionResponses[3]?.result.value.result.case).toBe("rejected");
		expect(interactionResponses[4]?.result.case).toBe(
			"exaFetchRequestResponse",
		);
		expect(interactionResponses[4]?.result.value.result.case).toBe("rejected");
		expect(interactionResponses[5]?.result.case).toBe(
			"createPlanRequestResponse",
		);
		expect(interactionResponses[5]?.result.value.result.result.case).toBe(
			"error",
		);
		expect(interactionResponses[6]?.result.case).toBe(
			"setupVmEnvironmentResult",
		);
		expect(interactionResponses[6]?.result.value.result.case).toBe("success");

		const secondStream = streamCursorChat(createModel(), createContext(), {
			apiKey: "cursor-access-token",
		});
		const secondMockStream = asMockStream(secondStream);

		await waitFor(() => providerScenario.requests.length === 2);
		const secondRequest = providerScenario.requests[1]!;
		const secondRunRequest = getRunRequest(secondRequest);
		expect(secondRunRequest.conversationId).toBe(
			firstRunRequest.conversationId,
		);
		expect(secondRunRequest.conversationState.selfSummaryCount).toBe(7);
		expect(secondRunRequest.conversationState.readPaths).toEqual([
			"/tmp/cached",
		]);

		secondRequest.emit(
			"data",
			frameConnectMessage(
				encodeServerMessage(
					"kvServerMessage",
					create(KvServerMessageSchema, {
						id: 8,
						message: {
							case: "getBlobArgs",
							value: create(GetBlobArgsSchema, { blobId }),
						},
					}),
				),
			),
		);
		secondRequest.emit(
			"data",
			frameConnectMessage(
				encodeServerMessage(
					"interactionUpdate",
					create(InteractionUpdateSchema, {
						message: {
							case: "summary",
							value: create(SummaryUpdateSchema, { summary: "Done" }),
						},
					}),
				),
			),
		);
		secondRequest.emit(
			"data",
			frameConnectMessage(
				encodeServerMessage(
					"interactionUpdate",
					create(InteractionUpdateSchema, {
						message: {
							case: "tokenDelta",
							value: create(TokenDeltaUpdateSchema, { tokens: 3 }),
						},
					}),
				),
			),
		);
		secondRequest.emit("end");
		await waitFor(() => secondMockStream.ended);

		const secondMessages = decodeClientMessages(secondRequest.writes);
		expect(secondMessages[1]).toMatchObject({
			message: {
				case: "kvClientMessage",
				value: {
					id: 8,
					message: {
						case: "getBlobResult",
						value: { blobData },
					},
				},
			},
		});
		expect(secondMockStream.events).toContainEqual(
			expect.objectContaining({ type: "text_delta", delta: "Done" }),
		);

		resetCursorConversation();
		const thirdStream = streamCursorChat(createModel(), createContext(), {
			apiKey: "cursor-access-token",
		});
		const thirdMockStream = asMockStream(thirdStream);

		await waitFor(() => providerScenario.requests.length === 3);
		const thirdRequest = providerScenario.requests[2]!;
		const thirdRunRequest = getRunRequest(thirdRequest);
		expect(thirdRunRequest.conversationId).not.toBe(
			firstRunRequest.conversationId,
		);
		expect(thirdRunRequest.conversationState.selfSummaryCount).toBe(0);
		expect(thirdRunRequest.conversationState.readPaths).toEqual([]);

		thirdRequest.emit(
			"data",
			frameConnectMessage(
				encodeServerMessage(
					"kvServerMessage",
					create(KvServerMessageSchema, {
						id: 9,
						message: {
							case: "getBlobArgs",
							value: create(GetBlobArgsSchema, { blobId }),
						},
					}),
				),
			),
		);
		thirdRequest.emit("end");
		await waitFor(() => thirdMockStream.ended);

		const thirdMessages = decodeClientMessages(thirdRequest.writes);
		expect(thirdMessages[1]).toMatchObject({
			message: {
				case: "kvClientMessage",
				value: {
					id: 9,
					message: {
						case: "getBlobResult",
						value: {},
					},
				},
			},
		});
	});
});
