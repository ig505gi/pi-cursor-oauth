import * as http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingContent,
} from "@mariozechner/pi-ai";
import {
	handleExecServerControlMessage,
	handleExecServerMessage,
} from "./cursor-exec-bridge";
import {
	AgentClientMessageSchema,
	type AgentServerMessage,
	AgentServerMessageSchema,
	AskQuestionInteractionResponseSchema,
	AskQuestionRejectedSchema,
	AskQuestionResultSchema,
	ClientHeartbeatSchema,
	type ConversationStateStructure,
	CreatePlanErrorSchema,
	CreatePlanRequestResponseSchema,
	CreatePlanResultSchema,
	ExaFetchRequestResponse_RejectedSchema,
	ExaFetchRequestResponseSchema,
	ExaSearchRequestResponse_RejectedSchema,
	ExaSearchRequestResponseSchema,
	GetBlobResultSchema,
	InteractionResponseSchema,
	KvClientMessageSchema,
	SetBlobResultSchema,
	SetupVmEnvironmentResultSchema,
	SetupVmEnvironmentSuccessSchema,
	SwitchModeRequestResponse_RejectedSchema,
	SwitchModeRequestResponseSchema,
	WebSearchRequestResponse_RejectedSchema,
	WebSearchRequestResponseSchema,
} from "./cursor-gen/agent_pb";
import {
	type BlockState,
	buildGrpcRequest,
	handleConversationCheckpointUpdate,
	parseConnectEndStream,
	processInteractionUpdate,
	type UsageState,
} from "./cursor-provider-helpers";

export const CURSOR_API_URL = "https://api2.cursor.sh";
export const CURSOR_CLIENT_VERSION = "cli-2026.01.09-231024f";

const CONNECT_END_STREAM_FLAG = 0b00000010;

const conversationStateCache = new Map<string, ConversationStateStructure>();
const conversationBlobStores = new Map<string, Map<string, Uint8Array>>();
let currentConversationId = crypto.randomUUID();

export function resetCursorConversation(): void {
	currentConversationId = crypto.randomUUID();
	conversationStateCache.clear();
	conversationBlobStores.clear();
}

export function streamCursorChat(
	model: Model<Api>,
	context: { systemPrompt?: string; messages: Message[] },
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
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
		};

		let h2Client: http2.ClientHttp2Session | null = null;
		let h2Request: http2.ClientHttp2Stream | null = null;
		let heartbeatTimer: NodeJS.Timeout | null = null;
		let firstTokenTime: number | undefined;

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(
					"Cursor API key (access token) is required. Run /login cursor.",
				);
			}

			const blobStore =
				conversationBlobStores.get(currentConversationId) ??
				new Map<string, Uint8Array>();
			conversationBlobStores.set(currentConversationId, blobStore);
			const cachedState = conversationStateCache.get(currentConversationId);
			const { requestBytes, conversationState } = buildGrpcRequest(
				model,
				context,
				{
					conversationId: currentConversationId,
					blobStore,
					conversationState: cachedState,
				},
			);
			conversationStateCache.set(currentConversationId, conversationState);

			h2Client = http2.connect(model.baseUrl || CURSOR_API_URL);
			h2Request = h2Client.request({
				":method": "POST",
				":path": "/agent.v1.AgentService/Run",
				"content-type": "application/connect+proto",
				"connect-protocol-version": "1",
				te: "trailers",
				authorization: `Bearer ${apiKey}`,
				"x-ghost-mode": "true",
				"x-cursor-client-version": CURSOR_CLIENT_VERSION,
				"x-cursor-client-type": "cli",
				"x-request-id": crypto.randomUUID(),
			});

			stream.push({ type: "start", partial: output });

			let pendingBuffer = Buffer.alloc(0);
			let endStreamError: Error | null = null;
			let currentTextBlock: (TextContent & { index: number }) | null = null;
			let currentThinkingBlock: (ThinkingContent & { index: number }) | null =
				null;
			const usageState: UsageState = { sawTokenDelta: false };

			const state: BlockState = {
				get currentTextBlock() {
					return currentTextBlock;
				},
				get currentThinkingBlock() {
					return currentThinkingBlock;
				},
				get firstTokenTime() {
					return firstTokenTime;
				},
				setTextBlock: (block) => {
					currentTextBlock = block;
				},
				setThinkingBlock: (block) => {
					currentThinkingBlock = block;
				},
				setFirstTokenTime: () => {
					if (!firstTokenTime) {
						firstTokenTime = Date.now();
					}
				},
			};

			const onConversationCheckpoint = (
				checkpoint: ConversationStateStructure,
			) => {
				conversationStateCache.set(currentConversationId, checkpoint);
			};

			h2Request.on("data", (chunk: Buffer) => {
				pendingBuffer = Buffer.concat([pendingBuffer, chunk]);

				while (pendingBuffer.length >= 5) {
					const flags = pendingBuffer[0];
					const msgLen = pendingBuffer.readUInt32BE(1);
					if (pendingBuffer.length < 5 + msgLen) {
						break;
					}

					const messageBytes = pendingBuffer.subarray(5, 5 + msgLen);
					pendingBuffer = pendingBuffer.subarray(5 + msgLen);

					if (flags & CONNECT_END_STREAM_FLAG) {
						const endError = parseConnectEndStream(messageBytes);
						if (endError) {
							endStreamError = endError;
							h2Request?.close();
						}
						continue;
					}

					try {
						const serverMessage = fromBinary(
							AgentServerMessageSchema,
							messageBytes,
						);
						void handleServerMessage(
							serverMessage,
							output,
							stream,
							state,
							blobStore,
							h2Request!,
							usageState,
							onConversationCheckpoint,
						).catch(() => {
							// Let the stream continue; exec bridge sends protocol errors back to Cursor directly.
						});
					} catch {
						// Ignore malformed frames and let the server close the stream if needed.
					}
				}
			});

			h2Request.write(frameConnectMessage(requestBytes));

			const sendHeartbeat = () => {
				if (!h2Request || h2Request.closed) {
					return;
				}
				const heartbeatMessage = create(AgentClientMessageSchema, {
					message: {
						case: "clientHeartbeat",
						value: create(ClientHeartbeatSchema, {}),
					},
				});
				h2Request.write(
					frameConnectMessage(
						toBinary(AgentClientMessageSchema, heartbeatMessage),
					),
				);
			};
			heartbeatTimer = setInterval(sendHeartbeat, 5000);

			const { promise, resolve, reject } = Promise.withResolvers<void>();
			h2Request.on("trailers", (trailers) => {
				const status = trailers["grpc-status"];
				const message = trailers["grpc-message"];
				if (status && status !== "0") {
					reject(
						new Error(
							`gRPC error ${status}: ${decodeURIComponent(String(message || ""))}`,
						),
					);
				}
			});
			h2Request.on("end", () => {
				if (endStreamError) {
					reject(endStreamError);
					return;
				}
				resolve();
			});
			h2Request.on("error", reject);
			options?.signal?.addEventListener(
				"abort",
				() => {
					h2Request?.close();
					reject(new Error("Request was aborted"));
				},
				{ once: true },
			);

			await promise;

			if (state.currentTextBlock) {
				const idx = output.content.indexOf(state.currentTextBlock);
				delete (state.currentTextBlock as { index?: number }).index;
				stream.push({
					type: "text_end",
					contentIndex: idx,
					content: state.currentTextBlock.text,
					partial: output,
				});
			}
			if (state.currentThinkingBlock) {
				const idx = output.content.indexOf(state.currentThinkingBlock);
				delete (state.currentThinkingBlock as { index?: number }).index;
				stream.push({
					type: "thinking_end",
					contentIndex: idx,
					content: state.currentThinkingBlock.thinking,
					partial: output,
				});
			}

			calculateCost(model, output.usage);
			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage =
				error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			if (heartbeatTimer) {
				clearInterval(heartbeatTimer);
			}
			h2Request?.close();
			h2Client?.close();
		}
	})();

	return stream;
}

async function handleServerMessage(
	msg: AgentServerMessage,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	blobStore: Map<string, Uint8Array>,
	h2Request: http2.ClientHttp2Stream,
	usageState: UsageState,
	onConversationCheckpoint?: (checkpoint: ConversationStateStructure) => void,
): Promise<void> {
	const msgCase = msg.message.case;
	if (msgCase === "interactionUpdate") {
		processInteractionUpdate(
			msg.message.value,
			output,
			stream,
			state,
			usageState,
		);
		return;
	}
	if (msgCase === "kvServerMessage") {
		handleKvServerMessage(msg.message.value, blobStore, h2Request);
		return;
	}
	if (msgCase === "execServerMessage") {
		await handleExecServerMessage(msg.message.value, h2Request);
		return;
	}
	if (msgCase === "execServerControlMessage") {
		handleExecServerControlMessage(msg.message.value);
		return;
	}
	if (msgCase === "interactionQuery") {
		handleInteractionQuery(msg.message.value, h2Request);
		return;
	}
	if (msgCase === "conversationCheckpointUpdate") {
		handleConversationCheckpointUpdate(
			msg.message.value,
			output,
			usageState,
			onConversationCheckpoint,
		);
	}
}

function handleInteractionQuery(
	query: { id?: number; query?: { case?: string; value?: any } },
	h2Request: http2.ClientHttp2Stream,
): void {
	const queryCase = query.query?.case;
	const reason =
		"This Cursor interaction query is not supported by the pi-cursor-oauth bridge.";
	let resultCase: string;
	let resultValue: unknown;

	if (queryCase === "askQuestionInteractionQuery") {
		resultCase = "askQuestionInteractionResponse";
		resultValue = create(AskQuestionInteractionResponseSchema, {
			result: create(AskQuestionResultSchema, {
				result: {
					case: "rejected",
					value: create(AskQuestionRejectedSchema, { reason }),
				},
			}),
		});
	} else if (queryCase === "switchModeRequestQuery") {
		resultCase = "switchModeRequestResponse";
		resultValue = create(SwitchModeRequestResponseSchema, {
			result: {
				case: "rejected",
				value: create(SwitchModeRequestResponse_RejectedSchema, { reason }),
			},
		});
	} else if (queryCase === "webSearchRequestQuery") {
		resultCase = "webSearchRequestResponse";
		resultValue = create(WebSearchRequestResponseSchema, {
			result: {
				case: "rejected",
				value: create(WebSearchRequestResponse_RejectedSchema, { reason }),
			},
		});
	} else if (queryCase === "exaSearchRequestQuery") {
		resultCase = "exaSearchRequestResponse";
		resultValue = create(ExaSearchRequestResponseSchema, {
			result: {
				case: "rejected",
				value: create(ExaSearchRequestResponse_RejectedSchema, { reason }),
			},
		});
	} else if (queryCase === "exaFetchRequestQuery") {
		resultCase = "exaFetchRequestResponse";
		resultValue = create(ExaFetchRequestResponseSchema, {
			result: {
				case: "rejected",
				value: create(ExaFetchRequestResponse_RejectedSchema, { reason }),
			},
		});
	} else if (queryCase === "createPlanRequestQuery") {
		resultCase = "createPlanRequestResponse";
		resultValue = create(CreatePlanRequestResponseSchema, {
			result: create(CreatePlanResultSchema, {
				planUri: "",
				result: {
					case: "error",
					value: create(CreatePlanErrorSchema, { error: reason }),
				},
			}),
		});
	} else if (queryCase === "setupVmEnvironmentArgs") {
		resultCase = "setupVmEnvironmentResult";
		resultValue = create(SetupVmEnvironmentResultSchema, {
			result: {
				case: "success",
				value: create(SetupVmEnvironmentSuccessSchema, {}),
			},
		});
	} else {
		return;
	}

	const response = create(AgentClientMessageSchema, {
		message: {
			case: "interactionResponse",
			value: create(InteractionResponseSchema, {
				id: query.id ?? 0,
				result: { case: resultCase as never, value: resultValue as never },
			}),
		},
	});
	h2Request.write(
		frameConnectMessage(toBinary(AgentClientMessageSchema, response)),
	);
}

function handleKvServerMessage(
	kvMsg: { id?: number; message?: { case?: string; value?: any } },
	blobStore: Map<string, Uint8Array>,
	h2Request: http2.ClientHttp2Stream,
): void {
	const kvCase = kvMsg.message?.case;
	if (kvCase === "getBlobArgs") {
		const blobId = kvMsg.message?.value?.blobId as Uint8Array;
		const blobIdKey = Buffer.from(blobId).toString("hex");
		const blobData = blobStore.get(blobIdKey);
		const response = create(AgentClientMessageSchema, {
			message: {
				case: "kvClientMessage",
				value: create(KvClientMessageSchema, {
					id: kvMsg.id,
					message: {
						case: "getBlobResult",
						value: create(GetBlobResultSchema, blobData ? { blobData } : {}),
					},
				}),
			},
		});
		h2Request.write(
			frameConnectMessage(toBinary(AgentClientMessageSchema, response)),
		);
		return;
	}
	if (kvCase === "setBlobArgs") {
		const blobId = kvMsg.message?.value?.blobId as Uint8Array;
		const blobData = kvMsg.message?.value?.blobData as Uint8Array;
		blobStore.set(Buffer.from(blobId).toString("hex"), blobData);
		const response = create(AgentClientMessageSchema, {
			message: {
				case: "kvClientMessage",
				value: create(KvClientMessageSchema, {
					id: kvMsg.id,
					message: {
						case: "setBlobResult",
						value: create(SetBlobResultSchema, {}),
					},
				}),
			},
		});
		h2Request.write(
			frameConnectMessage(toBinary(AgentClientMessageSchema, response)),
		);
	}
}

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}
