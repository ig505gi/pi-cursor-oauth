import { describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { GetUsableModelsResponseSchema } from "../src/cursor-gen/agent_pb";
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	decodeConnectUnaryBody,
	decodeGetUsableModelsResponse,
	inferInputTypes,
	inferReasoning,
	normalizeCursorModel,
	normalizeCursorModels,
	pickModelDisplayName,
} from "../src/cursor-models-helpers";

function frameConnectMessage(data: Uint8Array, flags = 0): Uint8Array {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return new Uint8Array(frame);
}

describe("cursor-models-helpers", () => {
	test("pickModelDisplayName prefers the first non-empty string candidate", () => {
		expect(
			pickModelDisplayName(
				{
					displayName: " Cursor Auto ",
					displayNameShort: "Short name",
					displayModelId: "model-id",
					aliases: ["alias"],
				},
				"fallback-id",
			),
		).toBe("Cursor Auto");

		expect(
			pickModelDisplayName(
				{
					displayName: " ",
					displayNameShort: "\t",
					displayModelId: "",
					aliases: [null, " ", "alias-name", 42],
				},
				"fallback-id",
			),
		).toBe("alias-name");

		expect(
			pickModelDisplayName(
				{
					displayName: null,
					displayNameShort: undefined,
					displayModelId: 123,
					aliases: "not-an-array",
				},
				"fallback-id",
			),
		).toBe("fallback-id");

		expect(
			pickModelDisplayName(
				{
					displayName: " ",
					displayNameShort: "\t",
					displayModelId: "",
					aliases: [],
				},
				"",
			),
		).toBe("");
	});

	test("inferInputTypes recognizes image-capable models and defaults to text", () => {
		expect(inferInputTypes("custom-vision-model", "Custom Model")).toEqual([
			"text",
			"image",
		]);
		expect(inferInputTypes("custom-model", "Fancy VL Assistant")).toEqual([
			"text",
			"image",
		]);
		expect(inferInputTypes("gemini-lite", "Gemini Lite")).toEqual([
			"text",
			"image",
		]);
		expect(inferInputTypes("gpt-4.1-mini", "GPT 4.1 Mini")).toEqual([
			"text",
			"image",
		]);
		expect(inferInputTypes("claude-4.5-sonnet", "Claude 4.5 Sonnet")).toEqual([
			"text",
			"image",
		]);
		expect(inferInputTypes("plain-text-model", "Plain Text Model")).toEqual([
			"text",
		]);
	});

	test("inferReasoning recognizes reasoning-oriented models and defaults to false", () => {
		expect(inferReasoning("thinking-model", "Model")).toBe(true);
		expect(inferReasoning("custom-model", "Reasoning Variant")).toBe(true);
		expect(inferReasoning("claude-opus", "Claude Opus")).toBe(true);
		expect(inferReasoning("gemini-pro", "Gemini Pro")).toBe(true);
		expect(inferReasoning("gpt-5.2", "GPT-5.2")).toBe(true);
		expect(inferReasoning("grok-code-fast-1", "Grok Code Fast 1")).toBe(true);
		expect(inferReasoning("kimi-k2.5", "Kimi K2.5")).toBe(true);
		expect(inferReasoning("plain-model", "Plain Model")).toBe(false);
	});

	test("normalizeCursorModel rejects invalid input and applies defaults without a reference", () => {
		const references = new Map<string, ProviderModelConfig>();

		expect(normalizeCursorModel(null, references)).toBe(null);
		expect(normalizeCursorModel("not-an-object", references)).toBe(null);
		expect(
			normalizeCursorModel(
				{
					modelId: " ",
					displayName: "Ignored",
				},
				references,
			),
		).toBe(null);

		expect(
			normalizeCursorModel(
				{
					modelId: "plain-text-model",
					displayName: " ",
					displayNameShort: "\t",
					displayModelId: "",
					aliases: [" ", "Plain Text Model"],
				},
				references,
			),
		).toEqual({
			id: "plain-text-model",
			name: "Plain Text Model",
			reasoning: false,
			input: ["text"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			maxTokens: DEFAULT_MAX_TOKENS,
		});
	});

	test("normalizeCursorModel reuses reference metadata and lets thinkingDetails force reasoning", () => {
		const referenceModel: ProviderModelConfig = {
			id: "reference-model",
			name: "Reference Model",
			reasoning: false,
			input: ["text", "image"],
			cost: {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
			},
			contextWindow: 1234,
			maxTokens: 567,
		};
		const references = new Map<string, ProviderModelConfig>([
			[referenceModel.id, referenceModel],
		]);

		expect(
			normalizeCursorModel(
				{
					modelId: "reference-model",
					displayName: " ",
					displayNameShort: "",
					displayModelId: "reference-model-display",
				},
				references,
			),
		).toEqual({
			id: "reference-model",
			name: "reference-model-display",
			reasoning: false,
			input: ["text", "image"],
			cost: {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
			},
			contextWindow: 1234,
			maxTokens: 567,
		});

		expect(
			normalizeCursorModel(
				{
					modelId: "reference-model",
					aliases: ["Reference Alias"],
					thinkingDetails: {},
				},
				references,
			),
		).toEqual({
			id: "reference-model",
			name: "Reference Alias",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
			},
			contextWindow: 1234,
			maxTokens: 567,
		});
	});

	test("normalizeCursorModels ignores invalid entries, sorts results, and preserves reference metadata", () => {
		const fallbackModels: ProviderModelConfig[] = [
			{
				id: "fallback-model",
				name: "Fallback Model",
				reasoning: false,
				input: ["text", "image"],
				cost: {
					input: 9,
					output: 8,
					cacheRead: 7,
					cacheWrite: 6,
				},
				contextWindow: 4321,
				maxTokens: 876,
			},
		];

		const models = normalizeCursorModels(
			[
				null,
				{
					modelId: "z-model",
					displayName: "Z Model",
				},
				{
					modelId: "fallback-model",
					displayName: "First Fallback Name",
				},
				{
					modelId: "fallback-model",
					displayNameShort: "Final Fallback Name",
				},
				{
					modelId: " ",
					displayName: "ignored",
				},
				{
					modelId: "a-model",
					displayModelId: "A Model",
				},
			],
			fallbackModels,
		);

		expect(models).toEqual([
			{
				id: "a-model",
				name: "A Model",
				reasoning: false,
				input: ["text"],
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				contextWindow: DEFAULT_CONTEXT_WINDOW,
				maxTokens: DEFAULT_MAX_TOKENS,
			},
			{
				id: "fallback-model",
				name: "Final Fallback Name",
				reasoning: false,
				input: ["text", "image"],
				cost: {
					input: 9,
					output: 8,
					cacheRead: 7,
					cacheWrite: 6,
				},
				contextWindow: 4321,
				maxTokens: 876,
			},
			{
				id: "z-model",
				name: "Z Model",
				reasoning: false,
				input: ["text"],
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				contextWindow: DEFAULT_CONTEXT_WINDOW,
				maxTokens: DEFAULT_MAX_TOKENS,
			},
		]);
	});

	test("decodeConnectUnaryBody returns the first data frame after optional trailers and rejects invalid frames", () => {
		const payload = Uint8Array.from([1, 2, 3, 4]);
		const trailers = Uint8Array.from([9, 9]);
		const framedPayload = frameConnectMessage(payload);
		const framedWithTrailers = new Uint8Array(
			frameConnectMessage(trailers, 0b0000_0010).length + framedPayload.length,
		);
		framedWithTrailers.set(frameConnectMessage(trailers, 0b0000_0010), 0);
		framedWithTrailers.set(
			framedPayload,
			frameConnectMessage(trailers, 0b0000_0010).length,
		);

		expect(decodeConnectUnaryBody(framedPayload)).toEqual(payload);
		expect(decodeConnectUnaryBody(framedWithTrailers)).toEqual(payload);
		expect(
			decodeConnectUnaryBody(frameConnectMessage(payload, 0b0000_0001)),
		).toBe(null);
		expect(decodeConnectUnaryBody(framedPayload.subarray(0, 6))).toBe(null);
		expect(
			decodeConnectUnaryBody(frameConnectMessage(trailers, 0b0000_0010)),
		).toBe(null);
	});

	test("decodeGetUsableModelsResponse handles framed and unframed protobuf payloads and rejects invalid input", () => {
		const body = toBinary(
			GetUsableModelsResponseSchema,
			create(GetUsableModelsResponseSchema, {
				models: [{ modelId: "default", displayName: "Cursor Auto" }] as any,
			}),
		);

		expect(decodeGetUsableModelsResponse(body)).toMatchObject({
			models: [expect.objectContaining({ modelId: "default" })],
		});
		expect(
			decodeGetUsableModelsResponse(frameConnectMessage(body)),
		).toMatchObject({
			models: [expect.objectContaining({ modelId: "default" })],
		});
		expect(decodeGetUsableModelsResponse(new Uint8Array())).toBe(null);
		expect(decodeGetUsableModelsResponse(Uint8Array.from([1, 2, 3]))).toBe(
			null,
		);
	});
});
