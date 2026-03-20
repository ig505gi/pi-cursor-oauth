import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderModelConfig,
} from "@mariozechner/pi-coding-agent";
import {
	createCursorExecBridge,
	setCursorExecBridge,
} from "./cursor-exec-bridge";
import {
	buildCursorExecMessage,
	CURSOR_EXEC_MESSAGE_TYPE,
	isCursorExecMessage,
	renderCursorExecMessage,
	shouldPersistCursorExecMessage,
} from "./cursor-exec-message";
import type { CursorExecUiMessage } from "./cursor-exec-ui";
import { setCursorExecUiSink } from "./cursor-exec-ui";
import {
	CURSOR_DEFAULT_BASE_URL,
	FALLBACK_MODELS,
	fetchCursorUsableModels,
} from "./cursor-models";
import { loginCursor, refreshCursorToken } from "./cursor-oauth";
import { resetCursorConversation, streamCursorChat } from "./cursor-provider";

const PROVIDER_NAME = "cursor";
const PROVIDER_API = "cursor-chat-api";
const STATUS_KEY = "cursor-oauth";
const EXEC_WIDGET_KEY = "cursor-exec";
const MAX_EXEC_WIDGET_EVENTS = 6;

let activeModels: ProviderModelConfig[] = FALLBACK_MODELS;
let syncInFlight: Promise<boolean> | null = null;
let execUi: ExtensionContext["ui"] | null = null;
let execEvents: CursorExecUiMessage[] = [];

function registerCursorProvider(
	pi: ExtensionAPI,
	models: ProviderModelConfig[],
): void {
	activeModels = models;
	pi.registerProvider(PROVIDER_NAME, {
		baseUrl: CURSOR_DEFAULT_BASE_URL,
		apiKey: "CURSOR_ACCESS_TOKEN",
		api: PROVIDER_API,
		models,
		oauth: {
			name: "Cursor",
			login: loginCursor,
			refreshToken: refreshCursorToken,
			getApiKey: (credentials) => credentials.access,
		},
		streamSimple: streamCursorChat,
	});
}

async function syncCursorModels(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	quiet = false,
): Promise<boolean> {
	if (syncInFlight) {
		return await syncInFlight;
	}

	syncInFlight = (async () => {
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
		if (!apiKey) {
			if (!quiet) {
				ctx.ui.notify(
					"No Cursor credentials found. Run /login cursor first.",
					"warning",
				);
			}
			return false;
		}

		const models = await fetchCursorUsableModels({
			apiKey,
			baseUrl: CURSOR_DEFAULT_BASE_URL,
		});
		if (!models || models.length === 0) {
			if (!quiet) {
				ctx.ui.notify(
					"Failed to fetch usable Cursor models. Keeping fallback model list.",
					"warning",
				);
			}
			return false;
		}

		registerCursorProvider(pi, models);
		if (!quiet) {
			ctx.ui.notify(`Registered ${models.length} Cursor models.`, "info");
		}
		return true;
	})();

	try {
		return await syncInFlight;
	} finally {
		syncInFlight = null;
	}
}

function trimPreview(
	text: string | undefined,
	maxLines = 2,
): string | undefined {
	if (!text) {
		return undefined;
	}
	const normalized = text.trim();
	if (!normalized) {
		return undefined;
	}
	const lines = normalized.split(/\r?\n/);
	if (lines.length <= maxLines) {
		return normalized;
	}
	return `${lines.slice(0, maxLines).join("\n")}\n…`;
}

function compactInline(
	text: string | undefined,
	maxChars = 96,
): string | undefined {
	const normalized = trimPreview(text, 1)?.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return undefined;
	}
	if (normalized.length <= maxChars) {
		return normalized;
	}
	return `${normalized.slice(0, maxChars - 1)}…`;
}

function formatCursorExecEvent(event: CursorExecUiMessage): string {
	const icon =
		event.status === "running"
			? "▶"
			: event.status === "success"
				? "✓"
				: event.status === "error"
					? "✗"
					: event.status === "rejected"
						? "!"
						: "•";
	const title = compactInline(event.title, 56) ?? event.tool;
	const summarySource =
		event.status === "running" ? event.body : (event.preview ?? event.body);
	const summary = compactInline(summarySource, 72);
	if (!summary || summary === title) {
		return `${icon} ${event.tool} ${title}`;
	}
	return `${icon} ${event.tool} ${title} — ${summary}`;
}

function renderCursorExecWidget(): void {
	if (!execUi) {
		return;
	}
	if (execEvents.length === 0) {
		execUi.setWidget(EXEC_WIDGET_KEY, undefined);
		return;
	}

	const lines = [
		"Cursor exec",
		...execEvents.slice(-MAX_EXEC_WIDGET_EVENTS).map(formatCursorExecEvent),
	];
	execUi.setWidget(EXEC_WIDGET_KEY, lines);
}

function bindCursorExecUi(ctx: ExtensionContext): void {
	execUi = ctx.hasUI ? ctx.ui : null;
	renderCursorExecWidget();
}

function resetCursorExecUi(): void {
	execEvents = [];
	execUi?.setWidget(EXEC_WIDGET_KEY, undefined);
}

function recordCursorExecEvent(event: CursorExecUiMessage): void {
	if (event.status !== "running") {
		for (let i = execEvents.length - 1; i >= 0; i--) {
			const existing = execEvents[i];
			if (
				existing.status === "running" &&
				existing.tool === event.tool &&
				existing.title === event.title
			) {
				execEvents[i] = event;
				renderCursorExecWidget();
				return;
			}
		}
	}

	execEvents.push(event);
	if (execEvents.length > MAX_EXEC_WIDGET_EVENTS) {
		execEvents = execEvents.slice(-MAX_EXEC_WIDGET_EVENTS);
	}
	renderCursorExecWidget();
}

function refreshCursorExecBridge(ctx: ExtensionContext): void {
	setCursorExecBridge(createCursorExecBridge(ctx.cwd));
	ctx.ui.setStatus(
		STATUS_KEY,
		ctx.model?.provider === PROVIDER_NAME
			? "Cursor exec bridge active"
			: undefined,
	);
}

function activateCursorSession(ctx: ExtensionContext): void {
	resetCursorConversation();
	bindCursorExecUi(ctx);
	resetCursorExecUi();
	refreshCursorExecBridge(ctx);
}

export default function (pi: ExtensionAPI) {
	registerCursorProvider(pi, activeModels);
	pi.registerMessageRenderer(CURSOR_EXEC_MESSAGE_TYPE, renderCursorExecMessage);
	setCursorExecUiSink((event) => {
		recordCursorExecEvent(event);
		if (shouldPersistCursorExecMessage(event)) {
			pi.sendMessage(buildCursorExecMessage(event), {
				deliverAs: "nextTurn",
			});
		}
	});

	pi.on("context", async (event) => {
		const messages = event.messages.filter(
			(message) => !isCursorExecMessage(message),
		);
		if (messages.length === event.messages.length) {
			return;
		}
		return { messages };
	});

	pi.registerCommand("cursor-sync-models", {
		description:
			"Fetch the current model list from Cursor and refresh the provider",
		handler: async (_args, ctx) => {
			await syncCursorModels(pi, ctx);
		},
	});

	pi.registerCommand("cursor-reset-conversation", {
		description:
			"Reset the cached Cursor conversation state for the current pi session",
		handler: async (_args, ctx) => {
			resetCursorConversation();
			ctx.ui.notify("Reset Cursor conversation state.", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		activateCursorSession(ctx);
		void syncCursorModels(pi, ctx, true);
	});

	pi.on("session_switch", async (_event, ctx) => {
		activateCursorSession(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		activateCursorSession(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		bindCursorExecUi(ctx);
		refreshCursorExecBridge(ctx);
		if (ctx.model?.provider === PROVIDER_NAME) {
			renderCursorExecWidget();
			void syncCursorModels(pi, ctx, true);
		} else {
			ctx.ui.setWidget(EXEC_WIDGET_KEY, undefined);
		}
	});

	pi.on("session_shutdown", async () => {
		resetCursorExecUi();
		setCursorExecBridge(null);
		setCursorExecUiSink(null);
		execUi = null;
	});
}
