import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import type * as http2 from "node:http2";
import * as os from "node:os";
import * as path from "node:path";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
	type CursorExecBridge,
	createCursorExecBridge,
	getCursorExecBridge,
	handleExecServerControlMessage,
	handleExecServerMessage,
	setCursorExecBridge,
} from "../src/cursor-exec-bridge";
import {
	AgentClientMessageSchema,
	BackgroundShellSpawnArgsSchema,
	ComputerUseArgsSchema,
	DeleteArgsSchema,
	DiagnosticsArgsSchema,
	ExecServerAbortSchema,
	ExecServerControlMessageSchema,
	ExecServerMessageSchema,
	FetchArgsSchema,
	GrepArgsSchema,
	ListMcpResourcesExecArgsSchema,
	LsArgsSchema,
	McpArgsSchema,
	ReadArgsSchema,
	ReadMcpResourceExecArgsSchema,
	RecordScreenArgsSchema,
	RequestContextArgsSchema,
	ShellArgsSchema,
	WriteArgsSchema,
	WriteShellStdinArgsSchema,
} from "../src/cursor-gen/agent_pb";

const tempPaths = new Set<string>();
const stubToolBase = {
	name: "stub",
	label: "stub",
	description: "stub",
	parameters: {} as any,
};

afterEach(() => {
	setCursorExecBridge(null);
	mock.restore();
	for (const tempPath of tempPaths) {
		fs.rmSync(tempPath, { recursive: true, force: true });
	}
	tempPaths.clear();
});

function makeTempDir(prefix = "cursor-exec-bridge-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempPaths.add(dir);
	return dir;
}

function trackTempFile(filePath: string): string {
	tempPaths.add(filePath);
	return filePath;
}

async function withProcessPlatform<T>(
	platform: NodeJS.Platform,
	callback: () => Promise<T> | T,
): Promise<T> {
	const originalPlatform = process.platform;
	Object.defineProperty(process, "platform", {
		configurable: true,
		writable: true,
		value: platform,
	});
	try {
		return await callback();
	} finally {
		Object.defineProperty(process, "platform", {
			configurable: true,
			writable: true,
			value: originalPlatform,
		});
	}
}

async function withEnvironment<T>(
	overrides: Record<string, string | undefined>,
	callback: () => Promise<T> | T,
): Promise<T> {
	const originals = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(overrides)) {
		originals.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	try {
		return await callback();
	} finally {
		for (const [key, value] of originals) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

function createExecutableScript(
	directory: string,
	name: string,
	body: string,
): string {
	const scriptPath = trackTempFile(path.join(directory, name));
	fs.writeFileSync(scriptPath, body, "utf8");
	fs.chmodSync(scriptPath, 0o755);
	return scriptPath;
}

function createStubBridge(
	cwd: string,
	overrides: Partial<
		Record<"readTool" | "lsTool" | "writeTool" | "grepTool", any>
	> = {},
): CursorExecBridge {
	const noopTool = {
		...stubToolBase,
		execute: async () => ({ content: [], details: undefined }),
	};

	return {
		cwd,
		readTool: (overrides.readTool ?? noopTool) as CursorExecBridge["readTool"],
		lsTool: (overrides.lsTool ?? noopTool) as CursorExecBridge["lsTool"],
		writeTool: (overrides.writeTool ??
			noopTool) as CursorExecBridge["writeTool"],
		grepTool: (overrides.grepTool ?? noopTool) as CursorExecBridge["grepTool"],
	};
}

function createH2Request(): {
	writes: Buffer[];
	stream: http2.ClientHttp2Stream;
} {
	const writes: Buffer[] = [];
	return {
		writes,
		stream: {
			write(chunk: Uint8Array) {
				writes.push(Buffer.from(chunk));
				return true;
			},
		} as http2.ClientHttp2Stream,
	};
}

function decodeClientMessages(writes: Buffer[]): any[] {
	return writes.map((frame) => {
		expect(frame[0]).toBe(0);
		const payloadLength = frame.readUInt32BE(1);
		expect(frame.byteLength).toBe(5 + payloadLength);
		return fromBinary(
			AgentClientMessageSchema,
			new Uint8Array(frame.subarray(5, 5 + payloadLength)),
		);
	});
}

function makeExecMessage(
	messageCase: string | undefined,
	schema: Parameters<typeof create>[0] | null,
	value: Record<string, unknown>,
	options: { id?: number; execId?: string } = {},
): any {
	return create(ExecServerMessageSchema, {
		id: options.id ?? 1,
		execId: options.execId ?? "",
		message:
			messageCase && schema
				? {
						case: messageCase as never,
						value: create(schema as never, value as never),
					}
				: ({ case: undefined } as never),
	});
}

function getExecClientPayload(messages: any[]): any {
	expect(messages).toHaveLength(1);
	expect(messages[0]?.message.case).toBe("execClientMessage");
	return messages[0]!.message.value;
}

function createStubTool(
	execute: (...args: any[]) => Promise<any>,
): CursorExecBridge["readTool"] {
	return {
		...stubToolBase,
		execute,
	} as CursorExecBridge["readTool"];
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error(`Timed out after ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("cursor-exec-bridge", () => {
	test("creates, stores, and clears the current bridge", () => {
		const cwd = makeTempDir();
		const bridge = createCursorExecBridge(cwd);

		expect(bridge.cwd).toBe(cwd);
		expect(typeof bridge.readTool.execute).toBe("function");
		expect(typeof bridge.lsTool.execute).toBe("function");
		expect(typeof bridge.writeTool.execute).toBe("function");
		expect(typeof bridge.grepTool.execute).toBe("function");

		setCursorExecBridge(bridge);
		expect(getCursorExecBridge()).toBe(bridge);

		setCursorExecBridge(null);
		expect(getCursorExecBridge()).toBe(null);
	});

	test("ignores non-abort and unknown shell abort control messages", () => {
		expect(() =>
			handleExecServerControlMessage({ message: { case: undefined } } as any),
		).not.toThrow();

		expect(() =>
			handleExecServerControlMessage(
				create(ExecServerControlMessageSchema, {
					message: {
						case: "abort",
						value: create(ExecServerAbortSchema, { id: 12345 }),
					},
				}),
			),
		).not.toThrow();
	});

	test("returns request context and closes the exec stream when execId is present", async () => {
		const cwd = makeTempDir();
		const request = createH2Request();

		await handleExecServerMessage(
			makeExecMessage(
				"requestContextArgs",
				RequestContextArgsSchema,
				{},
				{ id: 41, execId: "attached-exec" },
			),
			request.stream,
			createCursorExecBridge(cwd),
		);

		const messages = decodeClientMessages(request.writes);
		expect(messages).toHaveLength(2);
		expect(messages[0]?.message.case).toBe("execClientMessage");
		expect(messages[0]?.message.value.message.case).toBe(
			"requestContextResult",
		);
		expect(
			messages[0]?.message.value.message.value.result.value.requestContext
				.cloudRule,
		).toContain("shellStream");

		expect(messages[1]?.message.case).toBe("execClientControlMessage");
		expect(messages[1]?.message.value.message.case).toBe("streamClose");
		expect(messages[1]?.message.value.message.value.id).toBe(41);
	});

	test("maps read text and image responses into read results", async () => {
		const cwd = makeTempDir();
		const textFile = path.join(cwd, "note.txt");
		fs.writeFileSync(textFile, "line one\nline two\nline three\n");

		const textRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("readArgs", ReadArgsSchema, {
				path: "note.txt",
				toolCallId: "read-text",
			}),
			textRequest.stream,
			createStubBridge(cwd, {
				readTool: createStubTool(async () => ({
					content: [{ type: "text", text: "line one\nline two" }],
					details: { truncation: { truncatedBy: "lines" } },
				})),
			}),
		);

		const textPayload = getExecClientPayload(
			decodeClientMessages(textRequest.writes),
		);
		expect(textPayload.message.case).toBe("readResult");
		expect(textPayload.message.value.result.case).toBe("success");
		expect(textPayload.message.value.result.value.path).toBe("note.txt");
		expect(textPayload.message.value.result.value.totalLines).toBe(4);
		expect(textPayload.message.value.result.value.fileSize).toBe(
			BigInt(Buffer.byteLength("line one\nline two\nline three\n", "utf8")),
		);
		expect(textPayload.message.value.result.value.truncated).toBe(true);
		expect(textPayload.message.value.result.value.output.case).toBe("content");
		expect(textPayload.message.value.result.value.output.value).toBe(
			"line one\nline two",
		);

		const imageBytes = Buffer.from("fake-image-data");
		const imageRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("readArgs", ReadArgsSchema, {
				path: "image.png",
				toolCallId: "read-image",
			}),
			imageRequest.stream,
			createStubBridge(cwd, {
				readTool: createStubTool(async () => ({
					content: [
						{
							type: "image",
							data: imageBytes.toString("base64"),
							mimeType: "image/png",
						},
					],
					details: undefined,
				})),
			}),
		);

		const imagePayload = getExecClientPayload(
			decodeClientMessages(imageRequest.writes),
		);
		expect(imagePayload.message.case).toBe("readResult");
		expect(imagePayload.message.value.result.case).toBe("success");
		expect(imagePayload.message.value.result.value.totalLines).toBe(0);
		expect(imagePayload.message.value.result.value.fileSize).toBe(
			BigInt(imageBytes.length),
		);
		expect(imagePayload.message.value.result.value.output.case).toBe("data");
		expect(
			Buffer.from(imagePayload.message.value.result.value.output.value),
		).toEqual(imageBytes);
	});

	test("falls back to inline read data when file metadata cannot be re-read", async () => {
		const cwd = makeTempDir();
		const request = createH2Request();

		await handleExecServerMessage(
			makeExecMessage("readArgs", ReadArgsSchema, {
				path: "missing.txt",
				toolCallId: "read-inline-fallback",
			}),
			request.stream,
			createStubBridge(cwd, {
				readTool: createStubTool(async () => ({
					content: [{ type: "text", text: "" }],
					details: undefined,
				})),
			}),
		);

		const payload = getExecClientPayload(decodeClientMessages(request.writes));
		expect(payload.message.case).toBe("readResult");
		expect(payload.message.value.result.case).toBe("success");
		expect(payload.message.value.result.value.totalLines).toBe(0);
		expect(payload.message.value.result.value.fileSize).toBe(BigInt(0));
		expect(payload.message.value.result.value.output.case).toBe("content");
		expect(payload.message.value.result.value.output.value).toBe("");
	});

	test("maps read execution errors into the correct result variants", async () => {
		const cwd = makeTempDir();
		const cases = [
			{
				error: "ENOENT: no such file or directory",
				expectedCase: "fileNotFound",
			},
			{
				error: "EACCES: permission denied",
				expectedCase: "permissionDenied",
			},
			{
				error: "EISDIR: illegal operation on a directory",
				expectedCase: "invalidFile",
			},
			{
				error: "read exploded",
				expectedCase: "error",
			},
		];

		for (const [index, entry] of cases.entries()) {
			const request = createH2Request();
			await handleExecServerMessage(
				makeExecMessage("readArgs", ReadArgsSchema, {
					path: "problem.txt",
					toolCallId: `read-error-${index}`,
				}),
				request.stream,
				createStubBridge(cwd, {
					readTool: createStubTool(async () => {
						throw new Error(entry.error);
					}),
				}),
			);

			const payload = getExecClientPayload(
				decodeClientMessages(request.writes),
			);
			expect(payload.message.case).toBe("readResult");
			expect(payload.message.value.result.case).toBe(entry.expectedCase);
		}
	});

	test("builds ls directory trees, handles empty directories, and maps errors", async () => {
		const cwd = makeTempDir();

		const listingRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("lsArgs", LsArgsSchema, {
				path: "",
				ignore: [],
				toolCallId: "ls-listing",
			}),
			listingRequest.stream,
			createStubBridge(cwd, {
				lsTool: createStubTool(async () => ({
					content: [
						{
							type: "text",
							text: "src/\nREADME.md\n[note about hidden entries]\nassets/\n",
						},
					],
					details: undefined,
				})),
			}),
		);

		const listingPayload = getExecClientPayload(
			decodeClientMessages(listingRequest.writes),
		);
		expect(listingPayload.message.case).toBe("lsResult");
		expect(listingPayload.message.value.result.case).toBe("success");
		expect(
			listingPayload.message.value.result.value.directoryTreeRoot?.absPath,
		).toBe(cwd);
		expect(
			listingPayload.message.value.result.value.directoryTreeRoot?.childrenDirs.map(
				(entry: any) => entry.absPath,
			),
		).toEqual([path.join(cwd, "src"), path.join(cwd, "assets")]);
		expect(
			listingPayload.message.value.result.value.directoryTreeRoot?.childrenFiles.map(
				(entry: any) => entry.name,
			),
		).toEqual(["README.md"]);

		const emptyRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("lsArgs", LsArgsSchema, {
				path: "empty",
				ignore: [],
				toolCallId: "ls-empty",
			}),
			emptyRequest.stream,
			createStubBridge(cwd, {
				lsTool: createStubTool(async () => ({
					content: [{ type: "text", text: "(empty directory)" }],
					details: undefined,
				})),
			}),
		);

		const emptyPayload = getExecClientPayload(
			decodeClientMessages(emptyRequest.writes),
		);
		expect(emptyPayload.message.case).toBe("lsResult");
		expect(emptyPayload.message.value.result.case).toBe("success");
		expect(
			emptyPayload.message.value.result.value.directoryTreeRoot?.childrenDirs,
		).toHaveLength(0);
		expect(
			emptyPayload.message.value.result.value.directoryTreeRoot?.childrenFiles,
		).toHaveLength(0);

		const errorRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("lsArgs", LsArgsSchema, {
				path: "missing",
				ignore: [],
				toolCallId: "ls-error",
			}),
			errorRequest.stream,
			createStubBridge(cwd, {
				lsTool: createStubTool(async () => {
					throw new Error("ls failed");
				}),
			}),
		);

		const errorPayload = getExecClientPayload(
			decodeClientMessages(errorRequest.writes),
		);
		expect(errorPayload.message.case).toBe("lsResult");
		expect(errorPayload.message.value.result.case).toBe("error");
		expect(errorPayload.message.value.result.value.error).toBe("ls failed");
	});

	test("returns write success, write errors, and rejects binary file writes", async () => {
		const cwd = makeTempDir();

		const successRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("writeArgs", WriteArgsSchema, {
				path: "output.txt",
				fileText: "alpha\nbeta",
				toolCallId: "write-success",
				returnFileContentAfterWrite: true,
				fileBytes: new Uint8Array(),
			}),
			successRequest.stream,
			createStubBridge(cwd, {
				writeTool: createStubTool(async () => ({
					content: [],
					details: undefined,
				})),
			}),
		);

		const successPayload = getExecClientPayload(
			decodeClientMessages(successRequest.writes),
		);
		expect(successPayload.message.case).toBe("writeResult");
		expect(successPayload.message.value.result.case).toBe("success");
		expect(successPayload.message.value.result.value.linesCreated).toBe(2);
		expect(successPayload.message.value.result.value.fileSize).toBe(
			Buffer.byteLength("alpha\nbeta", "utf8"),
		);
		expect(
			successPayload.message.value.result.value.fileContentAfterWrite,
		).toBe("alpha\nbeta");

		const errorRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("writeArgs", WriteArgsSchema, {
				path: "output.txt",
				fileText: "alpha",
				toolCallId: "write-error",
				returnFileContentAfterWrite: false,
				fileBytes: new Uint8Array(),
			}),
			errorRequest.stream,
			createStubBridge(cwd, {
				writeTool: createStubTool(async () => {
					throw new Error("disk full");
				}),
			}),
		);

		const errorPayload = getExecClientPayload(
			decodeClientMessages(errorRequest.writes),
		);
		expect(errorPayload.message.case).toBe("writeResult");
		expect(errorPayload.message.value.result.case).toBe("error");
		expect(errorPayload.message.value.result.value.error).toBe("disk full");

		const rejectedRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("writeArgs", WriteArgsSchema, {
				path: "binary.dat",
				fileText: "",
				toolCallId: "write-binary",
				returnFileContentAfterWrite: false,
				fileBytes: Uint8Array.from([1, 2, 3]),
			}),
			rejectedRequest.stream,
			createStubBridge(cwd),
		);

		const rejectedPayload = getExecClientPayload(
			decodeClientMessages(rejectedRequest.writes),
		);
		expect(rejectedPayload.message.case).toBe("writeResult");
		expect(rejectedPayload.message.value.result.case).toBe("rejected");
		expect(rejectedPayload.message.value.result.value.reason).toContain(
			"Binary file writes",
		);
	});

	test("deletes files, omits large previews, and reports missing or non-file paths", async () => {
		const cwd = makeTempDir();
		const bridge = createStubBridge(cwd);

		const filePath = path.join(cwd, "delete-me.txt");
		fs.writeFileSync(filePath, "delete this");
		const deleteRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("deleteArgs", DeleteArgsSchema, {
				path: "delete-me.txt",
				toolCallId: "delete-file",
			}),
			deleteRequest.stream,
			bridge,
		);

		const deletePayload = getExecClientPayload(
			decodeClientMessages(deleteRequest.writes),
		);
		expect(deletePayload.message.case).toBe("deleteResult");
		expect(deletePayload.message.value.result.case).toBe("success");
		expect(deletePayload.message.value.result.value.prevContent).toBe(
			"delete this",
		);
		expect(fs.existsSync(filePath)).toBe(false);

		const bigFilePath = path.join(cwd, "large.txt");
		fs.writeFileSync(bigFilePath, "x".repeat(60 * 1024));
		const largeDeleteRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("deleteArgs", DeleteArgsSchema, {
				path: "large.txt",
				toolCallId: "delete-large-file",
			}),
			largeDeleteRequest.stream,
			bridge,
		);

		const largeDeletePayload = getExecClientPayload(
			decodeClientMessages(largeDeleteRequest.writes),
		);
		expect(largeDeletePayload.message.value.result.case).toBe("success");
		expect(largeDeletePayload.message.value.result.value.prevContent).toContain(
			"previous content omitted",
		);

		const missingRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("deleteArgs", DeleteArgsSchema, {
				path: "missing.txt",
				toolCallId: "delete-missing",
			}),
			missingRequest.stream,
			bridge,
		);

		const missingPayload = getExecClientPayload(
			decodeClientMessages(missingRequest.writes),
		);
		expect(missingPayload.message.case).toBe("deleteResult");
		expect(missingPayload.message.value.result.case).toBe("fileNotFound");

		fs.mkdirSync(path.join(cwd, "folder"));
		const dirRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("deleteArgs", DeleteArgsSchema, {
				path: "folder",
				toolCallId: "delete-dir",
			}),
			dirRequest.stream,
			bridge,
		);

		const dirPayload = getExecClientPayload(
			decodeClientMessages(dirRequest.writes),
		);
		expect(dirPayload.message.case).toBe("deleteResult");
		expect(dirPayload.message.value.result.case).toBe("notFile");
		expect(dirPayload.message.value.result.value.actualType).toBe("directory");
	});

	test("maps delete stat failures to permission denied and generic errors", async () => {
		const cwd = makeTempDir();
		const cases = [
			{
				error: new Error("EACCES: permission denied"),
				expectedCase: "permissionDenied",
			},
			{
				error: new Error("delete stat exploded"),
				expectedCase: "error",
			},
		];

		for (const [index, entry] of cases.entries()) {
			const request = createH2Request();
			spyOn(fs, "statSync").mockImplementation(() => {
				throw entry.error;
			});

			await handleExecServerMessage(
				makeExecMessage("deleteArgs", DeleteArgsSchema, {
					path: `delete-stat-${index}.txt`,
					toolCallId: `delete-stat-${index}`,
				}),
				request.stream,
				createStubBridge(cwd),
			);

			const payload = getExecClientPayload(
				decodeClientMessages(request.writes),
			);
			expect(payload.message.case).toBe("deleteResult");
			expect(payload.message.value.result.case).toBe(entry.expectedCase);
			mock.restore();
		}
	});

	test("maps delete remove failures to permission denied, busy, and generic errors", async () => {
		const cwd = makeTempDir();
		const cases = [
			{
				error: new Error("EPERM: operation not permitted"),
				expectedCase: "permissionDenied",
			},
			{
				error: new Error("EBUSY: file is busy"),
				expectedCase: "fileBusy",
			},
			{
				error: new Error("rm exploded"),
				expectedCase: "error",
			},
		];

		for (const [index, entry] of cases.entries()) {
			const filePath = path.join(cwd, `delete-rm-${index}.txt`);
			fs.writeFileSync(filePath, "delete me");
			const request = createH2Request();
			spyOn(fs, "rmSync").mockImplementation(() => {
				throw entry.error;
			});

			await handleExecServerMessage(
				makeExecMessage("deleteArgs", DeleteArgsSchema, {
					path: path.basename(filePath),
					toolCallId: `delete-rm-${index}`,
				}),
				request.stream,
				createStubBridge(cwd),
			);

			const payload = getExecClientPayload(
				decodeClientMessages(request.writes),
			);
			expect(payload.message.case).toBe("deleteResult");
			expect(payload.message.value.result.case).toBe(entry.expectedCase);
			mock.restore();
		}
	});

	test("returns a fallback delete preview when the file cannot be re-read", async () => {
		const cwd = makeTempDir();
		const filePath = path.join(cwd, "delete-preview.txt");
		const realReadFileSync = fs.readFileSync;
		fs.writeFileSync(filePath, "preview text");

		spyOn(fs, "readFileSync").mockImplementation(((...args: any[]) => {
			if (args[0] === filePath && args[1] === "utf8") {
				throw new Error("preview exploded");
			}
			return realReadFileSync(...(args as [any]));
		}) as typeof fs.readFileSync);

		const request = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("deleteArgs", DeleteArgsSchema, {
				path: "delete-preview.txt",
				toolCallId: "delete-preview-fallback",
			}),
			request.stream,
			createStubBridge(cwd),
		);

		const payload = getExecClientPayload(decodeClientMessages(request.writes));
		expect(payload.message.case).toBe("deleteResult");
		expect(payload.message.value.result.case).toBe("success");
		expect(payload.message.value.result.value.prevContent).toBe(
			"[previous content unavailable]",
		);
		expect(fs.existsSync(filePath)).toBe(false);
	});

	test("runs shell commands and maps success, failure, timeout, and spawn errors", async () => {
		const cwd = makeTempDir();
		const bridge = createCursorExecBridge(cwd);

		const successRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("shellArgs", ShellArgsSchema, {
				command: "printf 'hello\\n'",
				workingDirectory: ".",
				timeout: 0,
				toolCallId: "shell-success",
			}),
			successRequest.stream,
			bridge,
		);

		const successPayload = getExecClientPayload(
			decodeClientMessages(successRequest.writes),
		);
		expect(successPayload.message.case).toBe("shellResult");
		expect(successPayload.message.value.result.case).toBe("success");
		expect(successPayload.message.value.result.value.stdout).toContain("hello");

		const failureRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("shellArgs", ShellArgsSchema, {
				command: "printf 'oops\\n' >&2; exit 3",
				workingDirectory: ".",
				timeout: 0,
				toolCallId: "shell-failure",
			}),
			failureRequest.stream,
			bridge,
		);

		const failurePayload = getExecClientPayload(
			decodeClientMessages(failureRequest.writes),
		);
		expect(failurePayload.message.case).toBe("shellResult");
		expect(failurePayload.message.value.result.case).toBe("failure");
		expect(failurePayload.message.value.result.value.stderr).toContain("oops");
		expect(failurePayload.message.value.result.value.stderr).toContain(
			"Command exited with code 3",
		);

		const timeoutRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("shellArgs", ShellArgsSchema, {
				command: "sleep 2",
				workingDirectory: ".",
				timeout: 1,
				toolCallId: "shell-timeout",
			}),
			timeoutRequest.stream,
			bridge,
		);

		const timeoutPayload = getExecClientPayload(
			decodeClientMessages(timeoutRequest.writes),
		);
		expect(timeoutPayload.message.case).toBe("shellResult");
		expect(timeoutPayload.message.value.result.case).toBe("timeout");
		expect(timeoutPayload.message.value.result.value.timeoutMs).toBe(1000);

		const missingDirRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("shellArgs", ShellArgsSchema, {
				command: "pwd",
				workingDirectory: "does-not-exist",
				timeout: 0,
				toolCallId: "shell-missing-dir",
			}),
			missingDirRequest.stream,
			bridge,
		);

		const missingDirPayload = getExecClientPayload(
			decodeClientMessages(missingDirRequest.writes),
		);
		expect(missingDirPayload.message.case).toBe("shellResult");
		expect(missingDirPayload.message.value.result.case).toBe("spawnError");
	});

	test("streams shell output, spills large output to a file, and closes the stream", async () => {
		const cwd = makeTempDir();
		const bridge = createCursorExecBridge(cwd);
		spyOn(crypto, "randomUUID").mockReturnValue(
			"11111111-1111-4111-8111-111111111111",
		);

		const request = createH2Request();
		await handleExecServerMessage(
			makeExecMessage(
				"shellStreamArgs",
				ShellArgsSchema,
				{
					command:
						"node -e \"process.stdout.write('A'.repeat(256)); process.stderr.write('ERR')\"",
					workingDirectory: ".",
					timeout: 0,
					toolCallId: "shell-stream",
					fileOutputThresholdBytes: 32n,
				},
				{ id: 77 },
			),
			request.stream,
			bridge,
		);

		const messages = decodeClientMessages(request.writes);
		const streamEvents = messages
			.filter((message) => message.message.case === "execClientMessage")
			.map((message) => message.message.value.message);

		expect(streamEvents.map((message) => message.case)).toContain(
			"shellStream",
		);
		const shellEvents = streamEvents
			.filter((message) => message.case === "shellStream")
			.map((message) => message.value.event);
		expect(shellEvents.map((event) => event.case)).toEqual([
			"start",
			"stdout",
			"stderr",
			"exit",
		]);

		const exitEvent = shellEvents.at(-1)?.value;
		expect(exitEvent?.code).toBe(0);
		expect(exitEvent?.aborted).toBe(false);
		expect(exitEvent?.outputLocation?.filePath).toBe(
			path.join(
				os.tmpdir(),
				"cursor-shell-stream-11111111-1111-4111-8111-111111111111.log",
			),
		);
		const outputPath = trackTempFile(exitEvent!.outputLocation!.filePath);
		expect(fs.existsSync(outputPath)).toBe(true);
		const outputText = fs.readFileSync(outputPath, "utf8");
		expect(outputText).toContain("A".repeat(256));
		expect(outputText).toContain("ERR");

		const controlMessage = messages.at(-1);
		expect(controlMessage?.message.case).toBe("execClientControlMessage");
		expect(controlMessage?.message.value.message.case).toBe("streamClose");
		expect(controlMessage?.message.value.message.value.id).toBe(77);
	});

	test("flushes buffered shell stream output to a file once the threshold is crossed", async () => {
		const cwd = makeTempDir();
		const bridge = createCursorExecBridge(cwd);
		spyOn(crypto, "randomUUID").mockReturnValue(
			"22222222-2222-4222-8222-222222222222",
		);

		const request = createH2Request();
		await handleExecServerMessage(
			makeExecMessage(
				"shellStreamArgs",
				ShellArgsSchema,
				{
					command:
						"node -e \"process.stdout.write('A'.repeat(16)); setTimeout(() => { process.stdout.write('B'.repeat(16)); }, 20)\"",
					workingDirectory: ".",
					timeout: 0,
					toolCallId: "shell-stream-buffer-flush",
					fileOutputThresholdBytes: 20n,
				},
				{ id: 78 },
			),
			request.stream,
			bridge,
		);

		const messages = decodeClientMessages(request.writes);
		const exitEvent = messages
			.filter((message) => message.message.case === "execClientMessage")
			.map((message) => message.message.value.message)
			.find(
				(message) =>
					message.case === "shellStream" && message.value.event.case === "exit",
			);
		expect(exitEvent?.value.event.value.outputLocation?.filePath).toBe(
			path.join(
				os.tmpdir(),
				"cursor-shell-stream-22222222-2222-4222-8222-222222222222.log",
			),
		);

		const outputPath = trackTempFile(
			exitEvent!.value.event.value.outputLocation!.filePath,
		);
		expect(fs.readFileSync(outputPath, "utf8")).toBe(
			`${"A".repeat(16)}${"B".repeat(16)}`,
		);
	});

	test("rejects shell streams in missing directories and marks timed out streams as aborted", async () => {
		const cwd = makeTempDir();
		const bridge = createCursorExecBridge(cwd);

		const missingDirRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage(
				"shellStreamArgs",
				ShellArgsSchema,
				{
					command: "pwd",
					workingDirectory: "missing-dir",
					timeout: 0,
					toolCallId: "shell-stream-missing",
				},
				{ id: 81 },
			),
			missingDirRequest.stream,
			bridge,
		);

		const missingDirMessages = decodeClientMessages(missingDirRequest.writes);
		expect(missingDirMessages[0]?.message.case).toBe("execClientMessage");
		expect(missingDirMessages[0]?.message.value.message.case).toBe(
			"shellStream",
		);
		expect(missingDirMessages[0]?.message.value.message.value.event.case).toBe(
			"rejected",
		);
		expect(
			missingDirMessages[0]?.message.value.message.value.event.value.reason,
		).toContain("does not exist");
		expect(missingDirMessages.at(-1)?.message.case).toBe(
			"execClientControlMessage",
		);

		const timeoutRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage(
				"shellStreamArgs",
				ShellArgsSchema,
				{
					command: "sleep 2",
					workingDirectory: ".",
					timeout: 1,
					toolCallId: "shell-stream-timeout",
				},
				{ id: 82 },
			),
			timeoutRequest.stream,
			bridge,
		);

		const timeoutMessages = decodeClientMessages(timeoutRequest.writes);
		const timeoutExit = timeoutMessages
			.filter((message) => message.message.case === "execClientMessage")
			.map((message) => message.message.value.message)
			.find(
				(message) =>
					message.case === "shellStream" && message.value.event.case === "exit",
			);
		expect(timeoutExit?.value.event.value.aborted).toBe(true);
	});

	test("returns permission denied when shell streams cannot access the working directory", async () => {
		const cwd = makeTempDir();
		const bridge = createCursorExecBridge(cwd);
		const deniedDir = path.join(cwd, "denied");
		const realAccessSync = fs.accessSync;
		fs.mkdirSync(deniedDir);

		spyOn(fs, "accessSync").mockImplementation(((...args: any[]) => {
			if (args[0] === deniedDir) {
				throw new Error("EACCES: permission denied");
			}
			return realAccessSync(...(args as [any]));
		}) as typeof fs.accessSync);

		const request = createH2Request();
		await handleExecServerMessage(
			makeExecMessage(
				"shellStreamArgs",
				ShellArgsSchema,
				{
					command: "pwd",
					workingDirectory: "denied",
					timeout: 0,
					toolCallId: "shell-stream-denied",
				},
				{ id: 83 },
			),
			request.stream,
			bridge,
		);

		const messages = decodeClientMessages(request.writes);
		expect(messages[0]?.message.case).toBe("execClientMessage");
		expect(messages[0]?.message.value.message.case).toBe("shellStream");
		expect(messages[0]?.message.value.message.value.event.case).toBe(
			"permissionDenied",
		);
		expect(
			messages[0]?.message.value.message.value.event.value.error,
		).toContain("Permission denied");
		expect(messages.at(-1)?.message.case).toBe("execClientControlMessage");
	});

	test("aborts active shell streams via control messages", async () => {
		const cwd = makeTempDir();
		const bridge = createCursorExecBridge(cwd);
		const request = createH2Request();
		const execMessage = makeExecMessage(
			"shellStreamArgs",
			ShellArgsSchema,
			{
				command: "sleep 30",
				workingDirectory: ".",
				timeout: 0,
				toolCallId: "shell-stream-abort",
			},
			{ id: 99 },
		);

		const streamPromise = handleExecServerMessage(
			execMessage,
			request.stream,
			bridge,
		);
		await waitFor(() => request.writes.length > 0);

		handleExecServerControlMessage(
			create(ExecServerControlMessageSchema, {
				message: {
					case: "abort",
					value: create(ExecServerAbortSchema, { id: 99 }),
				},
			}),
		);

		await streamPromise;

		const messages = decodeClientMessages(request.writes);
		const exitMessage = messages
			.filter((message) => message.message.case === "execClientMessage")
			.map((message) => message.message.value.message)
			.find(
				(message) =>
					message.case === "shellStream" && message.value.event.case === "exit",
			);
		expect(exitMessage).toBeDefined();
		expect(exitMessage?.value.event.value.code).toBe(1);
		expect(exitMessage?.value.event.value.aborted).toBe(false);
	});

	test("falls back to killing the direct process when process-group termination fails", async () => {
		const cwd = makeTempDir();
		const bridge = createCursorExecBridge(cwd);
		const request = createH2Request();
		const killCalls: number[] = [];
		const execMessage = makeExecMessage(
			"shellStreamArgs",
			ShellArgsSchema,
			{
				command: "sleep 0.2",
				workingDirectory: ".",
				timeout: 0,
				toolCallId: "shell-stream-abort-fallback",
			},
			{ id: 100 },
		);

		spyOn(process, "kill").mockImplementation(((pid: number) => {
			killCalls.push(pid);
			if (pid < 0) {
				throw new Error("no process group");
			}
			return true;
		}) as typeof process.kill);

		const streamPromise = handleExecServerMessage(
			execMessage,
			request.stream,
			bridge,
		);
		await waitFor(() => request.writes.length > 0);

		handleExecServerControlMessage(
			create(ExecServerControlMessageSchema, {
				message: {
					case: "abort",
					value: create(ExecServerAbortSchema, { id: 100 }),
				},
			}),
		);

		await streamPromise;

		expect(killCalls).toHaveLength(2);
		expect(killCalls[0]).toBeLessThan(0);
		expect(killCalls[1]).toBeGreaterThan(0);
	});

	test("uses the win32 shell fallback and reports shell launch errors", async () => {
		const cwd = makeTempDir();
		const binDir = makeTempDir("cursor-exec-bridge-bin-");
		createExecutableScript(binDir, "where", "#!/bin/sh\nexit 1\n");
		const request = createH2Request();

		await withProcessPlatform("win32", async () => {
			await withEnvironment(
				{
					PATH: binDir,
					ComSpec: path.join(binDir, "missing-shell.exe"),
				},
				async () => {
					await handleExecServerMessage(
						makeExecMessage(
							"shellStreamArgs",
							ShellArgsSchema,
							{
								command: "echo hello",
								workingDirectory: ".",
								timeout: 0,
								toolCallId: "shell-stream-win32-launch-error",
							},
							{ id: 101 },
						),
						request.stream,
						createCursorExecBridge(cwd),
					);
				},
			);
		});

		const messages = decodeClientMessages(request.writes);
		const shellEvents = messages
			.filter((message) => message.message.case === "execClientMessage")
			.map((message) => message.message.value.message)
			.filter((message) => message.case === "shellStream")
			.map((message) => message.value.event);

		expect(shellEvents.map((event) => event.case)).toEqual([
			"start",
			"stderr",
			"exit",
		]);
		expect(shellEvents[1]?.value.data).toContain("missing-shell.exe");
		expect(shellEvents[2]?.value.code).toBe(1);
		expect(shellEvents[2]?.value.aborted).toBe(false);
		expect(messages.at(-1)?.message.case).toBe("execClientControlMessage");
	});

	test("uses win32 bash discovery for shell streams before abort handling", async () => {
		const cwd = makeTempDir();
		const binDir = makeTempDir("cursor-exec-bridge-bin-");
		const fakeShell = createExecutableScript(
			binDir,
			"fake-bash",
			"#!/bin/sh\nsleep 0.2\n",
		);
		createExecutableScript(
			binDir,
			"where",
			`#!/bin/sh
if [ "$1" = "bash.exe" ]; then
	printf '%s\\n' '${fakeShell}'
	exit 0
fi
exit 1
`,
		);

		const request = createH2Request();
		const execMessage = makeExecMessage(
			"shellStreamArgs",
			ShellArgsSchema,
			{
				command: "ignored",
				workingDirectory: ".",
				timeout: 0,
				toolCallId: "shell-stream-win32-abort",
			},
			{ id: 102 },
		);

		await withProcessPlatform("win32", async () => {
			await withEnvironment({ PATH: binDir, ComSpec: undefined }, async () => {
				const streamPromise = handleExecServerMessage(
					execMessage,
					request.stream,
					createCursorExecBridge(cwd),
				);
				await waitFor(() => request.writes.length > 0);

				handleExecServerControlMessage(
					create(ExecServerControlMessageSchema, {
						message: {
							case: "abort",
							value: create(ExecServerAbortSchema, { id: 102 }),
						},
					}),
				);

				await streamPromise;
			});
		});

		const messages = decodeClientMessages(request.writes);
		const exitMessage = messages
			.filter((message) => message.message.case === "execClientMessage")
			.map((message) => message.message.value.message)
			.find(
				(message) =>
					message.case === "shellStream" && message.value.event.case === "exit",
			);
		expect(exitMessage).toBeDefined();
		expect(messages.at(-1)?.message.case).toBe("execClientControlMessage");
	});

	test("uses bash discovered on PATH for shell streams when /bin/bash is unavailable", async () => {
		const cwd = makeTempDir();
		const binDir = makeTempDir("cursor-exec-bridge-bin-");
		const fakeShell = createExecutableScript(
			binDir,
			"fake-bash",
			`#!/bin/sh
if [ "$1" = "-lc" ]; then
	shift
fi
eval "$1"
`,
		);
		createExecutableScript(
			binDir,
			"which",
			`#!/bin/sh
if [ "$1" = "bash" ]; then
	printf '%s\\n' '${fakeShell}'
	exit 0
fi
exit 1
`,
		);
		const realExistsSync = fs.existsSync;
		spyOn(fs, "existsSync").mockImplementation(((
			candidatePath: fs.PathLike,
		) => {
			if (candidatePath === "/bin/bash") {
				return false;
			}
			return realExistsSync(candidatePath);
		}) as typeof fs.existsSync);

		const request = createH2Request();
		await withEnvironment(
			{
				PATH: `${binDir}:${process.env.PATH ?? ""}`,
			},
			async () => {
				await handleExecServerMessage(
					makeExecMessage(
						"shellStreamArgs",
						ShellArgsSchema,
						{
							command: "printf 'path-bash\\n'",
							workingDirectory: ".",
							timeout: 0,
							toolCallId: "shell-stream-path-bash",
						},
						{ id: 103 },
					),
					request.stream,
					createCursorExecBridge(cwd),
				);
			},
		);

		const messages = decodeClientMessages(request.writes);
		const shellEvents = messages
			.filter((message) => message.message.case === "execClientMessage")
			.map((message) => message.message.value.message)
			.filter((message) => message.case === "shellStream")
			.map((message) => message.value.event);

		expect(shellEvents.map((event) => event.case)).toEqual([
			"start",
			"stdout",
			"exit",
		]);
		expect(shellEvents[1]?.value.data).toBe("path-bash\n");
		expect(shellEvents[2]?.value.code).toBe(0);
		expect(shellEvents[2]?.value.aborted).toBe(false);
		expect(messages.at(-1)?.message.case).toBe("execClientControlMessage");
	});

	test("falls back to sh for shell streams when bash cannot be resolved", async () => {
		const cwd = makeTempDir();
		const binDir = makeTempDir("cursor-exec-bridge-bin-");
		createExecutableScript(binDir, "which", "#!/bin/sh\nexit 1\n");
		const realExistsSync = fs.existsSync;
		spyOn(fs, "existsSync").mockImplementation(((
			candidatePath: fs.PathLike,
		) => {
			if (candidatePath === "/bin/bash") {
				return false;
			}
			return realExistsSync(candidatePath);
		}) as typeof fs.existsSync);

		const request = createH2Request();
		await withEnvironment(
			{
				PATH: `${binDir}:${process.env.PATH ?? ""}`,
			},
			async () => {
				await handleExecServerMessage(
					makeExecMessage(
						"shellStreamArgs",
						ShellArgsSchema,
						{
							command: "printf 'sh-fallback\\n'",
							workingDirectory: ".",
							timeout: 0,
							toolCallId: "shell-stream-sh-fallback",
						},
						{ id: 104 },
					),
					request.stream,
					createCursorExecBridge(cwd),
				);
			},
		);

		const messages = decodeClientMessages(request.writes);
		const shellEvents = messages
			.filter((message) => message.message.case === "execClientMessage")
			.map((message) => message.message.value.message)
			.filter((message) => message.case === "shellStream")
			.map((message) => message.value.event);

		expect(shellEvents.map((event) => event.case)).toEqual([
			"start",
			"stdout",
			"exit",
		]);
		expect(shellEvents[1]?.value.data).toBe("sh-fallback\n");
		expect(shellEvents[2]?.value.code).toBe(0);
		expect(shellEvents[2]?.value.aborted).toBe(false);
		expect(messages.at(-1)?.message.case).toBe("execClientControlMessage");
	});

	test("returns grep content, files, counts, and unsupported mode errors", async () => {
		const cwd = makeTempDir();
		fs.writeFileSync(
			path.join(cwd, "alpha.txt"),
			"needle one\nignore\nneedle two\n",
		);
		fs.mkdirSync(path.join(cwd, "nested"));
		fs.writeFileSync(path.join(cwd, "nested", "beta.txt"), "needle three\n");
		const bridge = createCursorExecBridge(cwd);

		const contentRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("grepArgs", GrepArgsSchema, {
				pattern: "needle",
				path: ".",
				outputMode: "content",
				headLimit: 2,
				toolCallId: "grep-content",
			}),
			contentRequest.stream,
			bridge,
		);

		const contentPayload = getExecClientPayload(
			decodeClientMessages(contentRequest.writes),
		);
		expect(contentPayload.message.case).toBe("grepResult");
		expect(contentPayload.message.value.result.case).toBe("success");
		const contentWorkspace =
			contentPayload.message.value.result.value.workspaceResults[cwd];
		expect(contentWorkspace?.result.case).toBe("content");
		expect(contentWorkspace?.result.value.totalMatchedLines).toBe(3);
		expect(contentWorkspace?.result.value.clientTruncated).toBe(true);

		const filesRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("grepArgs", GrepArgsSchema, {
				pattern: "needle",
				path: ".",
				outputMode: "files_with_matches",
				headLimit: 1,
				toolCallId: "grep-files",
			}),
			filesRequest.stream,
			bridge,
		);

		const filesPayload = getExecClientPayload(
			decodeClientMessages(filesRequest.writes),
		);
		expect(filesPayload.message.case).toBe("grepResult");
		expect(filesPayload.message.value.result.case).toBe("success");
		const filesWorkspace =
			filesPayload.message.value.result.value.workspaceResults[cwd];
		expect(filesWorkspace?.result.case).toBe("files");
		expect(filesWorkspace?.result.value.totalFiles).toBe(2);
		expect(filesWorkspace?.result.value.files).toHaveLength(1);
		expect(filesWorkspace?.result.value.clientTruncated).toBe(true);

		const countRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("grepArgs", GrepArgsSchema, {
				pattern: "needle",
				path: ".",
				outputMode: "count",
				headLimit: 1,
				toolCallId: "grep-count",
			}),
			countRequest.stream,
			bridge,
		);

		const countPayload = getExecClientPayload(
			decodeClientMessages(countRequest.writes),
		);
		expect(countPayload.message.case).toBe("grepResult");
		expect(countPayload.message.value.result.case).toBe("success");
		const countWorkspace =
			countPayload.message.value.result.value.workspaceResults[cwd];
		expect(countWorkspace?.result.case).toBe("count");
		expect(countWorkspace?.result.value.totalFiles).toBe(2);
		expect(countWorkspace?.result.value.totalMatches).toBe(3);
		expect(countWorkspace?.result.value.counts).toHaveLength(1);
		expect(countWorkspace?.result.value.clientTruncated).toBe(true);

		const unsupportedRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("grepArgs", GrepArgsSchema, {
				pattern: "needle",
				path: ".",
				outputMode: "nope",
				toolCallId: "grep-unsupported",
			}),
			unsupportedRequest.stream,
			bridge,
		);

		const unsupportedPayload = getExecClientPayload(
			decodeClientMessages(unsupportedRequest.writes),
		);
		expect(unsupportedPayload.message.case).toBe("grepResult");
		expect(unsupportedPayload.message.value.result.case).toBe("error");
		expect(unsupportedPayload.message.value.result.value.error).toContain(
			"Unsupported grep output mode",
		);
	});

	test("ignores non-content ripgrep JSON events while collecting grep content", async () => {
		const cwd = makeTempDir();
		const alphaPath = path.join(cwd, "alpha.txt");
		fs.writeFileSync(alphaPath, "needle one\nneighbor\n");

		const request = createH2Request();
		await handleExecServerMessage(
			makeExecMessage("grepArgs", GrepArgsSchema, {
				pattern: "needle",
				path: ".",
				outputMode: "content",
				contextAfter: 1,
				toolCallId: "grep-ignore-begin-summary",
			}),
			request.stream,
			createCursorExecBridge(cwd),
		);

		const payload = getExecClientPayload(decodeClientMessages(request.writes));
		expect(payload.message.case).toBe("grepResult");
		expect(payload.message.value.result.case).toBe("success");
		const contentWorkspace =
			payload.message.value.result.value.workspaceResults[cwd];
		expect(contentWorkspace?.result.case).toBe("content");
		expect(contentWorkspace?.result.value.totalLines).toBe(2);
		expect(contentWorkspace?.result.value.totalMatchedLines).toBe(1);
		expect(contentWorkspace?.result.value.clientTruncated).toBe(false);
		expect(contentWorkspace?.result.value.matches).toHaveLength(1);
		expect(contentWorkspace?.result.value.matches[0]?.file).toBe("alpha.txt");
		expect(
			contentWorkspace?.result.value.matches[0]?.matches.map((match: any) => ({
				lineNumber: match.lineNumber,
				content: match.content,
				isContextLine: match.isContextLine,
			})),
		).toEqual([
			{ lineNumber: 1, content: "needle one", isContextLine: false },
			{ lineNumber: 2, content: "neighbor", isContextLine: true },
		]);
	});

	test("returns a clear grep error when rg cannot be resolved", async () => {
		const cwd = makeTempDir();
		const binDir = makeTempDir("cursor-exec-bridge-bin-");
		createExecutableScript(binDir, "where", "#!/bin/sh\nexit 1\n");
		const request = createH2Request();

		await withProcessPlatform("win32", async () => {
			await withEnvironment({ PATH: binDir }, async () => {
				await handleExecServerMessage(
					makeExecMessage("grepArgs", GrepArgsSchema, {
						pattern: "needle",
						path: ".",
						outputMode: "content",
						toolCallId: "grep-missing-rg",
					}),
					request.stream,
					createCursorExecBridge(cwd),
				);
			});
		});

		const payload = getExecClientPayload(decodeClientMessages(request.writes));
		expect(payload.message.case).toBe("grepResult");
		expect(payload.message.value.result.case).toBe("error");
		expect(payload.message.value.result.value.error).toContain(
			"ripgrep (rg) is not installed",
		);
	});

	test("maps ripgrep execution failures for content, file, and count modes", async () => {
		const cwd = makeTempDir();
		fs.writeFileSync(path.join(cwd, "alpha.txt"), "needle\n");
		const bridge = createCursorExecBridge(cwd);
		const cases = [
			{ outputMode: "content", toolCallId: "grep-content-error" },
			{
				outputMode: "files_with_matches",
				toolCallId: "grep-files-with-matches-error",
			},
			{ outputMode: "count", toolCallId: "grep-count-error" },
		];

		for (const entry of cases) {
			const request = createH2Request();
			await handleExecServerMessage(
				makeExecMessage("grepArgs", GrepArgsSchema, {
					pattern: "[",
					path: ".",
					outputMode: entry.outputMode,
					toolCallId: entry.toolCallId,
				}),
				request.stream,
				bridge,
			);

			const payload = getExecClientPayload(
				decodeClientMessages(request.writes),
			);
			expect(payload.message.case).toBe("grepResult");
			expect(payload.message.value.result.case).toBe("error");
			expect(payload.message.value.result.value.error.length).toBeGreaterThan(
				0,
			);
		}
	});

	test("sends throw control messages when result mapping crashes", async () => {
		const cwd = makeTempDir();
		const request = createH2Request();

		await handleExecServerMessage(
			makeExecMessage(
				"readArgs",
				ReadArgsSchema,
				{
					path: "broken.txt",
					toolCallId: "read-throw",
				},
				{ id: 300, execId: "attached-exec" },
			),
			request.stream,
			createStubBridge(cwd, {
				readTool: createStubTool(async () => undefined),
			}),
		);

		const messages = decodeClientMessages(request.writes);
		expect(messages).toHaveLength(2);
		expect(messages[0]?.message.case).toBe("execClientControlMessage");
		expect(messages[0]?.message.value.message.case).toBe("throw");
		expect(messages[0]?.message.value.message.value.id).toBe(300);
		expect(
			messages[0]?.message.value.message.value.error.length,
		).toBeGreaterThan(0);
		expect(messages[1]?.message.case).toBe("execClientControlMessage");
		expect(messages[1]?.message.value.message.case).toBe("streamClose");
		expect(messages[1]?.message.value.message.value.id).toBe(300);
	});

	test("returns fixed results for unsupported exec message types", async () => {
		const cwd = makeTempDir();
		const bridge = createCursorExecBridge(cwd);
		const cases = [
			{
				messageCase: "diagnosticsArgs",
				schema: DiagnosticsArgsSchema,
				value: { path: "file.ts", toolCallId: "diagnostics" },
				expectedMessageCase: "diagnosticsResult",
				expectedResultCase: "rejected",
			},
			{
				messageCase: "mcpArgs",
				schema: McpArgsSchema,
				value: {
					name: "",
					args: {},
					toolCallId: "mcp",
					providerIdentifier: "provider",
					toolName: "demo-tool",
				},
				expectedMessageCase: "mcpResult",
				expectedResultCase: "toolNotFound",
			},
			{
				messageCase: "backgroundShellSpawnArgs",
				schema: BackgroundShellSpawnArgsSchema,
				value: {
					command: "sleep 1",
					workingDirectory: ".",
					toolCallId: "background-shell",
					enableWriteShellStdinTool: false,
				},
				expectedMessageCase: "backgroundShellSpawnResult",
				expectedResultCase: "error",
			},
			{
				messageCase: "writeShellStdinArgs",
				schema: WriteShellStdinArgsSchema,
				value: { shellId: 7, chars: "hello" },
				expectedMessageCase: "writeShellStdinResult",
				expectedResultCase: "error",
			},
			{
				messageCase: "fetchArgs",
				schema: FetchArgsSchema,
				value: { url: "https://example.test", toolCallId: "fetch" },
				expectedMessageCase: "fetchResult",
				expectedResultCase: "error",
			},
			{
				messageCase: "listMcpResourcesExecArgs",
				schema: ListMcpResourcesExecArgsSchema,
				value: {},
				expectedMessageCase: "listMcpResourcesExecResult",
				expectedResultCase: "rejected",
			},
			{
				messageCase: "readMcpResourceExecArgs",
				schema: ReadMcpResourceExecArgsSchema,
				value: { server: "demo", uri: "mcp://resource" },
				expectedMessageCase: "readMcpResourceExecResult",
				expectedResultCase: "rejected",
			},
			{
				messageCase: "recordScreenArgs",
				schema: RecordScreenArgsSchema,
				value: { mode: 0, toolCallId: "record-screen" },
				expectedMessageCase: "recordScreenResult",
				expectedResultCase: "failure",
			},
			{
				messageCase: "computerUseArgs",
				schema: ComputerUseArgsSchema,
				value: { toolCallId: "computer-use", actions: [] },
				expectedMessageCase: "computerUseResult",
				expectedResultCase: "error",
			},
		];

		for (const [index, entry] of cases.entries()) {
			const request = createH2Request();
			await handleExecServerMessage(
				makeExecMessage(entry.messageCase, entry.schema, entry.value, {
					id: index + 1,
				}),
				request.stream,
				bridge,
			);

			const payload = getExecClientPayload(
				decodeClientMessages(request.writes),
			);
			expect(payload.message.case).toBe(entry.expectedMessageCase);
			expect(payload.message.value.result.case).toBe(entry.expectedResultCase);
		}

		const fallbackRequest = createH2Request();
		await handleExecServerMessage(
			makeExecMessage(undefined, null, {}, { id: 400 }),
			fallbackRequest.stream,
			bridge,
		);

		const fallbackPayload = getExecClientPayload(
			decodeClientMessages(fallbackRequest.writes),
		);
		expect(fallbackPayload.message.case).toBe("listMcpResourcesExecResult");
		expect(fallbackPayload.message.value.result.case).toBe("error");
		expect(fallbackPayload.message.value.result.value.error).toContain(
			"Unsupported exec message: unknown",
		);
	});
});
