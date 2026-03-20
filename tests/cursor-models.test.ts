import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { create, toBinary } from "@bufbuild/protobuf";
import { GetUsableModelsResponseSchema } from "../src/cursor-gen/agent_pb";
import {
	decodeConnectUnaryBody,
	decodeGetUsableModelsResponse,
	normalizeCursorModels,
} from "../src/cursor-models-helpers";

function frameConnectMessage(data: Uint8Array, flags = 0): Uint8Array {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return new Uint8Array(frame);
}

const http2Scenario: {
	status: number;
	body: Uint8Array | null;
	requestError: Error | null;
	clientError: Error | null;
} = {
	status: 200,
	body: null,
	requestError: null,
	clientError: null,
};

mock.module("node:http2", () => ({
	connect: mock(() => {
		const client = new EventEmitter() as EventEmitter & {
			close: ReturnType<typeof mock>;
			destroy: ReturnType<typeof mock>;
			request: () => EventEmitter & { end: (body?: Buffer) => void };
		};
		client.close = mock(() => {});
		client.destroy = mock(() => {});
		client.request = () => {
			const request = new EventEmitter() as EventEmitter & {
				end: (body?: Buffer) => void;
			};
			request.end = () => {
				queueMicrotask(() => {
					if (http2Scenario.clientError) {
						client.emit("error", http2Scenario.clientError);
						return;
					}
					if (http2Scenario.requestError) {
						request.emit("error", http2Scenario.requestError);
						return;
					}
					request.emit("response", {
						":status": http2Scenario.status,
					});
					if (http2Scenario.body) {
						request.emit("data", Buffer.from(http2Scenario.body));
					}
					request.emit("end");
				});
			};
			return request;
		};
		return client;
	}),
}));

describe("cursor-models", () => {
	beforeEach(() => {
		http2Scenario.status = 200;
		http2Scenario.body = null;
		http2Scenario.requestError = null;
		http2Scenario.clientError = null;
	});

	afterEach(() => {
		mock.restore();
	});

	test("decodeConnectUnaryBody handles framed payloads and rejects invalid frames", () => {
		const payload = Uint8Array.from([1, 2, 3, 4]);

		expect(decodeConnectUnaryBody(frameConnectMessage(payload))).toEqual(
			payload,
		);
		expect(
			decodeConnectUnaryBody(frameConnectMessage(payload, 0b0000_0001)),
		).toBe(null);
		expect(
			decodeConnectUnaryBody(frameConnectMessage(payload).subarray(0, 6)),
		).toBe(null);
		expect(decodeConnectUnaryBody(Uint8Array.from([1, 2, 3, 4]))).toBe(null);
	});

	test("decodeGetUsableModelsResponse reads framed protobuf responses", () => {
		const body = toBinary(
			GetUsableModelsResponseSchema,
			create(GetUsableModelsResponseSchema, {
				models: [{ modelId: "default", displayName: "Cursor Auto" }] as any,
			}),
		);

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

	test("normalizeCursorModels deduplicates, sorts, and infers model details", () => {
		const models = normalizeCursorModels([
			{
				modelId: "custom-vl-model",
				aliases: ["Vision Alias"],
			},
			{
				modelId: "claude-4.5-sonnet-thinking",
				displayNameShort: " Claude 4.5 Sonnet (Thinking) ",
			},
			{
				modelId: "grok-code-fast-1",
				displayName: "Grok Code Fast 1",
			},
			{
				modelId: "custom-vl-model",
				displayModelId: "custom-vl-model-final",
				thinkingDetails: {},
			},
			{
				modelId: " ",
				displayName: "ignored",
			},
		]);

		expect(models.map((model) => model.id)).toEqual([
			"claude-4.5-sonnet-thinking",
			"custom-vl-model",
			"grok-code-fast-1",
		]);
		expect(models[0]).toMatchObject({
			name: "Claude 4.5 Sonnet (Thinking)",
			reasoning: true,
			input: ["text", "image"],
		});
		expect(models[1]).toMatchObject({
			name: "custom-vl-model-final",
			reasoning: true,
			input: ["text", "image"],
		});
		expect(models[2]).toMatchObject({
			name: "Grok Code Fast 1",
			reasoning: true,
			input: ["text"],
		});
	});

	test("fetchCursorUsableModels returns normalized models and null for transport failures", async () => {
		const { fetchCursorUsableModels } = await import("../src/cursor-models");
		http2Scenario.body = frameConnectMessage(
			toBinary(
				GetUsableModelsResponseSchema,
				create(GetUsableModelsResponseSchema, {
					models: [
						{ modelId: "default", displayName: "Cursor Auto" },
						{ modelId: "grok-code-fast-1", displayName: "Grok Code Fast 1" },
						{ modelId: "default", displayName: "Cursor Auto Duplicate" },
					] as any,
				}),
			),
		);

		await expect(
			fetchCursorUsableModels({
				apiKey: "token",
				timeoutMs: 10,
			}),
		).resolves.toMatchObject([
			expect.objectContaining({ id: "default" }),
			expect.objectContaining({ id: "grok-code-fast-1" }),
		]);

		http2Scenario.status = 500;
		await expect(
			fetchCursorUsableModels({
				apiKey: "token",
				timeoutMs: 10,
			}),
		).resolves.toBe(null);

		http2Scenario.status = 200;
		http2Scenario.body = Uint8Array.from([1, 2, 3]);
		await expect(
			fetchCursorUsableModels({
				apiKey: "token",
				timeoutMs: 10,
			}),
		).resolves.toBe(null);

		http2Scenario.body = null;
		http2Scenario.requestError = new Error("request failed");
		await expect(
			fetchCursorUsableModels({
				apiKey: "token",
				timeoutMs: 10,
			}),
		).resolves.toBe(null);
	});
});
