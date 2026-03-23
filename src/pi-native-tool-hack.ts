import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	buildTailMessage,
	clearSplitState,
	cloneAssistantMessage,
	getSplitState,
	hasVisibleAssistantContent,
	patchCursorAssistantEvent,
} from "./pi-native-tool-hack-helpers";

const PI_PACKAGE_NAME = "@mariozechner/pi-coding-agent";
const PI_INTERACTIVE_MODE_RELATIVE_PATH = path.join(
	"dist",
	"modes",
	"interactive",
	"interactive-mode.js",
);
const PI_ASSISTANT_MESSAGE_RELATIVE_PATH = path.join(
	"dist",
	"modes",
	"interactive",
	"components",
	"assistant-message.js",
);

interface PiNativeToolHackModulePaths {
	interactiveModePath: string;
	assistantMessagePath: string;
}

interface PiNativeToolHackResolverRuntime {
	resolveImport: (specifier: string) => Promise<string>;
	existsSync: (candidatePath: string) => boolean;
	readFileSync: (candidatePath: string, encoding: "utf8") => string;
	realpathSync: (candidatePath: string) => string;
	argv: string[];
	execPath: string;
	env: NodeJS.ProcessEnv;
}

let currentInteractiveMode: any = null;
let installPromise: Promise<void> | null = null;
let AssistantMessageComponentClass: any = null;
let resolvedPiNativeToolHackModulePaths: PiNativeToolHackModulePaths | null =
	null;

export function __resetPiNativeToolHackForTests(): void {
	currentInteractiveMode = null;
	installPromise = null;
	AssistantMessageComponentClass = null;
	resolvedPiNativeToolHackModulePaths = null;
}

export async function __resolvePiNativeToolHackModulePathsForTests(
	options?: Partial<PiNativeToolHackResolverRuntime>,
): Promise<PiNativeToolHackModulePaths> {
	return await resolvePiNativeToolHackModulePaths(options);
}

export interface NativeToolExecutionResult {
	content?: Array<{
		type: string;
		text?: string;
		data?: string;
		mimeType?: string;
	}>;
	details?: Record<string, unknown>;
}

export function installPiNativeToolHack(): Promise<void> {
	if (installPromise) {
		return installPromise;
	}

	installPromise = (async () => {
		const { interactiveModePath, assistantMessagePath } =
			await resolvePiNativeToolHackModulePaths();
		let interactiveModeModule: unknown;
		let assistantMessageModule: unknown;
		try {
			[interactiveModeModule, assistantMessageModule] = await Promise.all([
				import(pathToFileURL(interactiveModePath).href),
				import(pathToFileURL(assistantMessagePath).href),
			]);
		} catch (error) {
			throw createPiNativeToolHackError(
				[
					"Failed to import private pi interactive modules for the native tool hack.",
					`interactive-mode: ${interactiveModePath}`,
					`assistant-message: ${assistantMessagePath}`,
					"This extension depends on private pi internals that may have changed in this pi version.",
				].join("\n"),
				error,
			);
		}
		AssistantMessageComponentClass = (
			assistantMessageModule as {
				AssistantMessageComponent?: unknown;
			}
		).AssistantMessageComponent;
		const prototype = (
			interactiveModeModule as {
				InteractiveMode?: { prototype?: Record<string, unknown> };
			}
		).InteractiveMode?.prototype as Record<string, unknown> | undefined;
		if (!prototype || prototype.__cursorNativeHackInstalled) {
			return;
		}
		const originalHandleEvent = prototype.handleEvent;
		if (typeof originalHandleEvent !== "function") {
			return;
		}

		prototype.handleEvent = async function (this: any, event: any) {
			const patchedEvent = patchCursorAssistantEvent(this, event);
			currentInteractiveMode = this;
			await originalHandleEvent.call(this, patchedEvent);
			currentInteractiveMode = this;
			afterHandleEvent(this, event);
		};
		prototype.__cursorNativeHackInstalled = true;
	})().catch((error) => {
		installPromise = null;
		throw error;
	});

	return installPromise;
}

export function emitNativeToolExecutionStart(
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
): void {
	dispatchNativeToolEvent({
		type: "tool_execution_start",
		toolCallId,
		toolName,
		args,
	});
}

export function emitNativeToolExecutionUpdate(
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
	partialResult: NativeToolExecutionResult,
): void {
	dispatchNativeToolEvent({
		type: "tool_execution_update",
		toolCallId,
		toolName,
		args,
		partialResult,
	});
}

export function emitNativeToolExecutionEnd(
	toolCallId: string,
	toolName: string,
	result: NativeToolExecutionResult,
	isError: boolean,
): void {
	dispatchNativeToolEvent({
		type: "tool_execution_end",
		toolCallId,
		toolName,
		result,
		isError,
	});
}

function dispatchNativeToolEvent(event: Record<string, unknown>): void {
	const interactiveMode = currentInteractiveMode;
	if (!interactiveMode || typeof interactiveMode.handleEvent !== "function") {
		return;
	}
	void interactiveMode.handleEvent({
		...event,
		__cursorNativeHack: true,
	});
}

async function resolvePiNativeToolHackModulePaths(
	options?: Partial<PiNativeToolHackResolverRuntime>,
): Promise<PiNativeToolHackModulePaths> {
	const useCache = !options;
	if (useCache && resolvedPiNativeToolHackModulePaths) {
		return resolvedPiNativeToolHackModulePaths;
	}

	const runtime = createResolverRuntime(options);
	const { packageRoot, diagnostics } = await resolvePiPackageRoot(runtime);
	const modulePaths = buildPiNativeToolHackModulePaths(packageRoot);
	const missingPaths = [
		modulePaths.interactiveModePath,
		modulePaths.assistantMessagePath,
	].filter((candidatePath) => !runtime.existsSync(candidatePath));
	if (missingPaths.length > 0) {
		throw createPiNativeToolHackError(
			[
				"Failed to locate private pi interactive modules for the native tool hack.",
				...diagnostics,
				`Chosen pi package root: ${packageRoot}`,
				`Expected interactive-mode: ${modulePaths.interactiveModePath}`,
				`Expected assistant-message: ${modulePaths.assistantMessagePath}`,
				`Missing: ${missingPaths.join(", ")}`,
				"This extension depends on private pi internals that may have moved in this pi version.",
			].join("\n"),
		);
	}

	if (useCache) {
		resolvedPiNativeToolHackModulePaths = modulePaths;
	}
	return modulePaths;
}

async function resolvePiPackageRoot(
	runtime: PiNativeToolHackResolverRuntime,
): Promise<{ packageRoot: string; diagnostics: string[] }> {
	const diagnostics: string[] = [];
	const candidateRoots = collectPiPackageRootCandidates(runtime, diagnostics);

	try {
		const piEntryUrl = await runtime.resolveImport(PI_PACKAGE_NAME);
		const piEntryPath = fileURLToPath(piEntryUrl);
		diagnostics.push(`Resolved ${PI_PACKAGE_NAME}: ${piEntryPath}`);
		candidateRoots.push(path.resolve(piEntryPath, "..", ".."));
	} catch (error) {
		diagnostics.push(
			`Package export resolution failed: ${formatPiNativeToolHackCause(error)}`,
		);
	}

	const uniqueCandidateRoots = [
		...new Set(candidateRoots.map(normalizeCandidatePath)),
	].filter(Boolean);
	for (const candidateRoot of uniqueCandidateRoots) {
		if (looksLikePiPackageRoot(candidateRoot, runtime.existsSync)) {
			return { packageRoot: candidateRoot, diagnostics };
		}
	}

	if (uniqueCandidateRoots.length > 0) {
		diagnostics.push(
			`No candidate root exposed both required private module files. Using best-effort root: ${uniqueCandidateRoots[0]}`,
		);
		return {
			packageRoot: uniqueCandidateRoots[0],
			diagnostics,
		};
	}

	throw createPiNativeToolHackError(
		[
			"Failed to determine the installed pi package root for the native tool hack.",
			...diagnostics,
			"No candidate pi package roots were discovered.",
			"Ensure pi is installed and that its private interactive module layout matches this extension.",
		].join("\n"),
	);
}

function collectPiPackageRootCandidates(
	runtime: PiNativeToolHackResolverRuntime,
	diagnostics: string[],
): string[] {
	const candidates: string[] = [];
	const argv1 = runtime.argv[1];
	if (argv1) {
		diagnostics.push(`process.argv[1]: ${argv1}`);
		candidates.push(...collectPiPackageRootCandidatesFromPath(argv1, runtime));
		const realArgv1 = safeRealpath(argv1, runtime.realpathSync);
		if (realArgv1 && realArgv1 !== argv1) {
			diagnostics.push(`realpath(process.argv[1]): ${realArgv1}`);
			candidates.push(
				...collectPiPackageRootCandidatesFromPath(realArgv1, runtime),
			);
		}
	}

	if (runtime.execPath) {
		diagnostics.push(`process.execPath: ${runtime.execPath}`);
		candidates.push(buildGlobalPiPackageRootFromPrefix(runtime.execPath));
		const realExecPath = safeRealpath(runtime.execPath, runtime.realpathSync);
		if (realExecPath && realExecPath !== runtime.execPath) {
			diagnostics.push(`realpath(process.execPath): ${realExecPath}`);
			candidates.push(buildGlobalPiPackageRootFromPrefix(realExecPath));
		}
	}

	for (const prefixKey of ["npm_config_prefix", "PREFIX"] as const) {
		const prefix = runtime.env[prefixKey];
		if (!prefix) {
			continue;
		}
		diagnostics.push(`${prefixKey}: ${prefix}`);
		candidates.push(buildGlobalPiPackageRootFromPrefix(prefix));
	}

	for (const commonPrefix of ["/opt/homebrew", "/usr/local"]) {
		candidates.push(buildGlobalPiPackageRootFromPrefix(commonPrefix));
	}

	return candidates;
}

function collectPiPackageRootCandidatesFromPath(
	candidatePath: string,
	runtime: Pick<
		PiNativeToolHackResolverRuntime,
		"existsSync" | "readFileSync" | "realpathSync"
	>,
): string[] {
	const candidates: string[] = [];
	const normalizedPath = normalizeCandidatePath(candidatePath);
	if (!normalizedPath) {
		return candidates;
	}

	const basename = path.basename(normalizedPath).toLowerCase();
	if (basename === "cli.js" || basename === "index.js") {
		candidates.push(path.resolve(normalizedPath, "..", ".."));
	}
	if (
		basename === "pi" ||
		basename === "pi.cmd" ||
		basename === "pi.ps1" ||
		basename === "pi.exe"
	) {
		candidates.push(
			buildGlobalPiPackageRootFromPrefix(path.dirname(normalizedPath)),
		);
	}

	const shimRoot = tryExtractPiPackageRootFromCliShim(normalizedPath, runtime);
	if (shimRoot) {
		candidates.push(shimRoot);
	}

	return candidates;
}

function tryExtractPiPackageRootFromCliShim(
	candidatePath: string,
	runtime: Pick<PiNativeToolHackResolverRuntime, "existsSync" | "readFileSync">,
): string | null {
	if (!runtime.existsSync(candidatePath)) {
		return null;
	}

	try {
		const fileContents = runtime.readFileSync(candidatePath, "utf8");
		const match = fileContents.match(
			/['"]([^'"]*@mariozechner[\\/]pi-coding-agent[\\/]dist[\\/]cli\.js)['"]/i,
		);
		if (!match?.[1]) {
			return null;
		}
		const shimTarget = match[1];
		const resolvedCliPath = path.isAbsolute(shimTarget)
			? shimTarget
			: path.resolve(path.dirname(candidatePath), shimTarget);
		return path.resolve(resolvedCliPath, "..", "..");
	} catch {
		return null;
	}
}

function buildPiNativeToolHackModulePaths(
	packageRoot: string,
): PiNativeToolHackModulePaths {
	return {
		interactiveModePath: path.join(
			packageRoot,
			PI_INTERACTIVE_MODE_RELATIVE_PATH,
		),
		assistantMessagePath: path.join(
			packageRoot,
			PI_ASSISTANT_MESSAGE_RELATIVE_PATH,
		),
	};
}

function looksLikePiPackageRoot(
	candidateRoot: string,
	existsSync: (candidatePath: string) => boolean,
): boolean {
	const modulePaths = buildPiNativeToolHackModulePaths(candidateRoot);
	return (
		existsSync(modulePaths.interactiveModePath) &&
		existsSync(modulePaths.assistantMessagePath)
	);
}

function buildGlobalPiPackageRootFromPrefix(prefixPath: string): string {
	return path.resolve(
		prefixPath,
		"..",
		"lib",
		"node_modules",
		"@mariozechner",
		"pi-coding-agent",
	);
}

function createResolverRuntime(
	options?: Partial<PiNativeToolHackResolverRuntime>,
): PiNativeToolHackResolverRuntime {
	return {
		resolveImport:
			options?.resolveImport ??
			(async (specifier) => await import.meta.resolve(specifier)),
		existsSync:
			options?.existsSync ?? ((candidatePath) => fs.existsSync(candidatePath)),
		readFileSync:
			options?.readFileSync ??
			((candidatePath, encoding) => fs.readFileSync(candidatePath, encoding)),
		realpathSync:
			options?.realpathSync ??
			((candidatePath) => fs.realpathSync(candidatePath)),
		argv: options?.argv ?? process.argv,
		execPath: options?.execPath ?? process.execPath,
		env: options?.env ?? process.env,
	};
}

function normalizeCandidatePath(candidatePath: string | undefined): string {
	return candidatePath ? path.resolve(candidatePath) : "";
}

function safeRealpath(
	candidatePath: string,
	realpathSync: (candidatePath: string) => string,
): string | null {
	try {
		return realpathSync(candidatePath);
	} catch {
		return null;
	}
}

function createPiNativeToolHackError(message: string, cause?: unknown): Error {
	return cause !== undefined
		? new Error(message, { cause })
		: new Error(message);
}

function formatPiNativeToolHackCause(cause: unknown): string {
	if (cause instanceof Error) {
		return cause.message;
	}
	if (cause === undefined || cause === null || cause === "") {
		return "";
	}
	return String(cause);
}

function afterHandleEvent(interactiveMode: any, event: any): void {
	if (
		event?.__cursorNativeHack === true &&
		event.type === "tool_execution_start"
	) {
		splitStreamingAssistantAtTool(
			interactiveMode,
			String(event.toolCallId || ""),
		);
		return;
	}
	if (event?.type === "agent_end") {
		clearSplitState(interactiveMode);
	}
}

function splitStreamingAssistantAtTool(
	interactiveMode: any,
	toolCallId: string,
): void {
	const state = getSplitState(interactiveMode);
	const fullMessage = state?.lastFullMessage;
	const chatContainer = interactiveMode?.chatContainer;
	const streamingComponent = interactiveMode?.streamingComponent;
	const toolComponent = interactiveMode?.pendingTools?.get?.(toolCallId);
	if (!state || !fullMessage || !chatContainer || !streamingComponent) {
		return;
	}

	const segmentMessage = buildTailMessage(fullMessage, state.snapshot);

	try {
		chatContainer.removeChild(streamingComponent);
		if (toolComponent) {
			chatContainer.removeChild(toolComponent);
		}

		if (hasVisibleAssistantContent(segmentMessage)) {
			const segmentComponent = new AssistantMessageComponentClass(
				segmentMessage,
				interactiveMode.hideThinkingBlock,
				typeof interactiveMode.getMarkdownThemeWithSettings === "function"
					? interactiveMode.getMarkdownThemeWithSettings()
					: undefined,
			);
			chatContainer.addChild(segmentComponent);
		}

		if (toolComponent) {
			chatContainer.addChild(toolComponent);
		}

		const emptyTail = buildTailMessage(fullMessage, fullMessage);
		interactiveMode.streamingMessage = emptyTail;
		streamingComponent.updateContent(emptyTail);
		chatContainer.addChild(streamingComponent);
		state.snapshot = cloneAssistantMessage(fullMessage);
		interactiveMode.ui?.requestRender?.();
	} catch {
		// Best-effort private API hack.
	}
}
