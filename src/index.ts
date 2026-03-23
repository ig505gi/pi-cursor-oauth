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
	CURSOR_DEFAULT_BASE_URL,
	FALLBACK_MODELS,
	fetchCursorUsableModels,
} from "./cursor-models";
import { loginCursor, refreshCursorToken } from "./cursor-oauth";
import { resetCursorConversation, streamCursorChat } from "./cursor-provider";
import { installPiNativeToolHack } from "./pi-native-tool-hack";

const PROVIDER_NAME = "cursor";
const PROVIDER_API = "cursor-chat-api";
const STATUS_KEY = "cursor-oauth";

export interface CursorExtensionDeps {
	baseUrl: string;
	fallbackModels: ProviderModelConfig[];
	fetchCursorUsableModels: typeof fetchCursorUsableModels;
	loginCursor: typeof loginCursor;
	refreshCursorToken: typeof refreshCursorToken;
	streamCursorChat: typeof streamCursorChat;
	resetCursorConversation: typeof resetCursorConversation;
	createCursorExecBridge: typeof createCursorExecBridge;
	setCursorExecBridge: typeof setCursorExecBridge;
	installPiNativeToolHack: typeof installPiNativeToolHack;
}

const defaultCursorExtensionDeps: CursorExtensionDeps = {
	baseUrl: CURSOR_DEFAULT_BASE_URL,
	fallbackModels: FALLBACK_MODELS,
	fetchCursorUsableModels,
	loginCursor,
	refreshCursorToken,
	streamCursorChat,
	resetCursorConversation,
	createCursorExecBridge,
	setCursorExecBridge,
	installPiNativeToolHack,
};

export function createCursorExtension(
	deps: CursorExtensionDeps = defaultCursorExtensionDeps,
) {
	let activeModels: ProviderModelConfig[] = deps.fallbackModels;
	let syncInFlight: Promise<boolean> | null = null;

	function registerCursorProvider(
		pi: ExtensionAPI,
		models: ProviderModelConfig[],
	): void {
		activeModels = models;
		pi.registerProvider(PROVIDER_NAME, {
			baseUrl: deps.baseUrl,
			apiKey: "CURSOR_ACCESS_TOKEN",
			api: PROVIDER_API,
			models,
			oauth: {
				name: "Cursor",
				login: deps.loginCursor,
				refreshToken: deps.refreshCursorToken,
				getApiKey: (credentials) => credentials.access,
			},
			streamSimple: deps.streamCursorChat,
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
			const apiKey =
				await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
			if (!apiKey) {
				if (!quiet) {
					ctx.ui.notify(
						"No Cursor credentials found. Run /login cursor first.",
						"warning",
					);
				}
				return false;
			}

			const models = await deps.fetchCursorUsableModels({
				apiKey,
				baseUrl: deps.baseUrl,
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

	function refreshCursorExecBridge(ctx: ExtensionContext): void {
		deps.setCursorExecBridge(deps.createCursorExecBridge(ctx.cwd));
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	function activateCursorSession(ctx: ExtensionContext): void {
		deps.resetCursorConversation();
		refreshCursorExecBridge(ctx);
	}

	return function activate(pi: ExtensionAPI) {
		registerCursorProvider(pi, activeModels);
		void deps.installPiNativeToolHack().catch((error) => {
			console.warn(
				"[pi-cursor-oauth] Failed to install native tool hack:\n%s",
				error instanceof Error ? error.message : String(error),
			);
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
				deps.resetCursorConversation();
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
			refreshCursorExecBridge(ctx);
			if (ctx.model?.provider === PROVIDER_NAME) {
				void syncCursorModels(pi, ctx, true);
			}
		});

		pi.on("session_shutdown", async () => {
			deps.setCursorExecBridge(null);
		});
	};
}

export default createCursorExtension();
