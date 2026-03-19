import { createHash } from "node:crypto";
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
	type ToolResultMessage,
} from "@mariozechner/pi-ai";
import {
	AgentClientMessageSchema,
	AgentConversationTurnStructureSchema,
	AgentRunRequestSchema,
	type AgentServerMessage,
	AgentServerMessageSchema,
	AskQuestionInteractionResponseSchema,
	AskQuestionRejectedSchema,
	AskQuestionResultSchema,
	AssistantMessageSchema,
	ClientHeartbeatSchema,
	ConversationActionSchema,
	CreatePlanErrorSchema,
	CreatePlanRequestResponseSchema,
	CreatePlanResultSchema,
	type ConversationStateStructure,
	ConversationStateStructureSchema,
	ConversationStepSchema,
	ConversationTurnStructureSchema,
	ExaFetchRequestResponseSchema,
	ExaFetchRequestResponse_RejectedSchema,
	ExaSearchRequestResponseSchema,
	ExaSearchRequestResponse_RejectedSchema,
	GetBlobResultSchema,
	InteractionResponseSchema,
	KvClientMessageSchema,
	ModelDetailsSchema,
	SetBlobResultSchema,
	SetupVmEnvironmentResultSchema,
	SetupVmEnvironmentSuccessSchema,
	SwitchModeRequestResponseSchema,
	SwitchModeRequestResponse_RejectedSchema,
	UserMessageActionSchema,
	UserMessageSchema,
	WebSearchRequestResponseSchema,
	WebSearchRequestResponse_RejectedSchema,
} from "./cursor-gen/agent_pb";
import { handleExecServerControlMessage, handleExecServerMessage } from "./cursor-exec-bridge";

export const CURSOR_API_URL = "https://api2.cursor.sh";
export const CURSOR_CLIENT_VERSION = "cli-2026.01.09-231024f";

const CONNECT_END_STREAM_FLAG = 0b00000010;

const conversationStateCache = new Map<string, ConversationStateStructure>();
const conversationBlobStores = new Map<string, Map<string, Uint8Array>>();
let currentConversationId = crypto.randomUUID();

interface BlockState {
	currentTextBlock: (TextContent & { index: number }) | null;
	currentThinkingBlock: (ThinkingContent & { index: number }) | null;
	firstTokenTime: number | undefined;
	setTextBlock: (block: (TextContent & { index: number }) | null) => void;
	setThinkingBlock: (block: (ThinkingContent & { index: number }) | null) => void;
	setFirstTokenTime: () => void;
}

interface UsageState {
	sawTokenDelta: boolean;
}

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
				throw new Error("Cursor API key (access token) is required. Run /login cursor.");
			}

			const blobStore = conversationBlobStores.get(currentConversationId) ?? new Map<string, Uint8Array>();
			conversationBlobStores.set(currentConversationId, blobStore);
			const cachedState = conversationStateCache.get(currentConversationId);
			const { requestBytes, conversationState } = buildGrpcRequest(model, context, {
				conversationId: currentConversationId,
				blobStore,
				conversationState: cachedState,
			});
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
			let currentThinkingBlock: (ThinkingContent & { index: number }) | null = null;
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

			const onConversationCheckpoint = (checkpoint: ConversationStateStructure) => {
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
						const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
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
					message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
				});
				h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, heartbeatMessage)));
			};
			heartbeatTimer = setInterval(sendHeartbeat, 5000);

			const { promise, resolve, reject } = Promise.withResolvers<void>();
			h2Request.on("trailers", (trailers) => {
				const status = trailers["grpc-status"];
				const message = trailers["grpc-message"];
				if (status && status !== "0") {
					reject(new Error(`gRPC error ${status}: ${decodeURIComponent(String(message || ""))}`));
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
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
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
		processInteractionUpdate(msg.message.value, output, stream, state, usageState);
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
		handleConversationCheckpointUpdate(msg.message.value, output, usageState, onConversationCheckpoint);
	}
}

function handleInteractionQuery(
	query: { id?: number; query?: { case?: string; value?: any } },
	h2Request: http2.ClientHttp2Stream,
): void {
	const queryCase = query.query?.case;
	const reason = "This Cursor interaction query is not supported by the pi-cursor-oauth bridge.";
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
			result: { case: "success", value: create(SetupVmEnvironmentSuccessSchema, {}) },
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
	h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, response)));
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
		h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, response)));
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
		h2Request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, response)));
	}
}

function processInteractionUpdate(
	update: { message?: { case?: string; value?: any } },
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	usageState: UsageState,
): void {
	const updateCase = update.message?.case;

	if (updateCase === "textDelta") {
		state.setFirstTokenTime();
		const delta = update.message?.value?.text || "";
		if (!state.currentTextBlock) {
			const block: TextContent & { index: number } = {
				type: "text",
				text: "",
				index: output.content.length,
			};
			output.content.push(block);
			state.setTextBlock(block);
			stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
		}
		state.currentTextBlock.text += delta;
		stream.push({
			type: "text_delta",
			contentIndex: output.content.indexOf(state.currentTextBlock),
			delta,
			partial: output,
		});
		return;
	}

	if (updateCase === "thinkingDelta") {
		state.setFirstTokenTime();
		const delta = update.message?.value?.text || "";
		if (!state.currentThinkingBlock) {
			const block: ThinkingContent & { index: number } = {
				type: "thinking",
				thinking: "",
				index: output.content.length,
			};
			output.content.push(block);
			state.setThinkingBlock(block);
			stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
		}
		state.currentThinkingBlock.thinking += delta;
		stream.push({
			type: "thinking_delta",
			contentIndex: output.content.indexOf(state.currentThinkingBlock),
			delta,
			partial: output,
		});
		return;
	}

	if (updateCase === "thinkingCompleted") {
		if (!state.currentThinkingBlock) {
			return;
		}
		const idx = output.content.indexOf(state.currentThinkingBlock);
		delete (state.currentThinkingBlock as { index?: number }).index;
		stream.push({
			type: "thinking_end",
			contentIndex: idx,
			content: state.currentThinkingBlock.thinking,
			partial: output,
		});
		state.setThinkingBlock(null);
		return;
	}

	if (updateCase === "turnEnded") {
		output.stopReason = "stop";
		return;
	}

	if (updateCase === "tokenDelta") {
		const tokens = Number(update.message?.value?.tokens || 0);
		usageState.sawTokenDelta = true;
		output.usage.output += tokens;
		output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	}
}

function handleConversationCheckpointUpdate(
	checkpoint: ConversationStateStructure,
	output: AssistantMessage,
	usageState: UsageState,
	onConversationCheckpoint?: (checkpoint: ConversationStateStructure) => void,
): void {
	onConversationCheckpoint?.(checkpoint);
	if (usageState.sawTokenDelta) {
		return;
	}
	const usedTokens = Number(checkpoint.tokenDetails?.usedTokens ?? 0);
	if (usedTokens <= 0) {
		return;
	}
	output.usage.output = usedTokens;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
}

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function parseConnectEndStream(data: Uint8Array): Error | null {
	try {
		const payload = JSON.parse(new TextDecoder().decode(data)) as { error?: { code?: string; message?: string } };
		const error = payload.error;
		if (error) {
			return new Error(`Connect error ${error.code ?? "unknown"}: ${error.message ?? "Unknown error"}`);
		}
		return null;
	} catch {
		return new Error("Failed to parse Connect end stream");
	}
}

function buildGrpcRequest(
	model: Model<Api>,
	context: { systemPrompt?: string; messages: Message[] },
	state: {
		conversationId: string;
		blobStore: Map<string, Uint8Array>;
		conversationState?: ConversationStateStructure;
	},
): {
	requestBytes: Uint8Array;
	blobStore: Map<string, Uint8Array>;
	conversationState: ConversationStateStructure;
} {
	const blobStore = state.blobStore;
	const systemPromptJson = JSON.stringify({
		role: "system",
		content: context.systemPrompt || "You are a helpful assistant.",
	});
	const systemPromptBytes = new TextEncoder().encode(systemPromptJson);
	const systemPromptId = createBlobId(systemPromptBytes);
	blobStore.set(Buffer.from(systemPromptId).toString("hex"), systemPromptBytes);

	const lastMessage = context.messages[context.messages.length - 1];
	const lastRole = lastMessage ? getMessageRole(lastMessage) : undefined;
	const userText = lastRole === "user" || lastRole === "developer" ? extractUserMessageText(lastMessage) : "";
	if (!userText) {
		throw new Error("Cannot send empty user message to Cursor API");
	}

	const userMessage = create(UserMessageSchema, {
		text: userText,
		messageId: crypto.randomUUID(),
	});
	const action = create(ConversationActionSchema, {
		action: {
			case: "userMessageAction",
			value: create(UserMessageActionSchema, { userMessage }),
		},
	});

	const turns = buildConversationTurns(context.messages);
	const hasMatchingPrompt = state.conversationState?.rootPromptMessagesJson?.some((entry) =>
		Buffer.from(entry).equals(systemPromptId),
	);

	const baseState =
		state.conversationState && hasMatchingPrompt
			? state.conversationState
			: create(ConversationStateStructureSchema, {
					rootPromptMessagesJson: [systemPromptId],
					turns: [],
					todos: [],
					pendingToolCalls: [],
					previousWorkspaceUris: [],
					fileStates: {},
					fileStatesV2: {},
					summaryArchives: [],
					turnTimings: [],
					subagentStates: {},
					selfSummaryCount: 0,
					readPaths: [],
				});

	const conversationState = create(ConversationStateStructureSchema, {
		...baseState,
		turns: turns.length > 0 ? turns : baseState.turns,
	});

	const modelDetails = create(ModelDetailsSchema, {
		modelId: model.id,
		displayModelId: model.id,
		displayName: model.name,
	});
	const runRequest = create(AgentRunRequestSchema, {
		conversationState,
		action,
		modelDetails,
		conversationId: state.conversationId,
	});

	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "runRequest", value: runRequest },
	});
	const requestBytes = toBinary(AgentClientMessageSchema, clientMessage);
	return { requestBytes, blobStore, conversationState };
}

function buildConversationTurns(messages: Message[]): Uint8Array[] {
	const turns: Uint8Array[] = [];
	let i = 0;

	while (i < messages.length) {
		const message = messages[i];
		const messageRole = getMessageRole(message);
		if (messageRole !== "user" && messageRole !== "developer") {
			i += 1;
			continue;
		}

		let isLastUserMessage = true;
		for (let j = i + 1; j < messages.length; j += 1) {
			const nextRole = getMessageRole(messages[j]);
			if (nextRole === "user" || nextRole === "developer") {
				isLastUserMessage = false;
				break;
			}
		}
		if (isLastUserMessage) {
			break;
		}

		const userText = extractUserMessageText(message);
		if (!userText) {
			i += 1;
			continue;
		}

		const userMessage = create(UserMessageSchema, {
			text: userText,
			messageId: crypto.randomUUID(),
		});
		const userMessageBytes = toBinary(UserMessageSchema, userMessage);
		const stepBytes: Uint8Array[] = [];
		i += 1;

		while (i < messages.length) {
			const stepMessage = messages[i];
			const stepRole = getMessageRole(stepMessage);
			if (stepRole === "user" || stepRole === "developer") {
				break;
			}
			if (stepMessage.role === "assistant") {
				const text = extractAssistantMessageText(stepMessage);
				if (text) {
					const step = create(ConversationStepSchema, {
						message: {
							case: "assistantMessage",
							value: create(AssistantMessageSchema, { text }),
						},
					});
					stepBytes.push(toBinary(ConversationStepSchema, step));
				}
			} else if (stepMessage.role === "toolResult") {
				const text = toolResultToText(stepMessage);
				if (text) {
					const step = create(ConversationStepSchema, {
						message: {
							case: "assistantMessage",
							value: create(AssistantMessageSchema, { text: `[Tool Result]\n${text}` }),
						},
					});
					stepBytes.push(toBinary(ConversationStepSchema, step));
				}
			}
			i += 1;
		}

		const agentTurn = create(AgentConversationTurnStructureSchema, {
			userMessage: userMessageBytes,
			steps: stepBytes,
		});
		const turn = create(ConversationTurnStructureSchema, {
			turn: {
				case: "agentConversationTurn",
				value: agentTurn,
			},
		});
		turns.push(toBinary(ConversationTurnStructureSchema, turn));
	}

	return turns;
}

function getMessageRole(message: Message): string {
	return (message as Message & { role: string }).role;
}

function extractUserMessageText(message: Message | undefined): string {
	if (!message) {
		return "";
	}
	const role = getMessageRole(message);
	if (role !== "user" && role !== "developer") {
		return "";
	}
	if (typeof message.content === "string") {
		return message.content.trim();
	}
	const text = message.content
		.map((item) => {
			if (item.type === "text") {
				return item.text;
			}
			return `[${item.mimeType} image omitted]`;
		})
		.join("\n")
		.trim();
	return text;
}

function extractAssistantMessageText(message: Message): string {
	if (message.role !== "assistant") {
		return "";
	}
	return message.content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
}

function toolResultToText(toolResult: ToolResultMessage): string {
	return toolResult.content.map((item) => (item.type === "text" ? item.text : `[${item.mimeType} image]`)).join("\n");
}

function createBlobId(data: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(data).digest());
}
