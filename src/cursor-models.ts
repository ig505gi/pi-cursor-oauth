import * as http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { GetUsableModelsRequestSchema } from "./cursor-gen/agent_pb";
import { replaceCursorModelRouting } from "./cursor-model-routing";
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	decodeConnectUnaryBody,
	decodeGetUsableModelsResponse,
	normalizeCursorModels,
} from "./cursor-models-helpers";
import {
	decodeAvailableModelsResponse,
	encodeAvailableModelsRequest,
	type CursorModelParameter,
	type CursorParameterizedModel,
	type CursorParameterizedVariant,
} from "./cursor-wire";

export const CURSOR_DEFAULT_BASE_URL = "https://api2.cursor.sh";
export const CURSOR_DEFAULT_CLIENT_VERSION = "cli-2026.02.13-41ac335";
const CURSOR_GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
const CURSOR_AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";

export const FALLBACK_MODELS: ProviderModelConfig[] = [
	{
		id: "default",
		name: "Cursor Auto",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
	{
		id: "claude-4.5-sonnet",
		name: "Claude 4.5 Sonnet",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
	{
		id: "claude-4.5-sonnet-thinking",
		name: "Claude 4.5 Sonnet (Thinking)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
	{
		id: "claude-4.5-opus-high",
		name: "Claude 4.5 Opus",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
	{
		id: "claude-4.5-opus-high-thinking",
		name: "Claude 4.5 Opus (Thinking)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
	{
		id: "claude-4.6-opus-high",
		name: "Claude Opus 4.6",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-4.6-opus-high-thinking",
		name: "Claude Opus 4.6 Thinking",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-4.6-opus-max",
		name: "Claude Opus 4.6 Max",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "claude-4.6-opus-max-thinking",
		name: "Claude Opus 4.6 Max Thinking",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "gemini-3-pro",
		name: "Gemini 3 Pro",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
	{
		id: "gemini-3-flash",
		name: "Gemini 3 Flash",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
	{
		id: "gpt-5.2",
		name: "GPT-5.2",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
	{
		id: "gpt-5.2-high",
		name: "GPT-5.2 High",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
	{
		id: "gpt-5.3-codex",
		name: "GPT-5.3 Codex",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
	{
		id: "grok-code-fast-1",
		name: "Grok Code Fast 1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
	{
		id: "kimi-k2.5",
		name: "Kimi K2.5",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	},
];

interface CursorModelDiscoveryOptions {
	apiKey: string;
	baseUrl?: string;
	clientVersion?: string;
	timeoutMs?: number;
}

function zeroCost() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function parameterValue(
	parameters: CursorModelParameter[],
	id: string,
): string | undefined {
	return parameters.find((parameter) => parameter.id === id)?.value;
}

function contextWindowFromParameter(
	value: string | undefined,
	fallback: number,
): number {
	if (!value) return fallback;
	const k = value.match(/^(\d+)k$/i)?.[1];
	if (k) return Number(k) * 1_000;
	const m = value.match(/^(\d+)m$/i)?.[1];
	if (m) return Number(m) * 1_000_000;
	return fallback;
}

function variantId(
	model: CursorParameterizedModel,
	variant: CursorParameterizedVariant,
): string {
	const parts = [model.name];
	const context = parameterValue(variant.parameters, "context");
	const effort =
		parameterValue(variant.parameters, "reasoning") ??
		parameterValue(variant.parameters, "effort");
	const thinking = parameterValue(variant.parameters, "thinking") === "true";
	const fast = parameterValue(variant.parameters, "fast") === "true";

	if (context && !["200k", "272k", "300k"].includes(context.toLowerCase())) {
		parts.push(context.toLowerCase());
	}
	if (variant.isMaxMode && !/(^|-)max($|-)/i.test(model.name)) {
		parts.push("max-mode");
	}
	if (effort && effort !== "medium") parts.push(effort.toLowerCase());
	if (thinking) parts.push("thinking");
	if (fast) parts.push("fast");
	return parts.join("-");
}

function parameterizedModelsToPiModels(
	models: CursorParameterizedModel[],
): ProviderModelConfig[] {
	const byId = new Map<string, ProviderModelConfig>();
	const routing: Array<
		[string, { modelId: string; parameters?: CursorModelParameter[]; maxMode?: boolean }]
	> = [];

	for (const model of models) {
		const displayName = model.clientDisplayName || model.name;
		const fallbackContext = model.contextTokenLimit ?? DEFAULT_CONTEXT_WINDOW;
		if (model.variants.length === 0) {
			byId.set(model.name, {
				id: model.name,
				name: displayName,
				reasoning: /claude|gpt|gemini|grok|composer/i.test(model.name),
				input: model.supportsImages === false ? ["text"] : ["text", "image"],
				cost: zeroCost(),
				contextWindow: fallbackContext,
				maxTokens: DEFAULT_MAX_TOKENS,
			});
			routing.push([model.name, { modelId: model.name }]);
			continue;
		}

		for (const variant of model.variants) {
			const id = variantId(model, variant);
			const context = contextWindowFromParameter(
				parameterValue(variant.parameters, "context"),
				variant.isMaxMode
					? (model.contextTokenLimitForMaxMode ?? fallbackContext)
					: fallbackContext,
			);
			const effort =
				parameterValue(variant.parameters, "reasoning") ??
				parameterValue(variant.parameters, "effort");
			const thinking = parameterValue(variant.parameters, "thinking") === "true";
			const fast = parameterValue(variant.parameters, "fast") === "true";
			const name = [
				displayName,
				variant.displayNameOutsidePicker || variant.displayName,
				effort && effort !== "medium" ? effort : undefined,
				thinking ? "Thinking" : undefined,
				fast ? "Fast" : undefined,
			]
				.filter(Boolean)
				.join(" ");

			byId.set(id, {
				id,
				name,
				reasoning: Boolean(effort) || thinking || /claude|gpt|gemini|grok|composer/i.test(model.name),
				input: model.supportsImages === false ? ["text"] : ["text", "image"],
				cost: zeroCost(),
				contextWindow: context,
				maxTokens: DEFAULT_MAX_TOKENS,
			});
			routing.push([
				id,
				{
					modelId: model.name,
					parameters: variant.parameters,
					maxMode: variant.isMaxMode,
				},
			]);
		}
	}

	replaceCursorModelRouting(routing);
	return [...byId.values()];
}

export async function fetchCursorUsableModels(
	options: CursorModelDiscoveryOptions,
): Promise<ProviderModelConfig[] | null> {
	const timeoutMs = options.timeoutMs ?? 5000;
	const baseUrl = (options.baseUrl ?? CURSOR_DEFAULT_BASE_URL).replace(/\/+$/, "");
	const rawRequest = create(GetUsableModelsRequestSchema, { customModelIds: [] });
	const [rawResponse, parameterizedResponse] = await Promise.all([
		fetchViaHttp2(
			baseUrl,
			CURSOR_GET_USABLE_MODELS_PATH,
			toBinary(GetUsableModelsRequestSchema, rawRequest),
			options,
			timeoutMs,
		),
		fetchViaHttp2(
			baseUrl,
			CURSOR_AVAILABLE_MODELS_PATH,
			encodeAvailableModelsRequest(),
			options,
			timeoutMs,
		),
	]);

	const rawDecoded = rawResponse ? decodeGetUsableModelsResponse(rawResponse) : null;
	const rawModels =
		rawDecoded && Array.isArray((rawDecoded as { models?: unknown[] }).models)
			? normalizeCursorModels(rawDecoded.models!, FALLBACK_MODELS)
			: [];

	let parameterizedModels: ProviderModelConfig[] = [];
	if (parameterizedResponse) {
		try {
			const body = decodeConnectUnaryBody(parameterizedResponse) ?? parameterizedResponse;
			parameterizedModels = parameterizedModelsToPiModels(
				decodeAvailableModelsResponse(body),
			);
		} catch {
			parameterizedModels = [];
		}
	}

	const byId = new Map<string, ProviderModelConfig>();
	for (const model of rawModels) byId.set(model.id, model);
	for (const model of parameterizedModels) byId.set(model.id, model);
	if (byId.size === 0) return null;
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function buildRequestHeaders(
	options: CursorModelDiscoveryOptions,
): Record<string, string> {
	return {
		"content-type": "application/proto",
		te: "trailers",
		authorization: `Bearer ${options.apiKey}`,
		"x-ghost-mode": "true",
		"x-cursor-client-version": options.clientVersion ?? CURSOR_DEFAULT_CLIENT_VERSION,
		"x-cursor-client-type": "cli",
	};
}

async function fetchViaHttp2(
	baseUrl: string,
	path: string,
	body: Uint8Array,
	options: CursorModelDiscoveryOptions,
	timeoutMs: number,
): Promise<Uint8Array | null> {
	const { promise, resolve } = Promise.withResolvers<Uint8Array | null>();
	const client = http2.connect(baseUrl);
	let settled = false;
	const finish = (value: Uint8Array | null) => {
		if (settled) return;
		settled = true;
		resolve(value);
	};

	const timer = setTimeout(() => {
		client.destroy();
		finish(null);
	}, timeoutMs);

	client.on("error", () => {
		clearTimeout(timer);
		finish(null);
	});

	const req = client.request({
		":method": "POST",
		":path": path,
		...buildRequestHeaders(options),
	});

	const chunks: Buffer[] = [];
	let ok = true;

	req.on("response", (headers) => {
		const status = Number(headers[":status"] ?? 0);
		if (status < 200 || status >= 300) ok = false;
	});
	req.on("data", (chunk: Buffer) => chunks.push(chunk));
	req.on("end", () => {
		clearTimeout(timer);
		client.close();
		finish(ok ? new Uint8Array(Buffer.concat(chunks)) : null);
	});
	req.on("error", () => {
		clearTimeout(timer);
		client.close();
		finish(null);
	});

	req.end(body.length > 0 ? Buffer.from(body) : undefined);
	return promise;
}
