import { fromBinary } from "@bufbuild/protobuf";
import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { GetUsableModelsResponseSchema } from "./cursor-gen/agent_pb";

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_TOKENS = 64_000;

export interface CursorModelDetailsLike {
	modelId?: unknown;
	displayName?: unknown;
	displayNameShort?: unknown;
	displayModelId?: unknown;
	aliases?: unknown;
	thinkingDetails?: unknown;
}

export function normalizeCursorModels(
	rawModels: unknown[],
	fallbackModels: ProviderModelConfig[] = [],
): ProviderModelConfig[] {
	const references = new Map(fallbackModels.map((model) => [model.id, model]));
	const byId = new Map<string, ProviderModelConfig>();

	for (const rawModel of rawModels) {
		const normalized = normalizeCursorModel(rawModel, references);
		if (normalized) {
			byId.set(normalized.id, normalized);
		}
	}

	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function normalizeCursorModel(
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

export function pickModelDisplayName(
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

export function inferInputTypes(
	id: string,
	name: string,
): Array<"text" | "image"> {
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

export function inferReasoning(id: string, name: string): boolean {
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

export function decodeGetUsableModelsResponse(
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

export function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
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
		if ((flags & 0b0000_0001) !== 0) {
			return null;
		}
		if ((flags & 0b0000_0010) === 0) {
			return payload.subarray(offset + 5, frameEnd);
		}
		offset = frameEnd;
	}

	return null;
}
