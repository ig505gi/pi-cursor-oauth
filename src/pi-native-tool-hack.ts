import { pathToFileURL } from "node:url";
import {
	buildTailMessage,
	clearSplitState,
	cloneAssistantMessage,
	getSplitState,
	hasVisibleAssistantContent,
	patchCursorAssistantEvent,
} from "./pi-native-tool-hack-helpers";

const PI_INTERACTIVE_MODE_PATH =
	"/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
const PI_ASSISTANT_MESSAGE_COMPONENT_PATH =
	"/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/components/assistant-message.js";

let currentInteractiveMode: any = null;
let installPromise: Promise<void> | null = null;
let AssistantMessageComponentClass: any = null;

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
		const [interactiveModeModule, assistantMessageModule] = await Promise.all([
			import(pathToFileURL(PI_INTERACTIVE_MODE_PATH).href),
			import(pathToFileURL(PI_ASSISTANT_MESSAGE_COMPONENT_PATH).href),
		]);
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
	})();

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
