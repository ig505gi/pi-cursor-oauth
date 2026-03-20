import * as http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import {
	GetUsableModelsRequestSchema,
	GetUsableModelsResponseSchema,
} from "./cursor-gen/agent_pb";

export const CURSOR_DEFAULT_BASE_URL = "https://api2.cursor.sh";
const CURSOR_DEFAULT_CLIENT_VERSION = "cli-2026.02.13-41ac335";
const CURSOR_GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

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

interface CursorModelDetailsLike {
	modelId?: unknown;
	displayName?: unknown;
	displayNameShort?: unknown;
	displayModelId?: unknown;
	aliases?: unknown;
	thinkingDetails?: unknown;
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

	const references = new Map(FALLBACK_MODELS.map((model) => [model.id, model]));
	const byId = new Map<string, ProviderModelConfig>();
	for (const rawModel of decoded.models!) {
		const normalized = normalizeCursorModel(rawModel, references);
		if (normalized) {
			byId.set(normalized.id, normalized);
		}
	}

	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeCursorModel(
	rawModel: unknown,
	references: Map<string, ProviderModelConfig>,
): ProviderModelConfig | null {
	if (!rawModel || typeof rawModel !== "object") {
		return null;
	}
	const model = rawModel as CursorModelDetailsLike;
	const id = typeof model.modelId === "string" ? model.modelId.trim() : "";
	if (!id) {
		return null;
	}

	const reference = references.get(id);
	const name = pickModelDisplayName(model, id);
	const input = reference?.input ?? inferInputTypes(id, name);
	const reasoning =
		typeof model.thinkingDetails !== "undefined"
			? true
			: (reference?.reasoning ?? inferReasoning(id, name));

	return {
		id,
		name,
		reasoning,
		input,
		cost: reference?.cost ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: reference?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: reference?.maxTokens ?? DEFAULT_MAX_TOKENS,
	};
}

function pickModelDisplayName(
	model: CursorModelDetailsLike,
	fallbackId: string,
): string {
	const aliases = Array.isArray(model.aliases) ? model.aliases : [];
	const candidates = [
		model.displayName,
		model.displayNameShort,
		model.displayModelId,
		...aliases,
		fallbackId,
	];
	for (const candidate of candidates) {
		if (typeof candidate !== "string") {
			continue;
		}
		const trimmed = candidate.trim();
		if (trimmed) {
			return trimmed;
		}
	}
	return fallbackId;
}

function inferInputTypes(id: string, name: string): Array<"text" | "image"> {
	const haystack = `${id} ${name}`.toLowerCase();
	if (
		haystack.includes("vision") ||
		haystack.includes("vl") ||
		haystack.includes("gemini") ||
		haystack.includes("gpt") ||
		haystack.includes("claude")
	) {
		return ["text", "image"];
	}
	return ["text"];
}

function inferReasoning(id: string, name: string): boolean {
	const haystack = `${id} ${name}`.toLowerCase();
	return (
		haystack.includes("thinking") ||
		haystack.includes("reason") ||
		haystack.includes("opus") ||
		haystack.includes("pro") ||
		haystack.includes("gpt-5") ||
		haystack.includes("grok") ||
		haystack.includes("kimi")
	);
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

function decodeGetUsableModelsResponse(
	payload: Uint8Array,
): { models?: unknown[] } | null {
	if (payload.length === 0) {
		return null;
	}

	const framedBody = decodeConnectUnaryBody(payload);
	const body = framedBody ?? payload;
	try {
		return fromBinary(GetUsableModelsResponseSchema, body) as {
			models?: unknown[];
		};
	} catch {
		return null;
	}
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
	if (payload.length < 5) {
		return null;
	}

	let offset = 0;
	while (offset + 5 <= payload.length) {
		const flags = payload[offset];
		const view = new DataView(
			payload.buffer,
			payload.byteOffset + offset,
			payload.byteLength - offset,
		);
		const messageLength = view.getUint32(1, false);
		const frameEnd = offset + 5 + messageLength;
		if (frameEnd > payload.length) {
			return null;
		}
		const compressionFlagSet = (flags & 0b0000_0001) !== 0;
		if (compressionFlagSet) {
			return null;
		}
		const endStreamFlagSet = (flags & 0b0000_0010) !== 0;
		if (!endStreamFlagSet) {
			return payload.subarray(offset + 5, frameEnd);
		}
		offset = frameEnd;
	}

	return null;
}
