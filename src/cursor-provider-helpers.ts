import { createHash } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Message,
	Model,
	TextContent,
	ThinkingContent,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import {
	AgentClientMessageSchema,
	AgentConversationTurnStructureSchema,
	AgentRunRequestSchema,
	AssistantMessageSchema,
	ConversationActionSchema,
	type ConversationStateStructure,
	ConversationStateStructureSchema,
	ConversationStepSchema,
	ConversationTurnStructureSchema,
	ModelDetailsSchema,
	UserMessageActionSchema,
	UserMessageSchema,
} from "./cursor-gen/agent_pb";

export interface BlockState {
	currentTextBlock: (TextContent & { index: number }) | null;
	currentThinkingBlock: (ThinkingContent & { index: number }) | null;
	firstTokenTime: number | undefined;
	setTextBlock: (block: (TextContent & { index: number }) | null) => void;
	setThinkingBlock: (
		block: (ThinkingContent & { index: number }) | null,
	) => void;
	setFirstTokenTime: () => void;
}

export interface UsageState {
	sawTokenDelta: boolean;
}

export function buildGrpcRequest(
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
	const userText =
		lastRole === "user" || lastRole === "developer"
			? extractUserMessageText(lastMessage)
			: "";
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
	const hasMatchingPrompt =
		state.conversationState?.rootPromptMessagesJson?.some((entry) =>
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

export function buildConversationTurns(messages: Message[]): Uint8Array[] {
	const turns: Uint8Array[] = [];
	let index = 0;

	while (index < messages.length) {
		const message = messages[index];
		const messageRole = getMessageRole(message);
		if (messageRole !== "user" && messageRole !== "developer") {
			index += 1;
			continue;
		}

		let isLastUserMessage = true;
		for (
			let nextIndex = index + 1;
			nextIndex < messages.length;
			nextIndex += 1
		) {
			const nextRole = getMessageRole(messages[nextIndex]);
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
			index += 1;
			continue;
		}

		const userMessage = create(UserMessageSchema, {
			text: userText,
			messageId: crypto.randomUUID(),
		});
		const userMessageBytes = toBinary(UserMessageSchema, userMessage);
		const stepBytes: Uint8Array[] = [];
		index += 1;

		while (index < messages.length) {
			const stepMessage = messages[index];
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
							value: create(AssistantMessageSchema, {
								text: `[Tool Result]\n${text}`,
							}),
						},
					});
					stepBytes.push(toBinary(ConversationStepSchema, step));
				}
			}
			index += 1;
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

export function extractUserMessageText(message: Message | undefined): string {
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
	return message.content
		.map((item) => {
			if (item.type === "text") {
				return item.text;
			}
			if (item.type === "image") {
				return `[${item.mimeType} image omitted]`;
			}
			return `[${item.type} omitted]`;
		})
		.join("\n")
		.trim();
}

export function extractAssistantMessageText(message: Message): string {
	if (message.role !== "assistant") {
		return "";
	}
	return message.content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
}

export function toolResultToText(toolResult: ToolResultMessage): string {
	return toolResult.content
		.map((item) =>
			item.type === "text" ? item.text : `[${item.mimeType} image]`,
		)
		.join("\n");
}

export function processInteractionUpdate(
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
		if (!delta) {
			return;
		}
		if (state.currentThinkingBlock) {
			const index = output.content.indexOf(state.currentThinkingBlock);
			delete (state.currentThinkingBlock as { index?: number }).index;
			stream.push({
				type: "thinking_end",
				contentIndex: index,
				content: state.currentThinkingBlock.thinking,
				partial: output,
			});
			state.setThinkingBlock(null);
		}
		if (!state.currentTextBlock) {
			const block: TextContent & { index: number } = {
				type: "text",
				text: "",
				index: output.content.length,
			};
			output.content.push(block);
			state.setTextBlock(block);
			stream.push({
				type: "text_start",
				contentIndex: output.content.length - 1,
				partial: output,
			});
		}
		const currentTextBlock = state.currentTextBlock;
		if (!currentTextBlock) {
			return;
		}
		currentTextBlock.text += delta;
		stream.push({
			type: "text_delta",
			contentIndex: output.content.indexOf(currentTextBlock),
			delta,
			partial: output,
		});
		return;
	}

	if (updateCase === "thinkingDelta") {
		state.setFirstTokenTime();
		const delta = update.message?.value?.text || "";
		if (!delta) {
			return;
		}
		if (state.currentTextBlock) {
			const index = output.content.indexOf(state.currentTextBlock);
			delete (state.currentTextBlock as { index?: number }).index;
			stream.push({
				type: "text_end",
				contentIndex: index,
				content: state.currentTextBlock.text,
				partial: output,
			});
			state.setTextBlock(null);
		}
		if (!state.currentThinkingBlock) {
			const block: ThinkingContent & { index: number } = {
				type: "thinking",
				thinking: "",
				index: output.content.length,
			};
			output.content.push(block);
			state.setThinkingBlock(block);
			stream.push({
				type: "thinking_start",
				contentIndex: output.content.length - 1,
				partial: output,
			});
		}
		const currentThinkingBlock = state.currentThinkingBlock;
		if (!currentThinkingBlock) {
			return;
		}
		currentThinkingBlock.thinking += delta;
		stream.push({
			type: "thinking_delta",
			contentIndex: output.content.indexOf(currentThinkingBlock),
			delta,
			partial: output,
		});
		return;
	}

	if (updateCase === "thinkingCompleted") {
		if (!state.currentThinkingBlock) {
			return;
		}
		const index = output.content.indexOf(state.currentThinkingBlock);
		delete (state.currentThinkingBlock as { index?: number }).index;
		stream.push({
			type: "thinking_end",
			contentIndex: index,
			content: state.currentThinkingBlock.thinking,
			partial: output,
		});
		state.setThinkingBlock(null);
		return;
	}

	if (updateCase === "summary") {
		state.setFirstTokenTime();
		const summary = update.message?.value?.summary || "";
		if (!summary) {
			return;
		}
		if (state.currentThinkingBlock) {
			const index = output.content.indexOf(state.currentThinkingBlock);
			delete (state.currentThinkingBlock as { index?: number }).index;
			stream.push({
				type: "thinking_end",
				contentIndex: index,
				content: state.currentThinkingBlock.thinking,
				partial: output,
			});
			state.setThinkingBlock(null);
		}
		if (!state.currentTextBlock) {
			const block: TextContent & { index: number } = {
				type: "text",
				text: "",
				index: output.content.length,
			};
			output.content.push(block);
			state.setTextBlock(block);
			stream.push({
				type: "text_start",
				contentIndex: output.content.length - 1,
				partial: output,
			});
		}
		const currentTextBlock = state.currentTextBlock;
		if (!currentTextBlock) {
			return;
		}
		const current = currentTextBlock.text;
		if (summary === current) {
			return;
		}
		let delta = "";
		if (summary.startsWith(current)) {
			delta = summary.slice(current.length);
		} else if (!current) {
			delta = summary;
		} else if (!current.includes(summary)) {
			delta = `${current.endsWith("\n") ? "" : "\n"}${summary}`;
		}
		if (!delta) {
			return;
		}
		currentTextBlock.text += delta;
		stream.push({
			type: "text_delta",
			contentIndex: output.content.indexOf(currentTextBlock),
			delta,
			partial: output,
		});
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
		output.usage.totalTokens =
			output.usage.input +
			output.usage.output +
			output.usage.cacheRead +
			output.usage.cacheWrite;
	}
}

export function handleConversationCheckpointUpdate(
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
	output.usage.totalTokens =
		output.usage.input +
		output.usage.output +
		output.usage.cacheRead +
		output.usage.cacheWrite;
}

export function parseConnectEndStream(data: Uint8Array): Error | null {
	try {
		const payload = JSON.parse(new TextDecoder().decode(data)) as {
			error?: { code?: string; message?: string };
		};
		const error = payload.error;
		if (error) {
			return new Error(
				`Connect error ${error.code ?? "unknown"}: ${error.message ?? "Unknown error"}`,
			);
		}
		return null;
	} catch {
		return new Error("Failed to parse Connect end stream");
	}
}

function getMessageRole(message: Message): string {
	return (message as Message & { role: string }).role;
}

function createBlobId(data: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(data).digest());
}
