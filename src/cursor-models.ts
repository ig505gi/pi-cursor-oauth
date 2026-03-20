import * as http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { GetUsableModelsRequestSchema } from "./cursor-gen/agent_pb";
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	decodeGetUsableModelsResponse,
	normalizeCursorModels,
} from "./cursor-models-helpers";

export const CURSOR_DEFAULT_BASE_URL = "https://api2.cursor.sh";
const CURSOR_DEFAULT_CLIENT_VERSION = "cli-2026.02.13-41ac335";
const CURSOR_GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";

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

export async function fetchCursorUsableModels(
	options: CursorModelDiscoveryOptions,
): Promise<ProviderModelConfig[] | null> {
	const timeoutMs = options.timeoutMs ?? 5000;
	const requestPayload = create(GetUsableModelsRequestSchema, {
		customModelIds: [],
	});
	const body = toBinary(GetUsableModelsRequestSchema, requestPayload);
	const baseUrl = (options.baseUrl ?? CURSOR_DEFAULT_BASE_URL).replace(
		/\/+$/,
		"",
	);
	const responseBuffer = await fetchViaHttp2(baseUrl, body, options, timeoutMs);
	if (!responseBuffer) {
		return null;
	}

	const decoded = decodeGetUsableModelsResponse(responseBuffer);
	if (!decoded || !Array.isArray((decoded as { models?: unknown[] }).models)) {
		return null;
	}
	return normalizeCursorModels(decoded.models!, FALLBACK_MODELS);
}

function buildRequestHeaders(
	options: CursorModelDiscoveryOptions,
): Record<string, string> {
	return {
		"content-type": "application/proto",
		te: "trailers",
		authorization: `Bearer ${options.apiKey}`,
		"x-ghost-mode": "true",
		"x-cursor-client-version":
			options.clientVersion ?? CURSOR_DEFAULT_CLIENT_VERSION,
		"x-cursor-client-type": "cli",
	};
}

async function fetchViaHttp2(
	baseUrl: string,
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
		":path": CURSOR_GET_USABLE_MODELS_PATH,
		...buildRequestHeaders(options),
	});

	const chunks: Buffer[] = [];
	let ok = true;

	req.on("response", (headers) => {
		const status = Number(headers[":status"] ?? 0);
		if (status < 200 || status >= 300) {
			ok = false;
		}
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
