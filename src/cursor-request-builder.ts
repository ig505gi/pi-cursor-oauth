import { createHash } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import type { Api, Message, Model } from "@mariozechner/pi-ai";
import {
	AgentClientMessageSchema,
	AgentRunRequestSchema,
	ConversationActionSchema,
	type ConversationStateStructure,
	ConversationStateStructureSchema,
	RequestedModel_ModelParameterbytesSchema,
	RequestedModelSchema,
	UserMessageActionSchema,
	UserMessageSchema,
} from "./cursor-gen/agent_pb";
import { getCursorModelRouting } from "./cursor-model-routing";
import {
	buildConversationTurns,
	extractUserMessageText,
} from "./cursor-provider-helpers";

function createBlobId(data: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(data).digest());
}

function getMessageRole(message: Message | undefined): string | undefined {
	return message?.role;
}

export function buildCursorGrpcRequest(
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
	const lastRole = getMessageRole(lastMessage);
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

	const routing = getCursorModelRouting(model.id);
	const parameters = (routing.parameters ?? []).map((parameter) =>
		create(RequestedModel_ModelParameterbytesSchema, parameter),
	);
	const requestedModel = create(RequestedModelSchema, {
		modelId: routing.modelId,
		maxMode: routing.maxMode ?? false,
		parameters,
	});
	const runRequest = create(AgentRunRequestSchema, {
		conversationState,
		action,
		requestedModel,
		conversationId: state.conversationId,
	});

	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "runRequest", value: runRequest },
	});
	const requestBytes = toBinary(AgentClientMessageSchema, clientMessage);
	return { requestBytes, blobStore, conversationState };
}
