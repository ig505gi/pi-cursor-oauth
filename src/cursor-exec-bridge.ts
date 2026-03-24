import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import type * as http2 from "node:http2";
import * as os from "node:os";
import * as path from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import {
	createBashTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import {
	buildGrepArgs,
	buildOutputLocation,
	formatWorkspacePath,
	mapCursorToolToPiTool,
	parseCountLine,
	resolveToCwd,
	sanitizeShellText,
	summarizeGrepResult,
} from "./cursor-exec-utils";
import {
	AgentClientMessageSchema,
	BackgroundShellSpawnErrorSchema,
	BackgroundShellSpawnResultSchema,
	ComputerUseErrorSchema,
	ComputerUseResultSchema,
	CursorRuleSchema,
	CursorRuleTypeGlobalSchema,
	CursorRuleTypeSchema,
	DeleteErrorSchema,
	DeleteFileBusySchema,
	DeleteFileNotFoundSchema,
	DeleteNotFileSchema,
	DeletePermissionDeniedSchema,
	DeleteResultSchema,
	DeleteSuccessSchema,
	DiagnosticsRejectedSchema,
	DiagnosticsResultSchema,
	ExecClientControlMessageSchema,
	ExecClientMessageSchema,
	ExecClientStreamCloseSchema,
	ExecClientThrowSchema,
	type ExecServerControlMessage,
	type ExecServerMessage,
	FetchErrorSchema,
	FetchResultSchema,
	GrepContentMatchSchema,
	GrepContentResultSchema,
	GrepCountResultSchema,
	GrepErrorSchema,
	GrepFileCountSchema,
	GrepFileMatchSchema,
	GrepFilesResultSchema,
	GrepResultSchema,
	GrepSuccessSchema,
	GrepUnionResultSchema,
	ListMcpResourcesErrorSchema,
	ListMcpResourcesExecResultSchema,
	ListMcpResourcesRejectedSchema,
	LsDirectoryTreeNode_FileSchema,
	LsDirectoryTreeNodeSchema,
	LsErrorSchema,
	LsResultSchema,
	LsSuccessSchema,
	McpResultSchema,
	McpToolNotFoundSchema,
	ReadErrorSchema,
	ReadFileNotFoundSchema,
	ReadInvalidFileSchema,
	ReadMcpResourceExecResultSchema,
	ReadMcpResourceRejectedSchema,
	ReadPermissionDeniedSchema,
	ReadResultSchema,
	ReadSuccessSchema,
	RecordScreenFailureSchema,
	RecordScreenResultSchema,
	RequestContextEnvSchema,
	RequestContextResultSchema,
	RequestContextSchema,
	RequestContextSuccessSchema,
	ShellFailureSchema,
	ShellPermissionDeniedSchema,
	ShellRejectedSchema,
	ShellResultSchema,
	ShellSpawnErrorSchema,
	ShellStreamExitSchema,
	ShellStreamSchema,
	ShellStreamStartSchema,
	ShellStreamStderrSchema,
	ShellStreamStdoutSchema,
	ShellSuccessSchema,
	ShellTimeoutSchema,
	WriteErrorSchema,
	WriteRejectedSchema,
	WriteResultSchema,
	WriteShellStdinErrorSchema,
	WriteShellStdinResultSchema,
	WriteSuccessSchema,
} from "./cursor-gen/agent_pb";
import {
	emitNativeToolExecutionEnd,
	emitNativeToolExecutionStart,
	emitNativeToolExecutionUpdate,
	type NativeToolExecutionResult,
} from "./pi-native-tool-hack";

const MAX_INLINE_DELETE_PREVIEW_BYTES = 50 * 1024;

export interface CursorExecBridge {
	cwd: string;
	readTool: ReturnType<typeof createReadTool>;
	lsTool: ReturnType<typeof createLsTool>;
	writeTool: ReturnType<typeof createWriteTool>;
	grepTool: ReturnType<typeof createGrepTool>;
}

interface ToolExecution {
	isError: boolean;
	result?: {
		content: Array<{
			type: string;
			text?: string;
			data?: string;
			mimeType?: string;
		}>;
		details?: Record<string, unknown> | undefined;
	};
	error?: string;
}

let currentCursorExecBridge: CursorExecBridge | null = null;
const activeShellStreams = new Map<number, ChildProcess>();

export function createCursorExecBridge(cwd: string): CursorExecBridge {
	return {
		cwd,
		readTool: createReadTool(cwd),
		lsTool: createLsTool(cwd),
		writeTool: createWriteTool(cwd),
		grepTool: createGrepTool(cwd),
	};
}

export function setCursorExecBridge(bridge: CursorExecBridge | null): void {
	currentCursorExecBridge = bridge;
}

export function getCursorExecBridge(): CursorExecBridge | null {
	return currentCursorExecBridge;
}

function emitExecStart(
	toolCallId: string,
	tool: string,
	args: Record<string, unknown>,
): void {
	emitNativeToolExecutionStart(toolCallId, mapCursorToolToPiTool(tool), args);
}

function emitExecUpdate(
	toolCallId: string,
	tool: string,
	args: Record<string, unknown>,
	partialResult: NativeToolExecutionResult,
): void {
	emitNativeToolExecutionUpdate(
		toolCallId,
		mapCursorToolToPiTool(tool),
		args,
		partialResult,
	);
}

function emitExecDone(
	toolCallId: string,
	tool: string,
	result: NativeToolExecutionResult,
	isError: boolean,
): void {
	emitNativeToolExecutionEnd(
		toolCallId,
		mapCursorToolToPiTool(tool),
		result,
		isError,
	);
}

function createErrorToolResult(
	message: string,
	details?: Record<string, unknown>,
): NativeToolExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		details,
	};
}

function createTextToolResult(
	text?: string,
	details?: Record<string, unknown>,
): NativeToolExecutionResult {
	return {
		content: text ? [{ type: "text", text }] : [],
		details,
	};
}

function buildExecutionToolResult(
	execution: ToolExecution,
	details?: Record<string, unknown>,
): NativeToolExecutionResult {
	if (execution.isError) {
		return createErrorToolResult(
			execution.error || "Tool execution failed",
			details,
		);
	}
	const result = execution.result ?? createTextToolResult();
	if (!details) {
		return result;
	}
	return {
		...result,
		details: {
			...(result.details ?? {}),
			...details,
		},
	};
}

export function handleExecServerControlMessage(
	controlMsg: ExecServerControlMessage,
): void {
	if (controlMsg.message.case !== "abort") {
		return;
	}
	const child = activeShellStreams.get(controlMsg.message.value.id);
	if (!child?.pid) {
		return;
	}
	killProcessTree(child.pid);
}

export async function handleExecServerMessage(
	execMsg: ExecServerMessage,
	h2Request: http2.ClientHttp2Stream,
	bridge = currentCursorExecBridge,
): Promise<void> {
	const activeBridge = bridge ?? createCursorExecBridge(process.cwd());
	const execCase = execMsg.message.case;
	const shouldCloseStream =
		execMsg.execId.length > 0 || execCase === "shellStreamArgs";
	let streamClosed = false;

	const closeExecStream = () => {
		if (!shouldCloseStream || streamClosed) {
			return;
		}
		streamClosed = true;
		sendExecClientControlMessage(
			execMsg,
			"streamClose",
			create(ExecClientStreamCloseSchema, { id: execMsg.id }),
		);
	};

	const sendFinalExecClientMessage = (messageCase: string, value: unknown) => {
		sendExecClientMessage(execMsg, messageCase, value);
		closeExecStream();
	};

	try {
		if (execCase === "requestContextArgs") {
			sendFinalExecClientMessage(
				"requestContextResult",
				buildRequestContextResult(activeBridge.cwd),
			);
			return;
		}

		if (execCase === "readArgs") {
			const args = execMsg.message.value;
			emitExecStart(args.toolCallId, "read", { path: args.path });
			const execution = await executeTool(
				activeBridge.readTool,
				args.toolCallId,
				{ path: args.path },
			);
			emitExecDone(
				args.toolCallId,
				"read",
				buildExecutionToolResult(execution),
				execution.isError,
			);
			sendFinalExecClientMessage(
				"readResult",
				buildReadResult(args.path, activeBridge.cwd, execution),
			);
			return;
		}

		if (execCase === "lsArgs") {
			const args = execMsg.message.value;
			emitExecStart(args.toolCallId, "ls", { path: args.path || "." });
			const execution = await executeTool(
				activeBridge.lsTool,
				args.toolCallId,
				{ path: args.path },
			);
			emitExecDone(
				args.toolCallId,
				"ls",
				buildExecutionToolResult(execution),
				execution.isError,
			);
			sendFinalExecClientMessage(
				"lsResult",
				buildLsResult(args.path, activeBridge.cwd, execution),
			);
			return;
		}

		if (execCase === "writeArgs") {
			const args = execMsg.message.value;
			emitExecStart(args.toolCallId, "write", {
				path: args.path,
				content: args.fileText,
			});
			if (args.fileBytes.length > 0) {
				emitExecDone(
					args.toolCallId,
					"write",
					createErrorToolResult(
						"Binary file writes via fileBytes are not supported by this extension yet.",
					),
					true,
				);
				sendFinalExecClientMessage(
					"writeResult",
					create(WriteResultSchema, {
						result: {
							case: "rejected",
							value: create(WriteRejectedSchema, {
								path: args.path,
								reason:
									"Binary file writes via fileBytes are not supported by this extension yet.",
							}),
						},
					}),
				);
				return;
			}
			const execution = await executeTool(
				activeBridge.writeTool,
				args.toolCallId,
				{
					path: args.path,
					content: args.fileText,
				},
			);
			emitExecDone(
				args.toolCallId,
				"write",
				buildExecutionToolResult(execution),
				execution.isError,
			);
			sendFinalExecClientMessage(
				"writeResult",
				buildWriteResult(
					args.path,
					args.fileText,
					args.returnFileContentAfterWrite,
					execution,
				),
			);
			return;
		}

		if (execCase === "deleteArgs") {
			const args = execMsg.message.value;
			emitExecStart(args.toolCallId, "delete", { path: args.path });
			const deleteResult = buildDeleteResult(args.path, activeBridge.cwd);
			emitExecDone(
				args.toolCallId,
				"delete",
				deleteResult.result.case === "success"
					? createTextToolResult(deleteResult.result.value.prevContent)
					: createErrorToolResult(
							deleteResult.result.case === "error"
								? deleteResult.result.value.error
								: deleteResult.result.case === "fileNotFound"
									? `File not found: ${args.path}`
									: deleteResult.result.case === "permissionDenied"
										? deleteResult.result.value.clientVisibleError
										: deleteResult.result.case === "notFile"
											? `Not a file: ${args.path}`
											: deleteResult.result.case === "fileBusy"
												? `File is busy: ${args.path}`
												: `Delete rejected: ${args.path}`,
						),
				deleteResult.result.case !== "success",
			);
			sendFinalExecClientMessage("deleteResult", deleteResult);
			return;
		}

		if (execCase === "shellArgs") {
			const args = execMsg.message.value;
			const resolvedCwd = resolveToCwd(
				args.workingDirectory || ".",
				activeBridge.cwd,
			);
			emitExecStart(args.toolCallId, "shell", {
				command: args.command,
				timeout: args.timeout,
			});
			const bashTool = createBashTool(resolvedCwd);
			const startedAt = Date.now();
			const execution = await executeTool(bashTool, args.toolCallId, {
				command: args.command,
				timeout: args.timeout > 0 ? args.timeout : undefined,
			});
			emitExecDone(
				args.toolCallId,
				"shell",
				buildExecutionToolResult(execution, {
					fullOutputPath: execution.result?.details?.fullOutputPath,
				}),
				execution.isError,
			);
			sendFinalExecClientMessage(
				"shellResult",
				buildShellResult(
					args.command,
					resolvedCwd,
					args.timeout,
					execution,
					Date.now() - startedAt,
				),
			);
			return;
		}

		if (execCase === "shellStreamArgs") {
			const args = execMsg.message.value;
			const resolvedCwd = resolveToCwd(
				args.workingDirectory || ".",
				activeBridge.cwd,
			);
			const nativeArgs = {
				command: args.command,
				timeout: args.timeout,
			};
			emitExecStart(args.toolCallId, "shellStream", nativeArgs);
			const streamResult = await streamShellCommand(
				execMsg,
				args.toolCallId,
				args.command,
				resolvedCwd,
				args.timeout,
				args.fileOutputThresholdBytes,
				sendExecClientMessage,
				nativeArgs,
			);
			emitExecDone(
				args.toolCallId,
				"shellStream",
				createTextToolResult(
					streamResult.outputFilePath
						? `Output saved to ${streamResult.outputFilePath}`
						: streamResult.output,
					streamResult.outputFilePath
						? { fullOutputPath: streamResult.outputFilePath }
						: undefined,
				),
				streamResult.aborted || streamResult.exitCode !== 0,
			);
			closeExecStream();
			return;
		}

		if (execCase === "grepArgs") {
			const args = execMsg.message.value;
			emitExecStart(args.toolCallId, "grep", {
				pattern: args.pattern,
				path: args.path || ".",
				glob: args.glob,
			});
			const grepResult = await buildGrepResult(args, activeBridge.cwd);
			emitExecDone(
				args.toolCallId,
				"grep",
				grepResult.result.case === "success"
					? createTextToolResult(summarizeGrepResult(grepResult))
					: createErrorToolResult(
							grepResult.result.value?.error || "grep failed",
						),
				grepResult.result.case !== "success",
			);
			sendFinalExecClientMessage("grepResult", grepResult);
			return;
		}

		if (execCase === "diagnosticsArgs") {
			const args = execMsg.message.value;
			sendFinalExecClientMessage(
				"diagnosticsResult",
				create(DiagnosticsResultSchema, {
					result: {
						case: "rejected",
						value: create(DiagnosticsRejectedSchema, {
							path: args.path,
							reason:
								"Diagnostics are not available via the public pi extension API.",
						}),
					},
				}),
			);
			return;
		}

		if (execCase === "mcpArgs") {
			const args = execMsg.message.value;
			sendFinalExecClientMessage(
				"mcpResult",
				create(McpResultSchema, {
					result: {
						case: "toolNotFound",
						value: create(McpToolNotFoundSchema, {
							name: args.name || args.toolName,
							availableTools: [],
						}),
					},
				}),
			);
			return;
		}

		if (execCase === "backgroundShellSpawnArgs") {
			const args = execMsg.message.value;
			sendFinalExecClientMessage(
				"backgroundShellSpawnResult",
				create(BackgroundShellSpawnResultSchema, {
					result: {
						case: "error",
						value: create(BackgroundShellSpawnErrorSchema, {
							command: args.command,
							workingDirectory: args.workingDirectory,
							error:
								"Background shells are not supported by this extension yet.",
						}),
					},
				}),
			);
			return;
		}

		if (execCase === "writeShellStdinArgs") {
			const args = execMsg.message.value;
			sendFinalExecClientMessage(
				"writeShellStdinResult",
				create(WriteShellStdinResultSchema, {
					result: {
						case: "error",
						value: create(WriteShellStdinErrorSchema, {
							error: `Interactive shell stdin is not supported (shell_id=${args.shellId}).`,
						}),
					},
				}),
			);
			return;
		}

		if (execCase === "fetchArgs") {
			const args = execMsg.message.value;
			sendFinalExecClientMessage(
				"fetchResult",
				create(FetchResultSchema, {
					result: {
						case: "error",
						value: create(FetchErrorSchema, {
							url: args.url,
							error: "Fetch is not supported by this extension yet.",
						}),
					},
				}),
			);
			return;
		}

		if (execCase === "listMcpResourcesExecArgs") {
			sendFinalExecClientMessage(
				"listMcpResourcesExecResult",
				create(ListMcpResourcesExecResultSchema, {
					result: {
						case: "rejected",
						value: create(ListMcpResourcesRejectedSchema, {
							reason:
								"MCP resource listing is not supported by this extension yet.",
						}),
					},
				}),
			);
			return;
		}

		if (execCase === "readMcpResourceExecArgs") {
			const args = execMsg.message.value;
			sendFinalExecClientMessage(
				"readMcpResourceExecResult",
				create(ReadMcpResourceExecResultSchema, {
					result: {
						case: "rejected",
						value: create(ReadMcpResourceRejectedSchema, {
							uri: args.uri,
							reason:
								"MCP resource reads are not supported by this extension yet.",
						}),
					},
				}),
			);
			return;
		}

		if (execCase === "recordScreenArgs") {
			sendFinalExecClientMessage(
				"recordScreenResult",
				create(RecordScreenResultSchema, {
					result: {
						case: "failure",
						value: create(RecordScreenFailureSchema, {
							error: "Screen recording is not supported by this extension yet.",
						}),
					},
				}),
			);
			return;
		}

		if (execCase === "computerUseArgs") {
			sendFinalExecClientMessage(
				"computerUseResult",
				create(ComputerUseResultSchema, {
					result: {
						case: "error",
						value: create(ComputerUseErrorSchema, {
							error: "Computer use is not supported by this extension yet.",
							actionCount: 0,
							durationMs: 0,
						}),
					},
				}),
			);
			return;
		}

		sendFinalExecClientMessage(
			"listMcpResourcesExecResult",
			create(ListMcpResourcesExecResultSchema, {
				result: {
					case: "error",
					value: create(ListMcpResourcesErrorSchema, {
						error: `Unsupported exec message: ${execCase ?? "unknown"}`,
					}),
				},
			}),
		);
	} catch (error) {
		sendExecClientControlMessage(
			execMsg,
			"throw",
			create(ExecClientThrowSchema, {
				id: execMsg.id,
				error: error instanceof Error ? error.message : String(error),
				stackTrace: error instanceof Error ? error.stack : undefined,
			}),
		);
		closeExecStream();
	}

	function sendExecClientMessage(
		incoming: ExecServerMessage,
		messageCase: string,
		value: unknown,
	): void {
		const clientMessage = create(AgentClientMessageSchema, {
			message: {
				case: "execClientMessage",
				value: create(ExecClientMessageSchema, {
					id: incoming.id,
					execId: incoming.execId,
					message: { case: messageCase as never, value: value as never },
				}),
			},
		});
		h2Request.write(
			frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)),
		);
	}

	function sendExecClientControlMessage(
		_incoming: ExecServerMessage,
		messageCase: string,
		value: unknown,
	): void {
		const clientMessage = create(AgentClientMessageSchema, {
			message: {
				case: "execClientControlMessage",
				value: create(ExecClientControlMessageSchema, {
					message: { case: messageCase as never, value: value as never },
				}),
			},
		});
		h2Request.write(
			frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)),
		);
	}
}

async function executeTool(
	tool: { execute: Function },
	toolCallId: string,
	params: Record<string, unknown>,
): Promise<ToolExecution> {
	try {
		const result = await tool.execute(toolCallId, params, undefined, undefined);
		return { isError: false, result };
	} catch (error) {
		return {
			isError: true,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

type ExecMessageSender = (
	incoming: ExecServerMessage,
	messageCase: string,
	value: unknown,
) => void;

interface CursorGrepArgs {
	pattern: string;
	path?: string;
	glob?: string;
	outputMode?: string;
	contextBefore?: number;
	contextAfter?: number;
	context?: number;
	caseInsensitive?: boolean;
	type?: string;
	headLimit?: number;
	multiline?: boolean;
	sort?: string;
	sortAscending?: boolean;
}

interface GrepCollectedLine {
	lineNumber: number;
	content: string;
	contentTruncated: boolean;
	isContextLine: boolean;
}

interface GrepContentCollection {
	files: Map<string, GrepCollectedLine[]>;
	totalLines: number;
	totalMatchedLines: number;
	clientTruncated: boolean;
	ripgrepTruncated: boolean;
}

async function streamShellCommand(
	execMsg: ExecServerMessage,
	toolCallId: string,
	command: string,
	workingDirectory: string,
	timeoutSeconds: number,
	fileOutputThresholdBytes: bigint | undefined,
	sendExecClientMessage: ExecMessageSender,
	nativeArgs: Record<string, unknown>,
): Promise<{
	exitCode: number;
	aborted: boolean;
	outputFilePath?: string;
	output: string;
}> {
	if (!fs.existsSync(workingDirectory)) {
		sendExecClientMessage(
			execMsg,
			"shellStream",
			create(ShellStreamSchema, {
				event: {
					case: "rejected",
					value: create(ShellRejectedSchema, {
						command,
						workingDirectory,
						reason: `Working directory does not exist: ${workingDirectory}`,
						isReadonly: false,
					}),
				},
			}),
		);
		return {
			exitCode: 1,
			aborted: false,
			output: `Working directory does not exist: ${workingDirectory}`,
		};
	}

	try {
		fs.accessSync(workingDirectory, fs.constants.X_OK | fs.constants.R_OK);
	} catch {
		sendExecClientMessage(
			execMsg,
			"shellStream",
			create(ShellStreamSchema, {
				event: {
					case: "permissionDenied",
					value: create(ShellPermissionDeniedSchema, {
						command,
						workingDirectory,
						error: `Permission denied: ${workingDirectory}`,
						isReadonly: false,
					}),
				},
			}),
		);
		return {
			exitCode: 1,
			aborted: false,
			output: `Permission denied: ${workingDirectory}`,
		};
	}

	const shellConfig = getShellConfig();
	const child = spawn(shellConfig.shell, [...shellConfig.args, command], {
		cwd: workingDirectory,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	activeShellStreams.set(execMsg.id, child);

	sendExecClientMessage(
		execMsg,
		"shellStream",
		create(ShellStreamSchema, {
			event: { case: "start", value: create(ShellStreamStartSchema, {}) },
		}),
	);

	const threshold =
		typeof fileOutputThresholdBytes === "bigint"
			? Number(fileOutputThresholdBytes)
			: 0;
	let totalOutputBytes = 0;
	let bufferedOutput: Buffer[] = [];
	let outputFilePath: string | undefined;
	let timedOut = false;
	let accumulatedOutput = "";

	const appendOutput = (chunk: Buffer) => {
		totalOutputBytes += chunk.length;
		if (!outputFilePath && threshold > 0 && totalOutputBytes > threshold) {
			outputFilePath = path.join(
				os.tmpdir(),
				`cursor-shell-stream-${crypto.randomUUID()}.log`,
			);
			for (const bufferedChunk of bufferedOutput) {
				fs.appendFileSync(outputFilePath, bufferedChunk);
			}
			bufferedOutput = [];
		}
		if (outputFilePath) {
			fs.appendFileSync(outputFilePath, chunk);
		} else {
			bufferedOutput.push(chunk);
		}
	};

	child.stdout?.on("data", (chunk: Buffer) => {
		appendOutput(chunk);
		accumulatedOutput += sanitizeShellText(chunk.toString("utf8"));
		emitExecUpdate(toolCallId, "shellStream", nativeArgs, {
			content: accumulatedOutput
				? [{ type: "text", text: accumulatedOutput }]
				: [],
		});
		sendExecClientMessage(
			execMsg,
			"shellStream",
			create(ShellStreamSchema, {
				event: {
					case: "stdout",
					value: create(ShellStreamStdoutSchema, {
						data: sanitizeShellText(chunk.toString("utf8")),
					}),
				},
			}),
		);
	});

	child.stderr?.on("data", (chunk: Buffer) => {
		appendOutput(chunk);
		accumulatedOutput += sanitizeShellText(chunk.toString("utf8"));
		emitExecUpdate(toolCallId, "shellStream", nativeArgs, {
			content: accumulatedOutput
				? [{ type: "text", text: accumulatedOutput }]
				: [],
		});
		sendExecClientMessage(
			execMsg,
			"shellStream",
			create(ShellStreamSchema, {
				event: {
					case: "stderr",
					value: create(ShellStreamStderrSchema, {
						data: sanitizeShellText(chunk.toString("utf8")),
					}),
				},
			}),
		);
	});

	const timeoutHandle =
		timeoutSeconds > 0
			? setTimeout(() => {
					timedOut = true;
					killProcessTree(child.pid);
				}, timeoutSeconds * 1000)
			: undefined;

	const exitCode = await new Promise<number>((resolve) => {
		child.on("error", (error) => {
			activeShellStreams.delete(execMsg.id);
			const errorText = sanitizeShellText(String(error));
			accumulatedOutput += errorText;
			emitExecUpdate(toolCallId, "shellStream", nativeArgs, {
				content: accumulatedOutput
					? [{ type: "text", text: accumulatedOutput }]
					: [],
			});
			sendExecClientMessage(
				execMsg,
				"shellStream",
				create(ShellStreamSchema, {
					event: {
						case: "stderr",
						value: create(ShellStreamStderrSchema, {
							data: errorText,
						}),
					},
				}),
			);
			resolve(1);
		});
		child.on("close", (code) => {
			activeShellStreams.delete(execMsg.id);
			resolve(code ?? 1);
		});
	});

	if (timeoutHandle) {
		clearTimeout(timeoutHandle);
	}

	sendExecClientMessage(
		execMsg,
		"shellStream",
		create(ShellStreamSchema, {
			event: {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: exitCode,
					cwd: workingDirectory,
					outputLocation: buildOutputLocation(outputFilePath),
					aborted: timedOut,
				}),
			},
		}),
	);

	return {
		exitCode,
		aborted: timedOut,
		outputFilePath,
		output: accumulatedOutput,
	};
}

async function buildGrepResult(args: CursorGrepArgs, cwd: string) {
	try {
		const rgPath = findRgBinary();
		if (!rgPath) {
			return create(GrepResultSchema, {
				result: {
					case: "error",
					value: create(GrepErrorSchema, {
						error: "ripgrep (rg) is not installed or not available on PATH.",
					}),
				},
			});
		}

		const searchPath = resolveToCwd(args.path || ".", cwd);
		const outputMode = args.outputMode || "content";
		const workspaceKey = cwd;
		const headLimit =
			args.headLimit && args.headLimit > 0 ? args.headLimit : undefined;

		let unionResult:
			| ReturnType<typeof create<typeof GrepUnionResultSchema>>
			| undefined;
		if (outputMode === "content") {
			const collected = await runGrepContent(
				rgPath,
				args,
				searchPath,
				cwd,
				headLimit,
			);
			unionResult = create(GrepUnionResultSchema, {
				result: {
					case: "content",
					value: create(GrepContentResultSchema, {
						matches: [...collected.files.entries()].map(([file, matches]) =>
							create(GrepFileMatchSchema, {
								file,
								matches: matches.map((match) =>
									create(GrepContentMatchSchema, {
										lineNumber: match.lineNumber,
										content: match.content,
										contentTruncated: match.contentTruncated,
										isContextLine: match.isContextLine,
									}),
								),
							}),
						),
						totalLines: collected.totalLines,
						totalMatchedLines: collected.totalMatchedLines,
						clientTruncated: collected.clientTruncated,
						ripgrepTruncated: collected.ripgrepTruncated,
					}),
				},
			});
		} else if (outputMode === "files_with_matches") {
			const files = await runGrepFiles(
				rgPath,
				args,
				searchPath,
				cwd,
				headLimit,
			);
			unionResult = create(GrepUnionResultSchema, {
				result: {
					case: "files",
					value: create(GrepFilesResultSchema, files),
				},
			});
		} else if (outputMode === "count") {
			const countResult = await runGrepCount(
				rgPath,
				args,
				searchPath,
				cwd,
				headLimit,
			);
			unionResult = create(GrepUnionResultSchema, {
				result: {
					case: "count",
					value: create(GrepCountResultSchema, countResult),
				},
			});
		} else {
			return create(GrepResultSchema, {
				result: {
					case: "error",
					value: create(GrepErrorSchema, {
						error: `Unsupported grep output mode: ${outputMode}`,
					}),
				},
			});
		}

		return create(GrepResultSchema, {
			result: {
				case: "success",
				value: create(GrepSuccessSchema, {
					pattern: args.pattern,
					path: args.path || ".",
					outputMode,
					workspaceResults: { [workspaceKey]: unionResult },
				}),
			},
		});
	} catch (error) {
		return create(GrepResultSchema, {
			result: {
				case: "error",
				value: create(GrepErrorSchema, {
					error: error instanceof Error ? error.message : String(error),
				}),
			},
		});
	}
}

async function runGrepContent(
	rgPath: string,
	args: CursorGrepArgs,
	searchPath: string,
	cwd: string,
	headLimit?: number,
): Promise<GrepContentCollection> {
	const rgArgs = buildGrepArgs(args, searchPath, "content");
	const output = await runCommand(rgPath, rgArgs, cwd);
	if (output.exitCode !== 0 && output.exitCode !== 1) {
		throw new Error(
			output.stderr.trim() || `ripgrep exited with code ${output.exitCode}`,
		);
	}

	const files = new Map<string, GrepCollectedLine[]>();
	let totalLines = 0;
	let totalMatchedLines = 0;
	let clientTruncated = false;

	for (const line of splitLines(output.stdout)) {
		if (!line.trim()) {
			continue;
		}
		const event = JSON.parse(line) as {
			type?: string;
			data?: {
				path?: { text?: string };
				lines?: { text?: string };
				line_number?: number;
			};
		};
		if (event.type !== "match" && event.type !== "context") {
			continue;
		}
		const absoluteFile = event.data?.path?.text;
		const lineNumber = event.data?.line_number;
		const content = event.data?.lines?.text;
		if (
			!absoluteFile ||
			typeof lineNumber !== "number" ||
			typeof content !== "string"
		) {
			continue;
		}
		totalLines += 1;
		if (event.type === "match") {
			totalMatchedLines += 1;
		}
		if (headLimit && totalMatchedLines > headLimit) {
			clientTruncated = true;
			continue;
		}
		const file = formatWorkspacePath(absoluteFile, cwd);
		const existing = files.get(file) ?? [];
		existing.push({
			lineNumber,
			content: trimTrailingNewline(content),
			contentTruncated: false,
			isContextLine: event.type === "context",
		});
		files.set(file, existing);
	}

	return {
		files,
		totalLines,
		totalMatchedLines,
		clientTruncated,
		ripgrepTruncated: false,
	};
}

async function runGrepFiles(
	rgPath: string,
	args: CursorGrepArgs,
	searchPath: string,
	cwd: string,
	headLimit?: number,
): Promise<{
	files: string[];
	totalFiles: number;
	clientTruncated: boolean;
	ripgrepTruncated: boolean;
}> {
	const rgArgs = buildGrepArgs(args, searchPath, "files_with_matches");
	const output = await runCommand(rgPath, rgArgs, cwd);
	if (output.exitCode !== 0 && output.exitCode !== 1) {
		throw new Error(
			output.stderr.trim() || `ripgrep exited with code ${output.exitCode}`,
		);
	}
	const allFiles = output.stdout
		.split("\0")
		.map((entry) => trimTrailingNewline(entry))
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => formatWorkspacePath(entry, cwd));
	const limited = headLimit ? allFiles.slice(0, headLimit) : allFiles;
	return {
		files: limited,
		totalFiles: allFiles.length,
		clientTruncated: Boolean(headLimit && allFiles.length > headLimit),
		ripgrepTruncated: false,
	};
}

async function runGrepCount(
	rgPath: string,
	args: CursorGrepArgs,
	searchPath: string,
	cwd: string,
	headLimit?: number,
): Promise<{
	counts: Array<{ file: string; count: number }>;
	totalFiles: number;
	totalMatches: number;
	clientTruncated: boolean;
	ripgrepTruncated: boolean;
}> {
	const rgArgs = buildGrepArgs(args, searchPath, "count");
	const output = await runCommand(rgPath, rgArgs, cwd);
	if (output.exitCode !== 0 && output.exitCode !== 1) {
		throw new Error(
			output.stderr.trim() || `ripgrep exited with code ${output.exitCode}`,
		);
	}
	const counts = splitLines(output.stdout)
		.map((line) => trimTrailingNewline(line))
		.map((line) => parseCountLine(line, cwd))
		.filter(
			(entry): entry is { file: string; count: number } => entry !== null,
		);
	const limited = headLimit ? counts.slice(0, headLimit) : counts;
	return {
		counts: limited.map((entry) => create(GrepFileCountSchema, entry)),
		totalFiles: counts.length,
		totalMatches: counts.reduce((sum, entry) => sum + entry.count, 0),
		clientTruncated: Boolean(headLimit && counts.length > headLimit),
		ripgrepTruncated: false,
	};
}

async function runCommand(
	command: string,
	args: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				exitCode: code ?? 1,
			});
		});
	});
}

function findRgBinary(): string | null {
	if (process.platform === "win32") {
		return (
			findCommandOnPath("rg.exe", "where") ?? findCommandOnPath("rg", "where")
		);
	}
	return findCommandOnPath("rg", "which");
}

function trimTrailingNewline(text: string): string {
	return text.replace(/[\r\n]+$/, "");
}

function splitLines(text: string): string[] {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function buildRequestContextResult(cwd: string) {
	const capabilityRule = create(CursorRuleSchema, {
		fullPath: ".cursor/rules/pi-cursor-oauth-exec-bridge.mdc",
		content: [
			"This session is using the pi-cursor-oauth exec bridge.",
			"Supported native exec calls: read, ls, grep (content/files_with_matches/count), write for text content, delete, shell, shellStream, and requestContext.",
			"Use requestContext or ls to orient yourself before broad repository searches.",
			"Use grep when searching file contents or when you already know the likely directory or file pattern.",
			"When possible, use workspace-relative paths returned by tools.",
			"Write only supports text writes. Do not attempt binary writes via fileBytes.",
			"Unsupported exec capabilities include background shells, writeShellStdin, MCP resource operations, recordScreen, and computerUse.",
			"If an unsupported capability is needed, fall back to supported read/ls/grep/shell workflows.",
		].join("\n"),
		type: create(CursorRuleTypeSchema, {
			type: { case: "global", value: create(CursorRuleTypeGlobalSchema, {}) },
		}),
		source: 0,
	});

	const requestContext = create(RequestContextSchema, {
		rules: [capabilityRule],
		env: create(RequestContextEnvSchema, {
			workspacePaths: [cwd],
		}),
		repositoryInfo: [],
		tools: [],
		gitRepos: [],
		projectLayouts: [],
		mcpInstructions: [],
		fileContents: {},
		customSubagents: [],
		cloudRule:
			"Supported exec bridge: read, ls, grep(content/files_with_matches/count), text write, delete, shell, shellStream. Unsupported: binary write, background shell, writeShellStdin, MCP resources, recordScreen, computerUse.",
	});

	return create(RequestContextResultSchema, {
		result: {
			case: "success",
			value: create(RequestContextSuccessSchema, { requestContext }),
		},
	});
}

function buildReadResult(
	requestPath: string,
	cwd: string,
	execution: ToolExecution,
) {
	if (execution.isError) {
		const error = execution.error || "Unknown read error";
		if (isNotFoundError(error)) {
			return create(ReadResultSchema, {
				result: {
					case: "fileNotFound",
					value: create(ReadFileNotFoundSchema, { path: requestPath }),
				},
			});
		}
		if (isPermissionError(error)) {
			return create(ReadResultSchema, {
				result: {
					case: "permissionDenied",
					value: create(ReadPermissionDeniedSchema, { path: requestPath }),
				},
			});
		}
		if (isDirectoryError(error)) {
			return create(ReadResultSchema, {
				result: {
					case: "invalidFile",
					value: create(ReadInvalidFileSchema, {
						path: requestPath,
						reason: "Path is a directory, not a file.",
					}),
				},
			});
		}
		return create(ReadResultSchema, {
			result: {
				case: "error",
				value: create(ReadErrorSchema, { path: requestPath, error }),
			},
		});
	}

	const result = execution.result!;
	const absolutePath = resolveToCwd(requestPath, cwd);
	const stat = safeStat(absolutePath);
	const textItem = result.content.find(
		(item) => item.type === "text" && typeof item.text === "string",
	);
	const imageItem = result.content.find(
		(item) => item.type === "image" && typeof item.data === "string",
	);

	if (imageItem?.data) {
		return create(ReadResultSchema, {
			result: {
				case: "success",
				value: create(ReadSuccessSchema, {
					path: requestPath,
					totalLines: 0,
					fileSize: BigInt(
						stat?.size ?? Buffer.from(imageItem.data, "base64").length,
					),
					truncated: false,
					output: {
						case: "data",
						value: Buffer.from(imageItem.data, "base64"),
					},
				}),
			},
		});
	}

	const text = textItem?.text || "";
	const fullText = safeReadUtf8(absolutePath);
	const totalLines =
		fullText !== null ? countLines(fullText) : countLines(text);
	const truncation = result.details?.truncation;

	return create(ReadResultSchema, {
		result: {
			case: "success",
			value: create(ReadSuccessSchema, {
				path: requestPath,
				totalLines,
				fileSize: BigInt(stat?.size ?? Buffer.byteLength(text, "utf8")),
				truncated: Boolean(truncation),
				output: { case: "content", value: text },
			}),
		},
	});
}

function buildLsResult(
	requestPath: string,
	cwd: string,
	execution: ToolExecution,
) {
	if (execution.isError) {
		return create(LsResultSchema, {
			result: {
				case: "error",
				value: create(LsErrorSchema, {
					path: requestPath,
					error: execution.error || "Unknown ls error",
				}),
			},
		});
	}

	const text = getPrimaryText(execution.result);
	const resolvedPath = resolveToCwd(requestPath || ".", cwd);
	if (text === "(empty directory)") {
		return create(LsResultSchema, {
			result: {
				case: "success",
				value: create(LsSuccessSchema, {
					directoryTreeRoot: create(LsDirectoryTreeNodeSchema, {
						absPath: resolvedPath,
						childrenDirs: [],
						childrenFiles: [],
						childrenWereProcessed: true,
						fullSubtreeExtensionCounts: {},
						numFiles: 0,
					}),
				}),
			},
		});
	}

	const entries = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !isNoticeLine(line));

	const childrenDirs = entries
		.filter((entry) => entry.endsWith("/"))
		.map((entry) => {
			const dirName = entry.slice(0, -1);
			return create(LsDirectoryTreeNodeSchema, {
				absPath: path.join(resolvedPath, dirName),
				childrenDirs: [],
				childrenFiles: [],
				childrenWereProcessed: false,
				fullSubtreeExtensionCounts: {},
				numFiles: 0,
			});
		});
	const childrenFiles = entries
		.filter((entry) => !entry.endsWith("/"))
		.map((entry) => create(LsDirectoryTreeNode_FileSchema, { name: entry }));

	return create(LsResultSchema, {
		result: {
			case: "success",
			value: create(LsSuccessSchema, {
				directoryTreeRoot: create(LsDirectoryTreeNodeSchema, {
					absPath: resolvedPath,
					childrenDirs,
					childrenFiles,
					childrenWereProcessed: true,
					fullSubtreeExtensionCounts: {},
					numFiles: childrenFiles.length,
				}),
			}),
		},
	});
}

function buildWriteResult(
	requestPath: string,
	content: string,
	returnFileContentAfterWrite: boolean,
	execution: ToolExecution,
) {
	if (execution.isError) {
		return create(WriteResultSchema, {
			result: {
				case: "error",
				value: create(WriteErrorSchema, {
					path: requestPath,
					error: execution.error || "Unknown write error",
				}),
			},
		});
	}

	return create(WriteResultSchema, {
		result: {
			case: "success",
			value: create(WriteSuccessSchema, {
				path: requestPath,
				linesCreated: countLines(content),
				fileSize: Buffer.byteLength(content, "utf8"),
				fileContentAfterWrite: returnFileContentAfterWrite
					? content
					: undefined,
			}),
		},
	});
}

function buildDeleteResult(requestPath: string, cwd: string) {
	const absolutePath = resolveToCwd(requestPath, cwd);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(absolutePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isNotFoundError(message)) {
			return create(DeleteResultSchema, {
				result: {
					case: "fileNotFound",
					value: create(DeleteFileNotFoundSchema, { path: requestPath }),
				},
			});
		}
		if (isPermissionError(message)) {
			return create(DeleteResultSchema, {
				result: {
					case: "permissionDenied",
					value: create(DeletePermissionDeniedSchema, {
						path: requestPath,
						clientVisibleError: message,
						isReadonly: true,
					}),
				},
			});
		}
		return create(DeleteResultSchema, {
			result: {
				case: "error",
				value: create(DeleteErrorSchema, { path: requestPath, error: message }),
			},
		});
	}

	if (!stat.isFile()) {
		return create(DeleteResultSchema, {
			result: {
				case: "notFile",
				value: create(DeleteNotFileSchema, {
					path: requestPath,
					actualType: stat.isDirectory() ? "directory" : "other",
				}),
			},
		});
	}

	const prevContent = readDeletePreview(absolutePath, stat.size);
	try {
		fs.rmSync(absolutePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isPermissionError(message)) {
			return create(DeleteResultSchema, {
				result: {
					case: "permissionDenied",
					value: create(DeletePermissionDeniedSchema, {
						path: requestPath,
						clientVisibleError: message,
						isReadonly: true,
					}),
				},
			});
		}
		if (message.includes("EBUSY")) {
			return create(DeleteResultSchema, {
				result: {
					case: "fileBusy",
					value: create(DeleteFileBusySchema, { path: requestPath }),
				},
			});
		}
		return create(DeleteResultSchema, {
			result: {
				case: "error",
				value: create(DeleteErrorSchema, { path: requestPath, error: message }),
			},
		});
	}

	return create(DeleteResultSchema, {
		result: {
			case: "success",
			value: create(DeleteSuccessSchema, {
				path: requestPath,
				deletedFile: path.basename(absolutePath),
				fileSize: BigInt(stat.size),
				prevContent,
			}),
		},
	});
}

function buildShellResult(
	command: string,
	workingDirectory: string,
	timeoutSeconds: number,
	execution: ToolExecution,
	executionTimeMs: number,
) {
	if (execution.isError) {
		const error = execution.error || "Unknown shell error";
		if (error.includes("Command timed out after")) {
			return create(ShellResultSchema, {
				result: {
					case: "timeout",
					value: create(ShellTimeoutSchema, {
						command,
						workingDirectory,
						timeoutMs: timeoutSeconds * 1000,
					}),
				},
			});
		}
		if (
			error.includes("Working directory does not exist") ||
			error.includes("spawn")
		) {
			return create(ShellResultSchema, {
				result: {
					case: "spawnError",
					value: create(ShellSpawnErrorSchema, {
						command,
						workingDirectory,
						error,
					}),
				},
			});
		}
		return create(ShellResultSchema, {
			result: {
				case: "failure",
				value: create(ShellFailureSchema, {
					command,
					workingDirectory,
					exitCode: 1,
					signal: "",
					stdout: "",
					stderr: error,
					executionTime: executionTimeMs,
					interleavedOutput: error,
					aborted: false,
				}),
			},
		});
	}

	const text = getPrimaryText(execution.result);
	const outputLocation = buildOutputLocation(
		execution.result?.details?.fullOutputPath,
	);
	return create(ShellResultSchema, {
		result: {
			case: "success",
			value: create(ShellSuccessSchema, {
				command,
				workingDirectory,
				exitCode: 0,
				signal: "",
				stdout: text,
				stderr: "",
				executionTime: executionTimeMs,
				outputLocation,
				interleavedOutput: text,
			}),
		},
	});
}

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function getPrimaryText(result: ToolExecution["result"] | undefined): string {
	return (
		result?.content
			.filter((item) => item.type === "text" && typeof item.text === "string")
			.map((item) => item.text || "")
			.join("\n") || ""
	);
}

function countLines(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	return text.split("\n").length;
}

function isNoticeLine(line: string): boolean {
	return line.startsWith("[") && line.endsWith("]");
}

function isNotFoundError(error: string): boolean {
	return (
		error.includes("ENOENT") ||
		error.includes("not found") ||
		error.includes("No such file")
	);
}

function isPermissionError(error: string): boolean {
	return (
		error.includes("EACCES") ||
		error.includes("EPERM") ||
		error.includes("permission denied")
	);
}

function isDirectoryError(error: string): boolean {
	return error.includes("EISDIR") || error.includes("is a directory");
}

function safeStat(filePath: string): fs.Stats | null {
	try {
		return fs.statSync(filePath);
	} catch {
		return null;
	}
}

function safeReadUtf8(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
}

function readDeletePreview(filePath: string, size: number): string {
	try {
		if (size > MAX_INLINE_DELETE_PREVIEW_BYTES) {
			return `[previous content omitted: ${size} bytes]`;
		}
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return "[previous content unavailable]";
	}
}

function getShellConfig(): { shell: string; args: string[] } {
	if (process.platform === "win32") {
		const bashOnPath = findCommandOnPath("bash.exe", "where");
		if (bashOnPath) {
			return { shell: bashOnPath, args: ["-lc"] };
		}
		return {
			shell: process.env.ComSpec || "cmd.exe",
			args: ["/d", "/s", "/c"],
		};
	}
	if (fs.existsSync("/bin/bash")) {
		return { shell: "/bin/bash", args: ["-lc"] };
	}
	const bashOnPath = findCommandOnPath("bash", "which");
	if (bashOnPath) {
		return { shell: bashOnPath, args: ["-lc"] };
	}
	return { shell: "sh", args: ["-lc"] };
}

function findCommandOnPath(
	command: string,
	resolver: "which" | "where",
): string | null {
	try {
		const result = spawnSync(resolver, [command], {
			encoding: "utf-8",
			timeout: 5000,
		});
		if (result.status !== 0 || !result.stdout) {
			return null;
		}
		const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
		return firstMatch || null;
	} catch {
		return null;
	}
}

function killProcessTree(pid: number | undefined): void {
	if (!pid) {
		return;
	}
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			// Ignore cleanup errors.
		}
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already exited.
		}
	}
}
