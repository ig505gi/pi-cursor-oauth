import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { createCursorExecBridge, setCursorExecBridge } from "./cursor-exec-bridge";
import { loginCursor, refreshCursorToken } from "./cursor-oauth";
import { CURSOR_DEFAULT_BASE_URL, FALLBACK_MODELS, fetchCursorUsableModels } from "./cursor-models";
import { resetCursorConversation, streamCursorChat } from "./cursor-provider";

const PROVIDER_NAME = "cursor";
const PROVIDER_API = "cursor-chat-api";
const STATUS_KEY = "cursor-oauth";

let activeModels: ProviderModelConfig[] = FALLBACK_MODELS;
let syncInFlight: Promise<boolean> | null = null;

function registerCursorProvider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
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
			getApiKey: credentials => credentials.access,
		},
		streamSimple: streamCursorChat,
	});
}

async function syncCursorModels(pi: ExtensionAPI, ctx: ExtensionContext, quiet = false): Promise<boolean> {
	if (syncInFlight) {
		return await syncInFlight;
	}

	syncInFlight = (async () => {
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
		if (!apiKey) {
			if (!quiet) {
				ctx.ui.notify("No Cursor credentials found. Run /login cursor first.", "warning");
			}
			return false;
		}

		const models = await fetchCursorUsableModels({ apiKey, baseUrl: CURSOR_DEFAULT_BASE_URL });
		if (!models || models.length === 0) {
			if (!quiet) {
				ctx.ui.notify("Failed to fetch usable Cursor models. Keeping fallback model list.", "warning");
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

function refreshCursorExecBridge(ctx: ExtensionContext): void {
	setCursorExecBridge(createCursorExecBridge(ctx.cwd));
	ctx.ui.setStatus(STATUS_KEY, ctx.model?.provider === PROVIDER_NAME ? "Cursor exec bridge active" : undefined);
}

export default function (pi: ExtensionAPI) {
	registerCursorProvider(pi, activeModels);

	pi.registerCommand("cursor-sync-models", {
		description: "Fetch the current model list from Cursor and refresh the provider",
		handler: async (_args, ctx) => {
			await syncCursorModels(pi, ctx);
		},
	});

	pi.registerCommand("cursor-reset-conversation", {
		description: "Reset the cached Cursor conversation state for the current pi session",
		handler: async (_args, ctx) => {
			resetCursorConversation();
			ctx.ui.notify("Reset Cursor conversation state.", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		resetCursorConversation();
		refreshCursorExecBridge(ctx);
		void syncCursorModels(pi, ctx, true);
	});

	pi.on("session_switch", async (_event, ctx) => {
		resetCursorConversation();
		refreshCursorExecBridge(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		resetCursorConversation();
		refreshCursorExecBridge(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		refreshCursorExecBridge(ctx);
		if (ctx.model?.provider === PROVIDER_NAME) {
			void syncCursorModels(pi, ctx, true);
		}
	});

	pi.on("session_shutdown", async () => {
		setCursorExecBridge(null);
	});
}
