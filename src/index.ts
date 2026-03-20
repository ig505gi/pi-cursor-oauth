import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderModelConfig,
} from "@mariozechner/pi-coding-agent";
import {
	createCursorExecBridge,
	setCursorExecBridge,
} from "./cursor-exec-bridge";
import type { CursorExecUiMessage } from "./cursor-exec-ui";
import { setCursorExecUiSink } from "./cursor-exec-ui";
import { createCursorExecWidget } from "./cursor-exec-widget";
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
const MAX_EXEC_WIDGET_RUNNING_EVENTS = 2;
const MAX_EXEC_EVENTS_HISTORY = 20;

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

function getVisibleCursorExecEvents(): CursorExecUiMessage[] {
	const running = execEvents.filter((event) => event.status === "running");
	if (running.length > 0) {
		const completed = execEvents.filter((event) => event.status !== "running");
		const latestCompleted = completed.at(-1);
		return [
			...running.slice(-MAX_EXEC_WIDGET_RUNNING_EVENTS),
			...(latestCompleted ? [latestCompleted] : []),
		];
	}
	const latestCompleted = execEvents.at(-1);
	return latestCompleted ? [latestCompleted] : [];
}

function renderCursorExecWidget(): void {
	if (!execUi) {
		return;
	}
	const visibleEvents = getVisibleCursorExecEvents();
	if (visibleEvents.length === 0) {
		execUi.setWidget(EXEC_WIDGET_KEY, undefined);
		return;
	}

	execUi.setWidget(EXEC_WIDGET_KEY, createCursorExecWidget(visibleEvents), {
		placement: "belowEditor",
	});
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
	if (execEvents.length > MAX_EXEC_EVENTS_HISTORY) {
		execEvents = execEvents.slice(-MAX_EXEC_EVENTS_HISTORY);
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
	setCursorExecUiSink((event) => {
		recordCursorExecEvent(event);
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.model?.provider === PROVIDER_NAME) {
			resetCursorExecUi();
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.model?.provider === PROVIDER_NAME && execEvents.length > 0) {
			resetCursorExecUi();
		}
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
