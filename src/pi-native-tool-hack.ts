import { pathToFileURL } from "node:url";

const PI_INTERACTIVE_MODE_PATH =
	"/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
const PI_ASSISTANT_MESSAGE_COMPONENT_PATH =
	"/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/components/assistant-message.js";

let currentInteractiveMode: any = null;
let installPromise: Promise<void> | null = null;
let AssistantMessageComponentClass: any = null;

interface CursorNativeSplitState {
	snapshot: any | null;
	lastFullMessage: any | null;
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

function patchCursorAssistantEvent(interactiveMode: any, event: any): any {
	if (event?.type === "agent_end") {
		clearSplitState(interactiveMode);
		return event;
	}
	if (!isCursorAssistantEvent(event)) {
		return event;
	}

	if (event.type === "message_start") {
		setSplitState(interactiveMode, {
			snapshot: null,
			lastFullMessage: cloneAssistantMessage(event.message),
		});
		return event;
	}

	const state = getOrCreateSplitState(interactiveMode);
	state.lastFullMessage = cloneAssistantMessage(event.message);
	const tailMessage = buildTailMessage(event.message, state.snapshot);
	return {
		...event,
		message: tailMessage,
		assistantMessageEvent:
			event.type === "message_update"
				? { ...event.assistantMessageEvent, partial: tailMessage }
				: event.assistantMessageEvent,
	};
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

function isCursorAssistantEvent(event: any): boolean {
	return (
		(event?.type === "message_start" ||
			event?.type === "message_update" ||
			event?.type === "message_end") &&
		event?.message?.role === "assistant" &&
		event?.message?.provider === "cursor"
	);
}

function hasVisibleAssistantContent(message: any): boolean {
	const content = Array.isArray(message?.content) ? message.content : [];
	return content.some(
		(block: any) =>
			(block?.type === "text" &&
				typeof block.text === "string" &&
				block.text.trim()) ||
			(block?.type === "thinking" &&
				typeof block.thinking === "string" &&
				block.thinking.trim()),
	);
}

function buildTailMessage(fullMessage: any, snapshot: any | null): any {
	const full = cloneAssistantMessage(fullMessage);
	if (!snapshot) {
		return full;
	}
	const fullContent = Array.isArray(fullMessage?.content)
		? fullMessage.content
		: [];
	const snapshotContent = Array.isArray(snapshot?.content)
		? snapshot.content
		: [];
	const tailContent: any[] = [];
	let prefixStillMatching = true;

	for (let i = 0; i < fullContent.length; i++) {
		const fullBlock = fullContent[i];
		const snapshotBlock = snapshotContent[i];
		if (!snapshotBlock || !prefixStillMatching) {
			tailContent.push(cloneContentBlock(fullBlock));
			continue;
		}

		const remainder = subtractSnapshotBlock(fullBlock, snapshotBlock);
		if (remainder === null) {
			prefixStillMatching = false;
			tailContent.push(cloneContentBlock(fullBlock));
			continue;
		}
		if (remainder) {
			tailContent.push(remainder);
		}
	}

	full.content = tailContent;
	return full;
}

function subtractSnapshotBlock(fullBlock: any, snapshotBlock: any): any | null {
	if (!fullBlock || !snapshotBlock || fullBlock.type !== snapshotBlock.type) {
		return null;
	}
	if (fullBlock.type === "text") {
		const fullText = typeof fullBlock.text === "string" ? fullBlock.text : "";
		const snapshotText =
			typeof snapshotBlock.text === "string" ? snapshotBlock.text : "";
		if (!fullText.startsWith(snapshotText)) {
			return null;
		}
		const text = fullText.slice(snapshotText.length);
		return text ? { ...cloneContentBlock(fullBlock), text } : undefined;
	}
	if (fullBlock.type === "thinking") {
		const fullThinking =
			typeof fullBlock.thinking === "string" ? fullBlock.thinking : "";
		const snapshotThinking =
			typeof snapshotBlock.thinking === "string" ? snapshotBlock.thinking : "";
		if (!fullThinking.startsWith(snapshotThinking)) {
			return null;
		}
		const thinking = fullThinking.slice(snapshotThinking.length);
		return thinking ? { ...cloneContentBlock(fullBlock), thinking } : undefined;
	}
	return null;
}

function cloneAssistantMessage(message: any): any {
	return typeof structuredClone === "function"
		? structuredClone(message)
		: JSON.parse(JSON.stringify(message));
}

function cloneContentBlock(block: any): any {
	return typeof structuredClone === "function"
		? structuredClone(block)
		: JSON.parse(JSON.stringify(block));
}

function getSplitState(interactiveMode: any): CursorNativeSplitState | null {
	return interactiveMode?.__cursorNativeSplitState ?? null;
}

function getOrCreateSplitState(interactiveMode: any): CursorNativeSplitState {
	if (!interactiveMode.__cursorNativeSplitState) {
		interactiveMode.__cursorNativeSplitState = {
			snapshot: null,
			lastFullMessage: null,
		} satisfies CursorNativeSplitState;
	}
	return interactiveMode.__cursorNativeSplitState;
}

function setSplitState(
	interactiveMode: any,
	state: CursorNativeSplitState,
): void {
	interactiveMode.__cursorNativeSplitState = state;
}

function clearSplitState(interactiveMode: any): void {
	if (interactiveMode) {
		interactiveMode.__cursorNativeSplitState = undefined;
	}
}
