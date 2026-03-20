export interface CursorNativeSplitState {
	snapshot: any | null;
	lastFullMessage: any | null;
}

export function patchCursorAssistantEvent(
	interactiveMode: any,
	event: any,
): any {
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

export function isCursorAssistantEvent(event: any): boolean {
	return (
		(event?.type === "message_start" ||
			event?.type === "message_update" ||
			event?.type === "message_end") &&
		event?.message?.role === "assistant" &&
		event?.message?.provider === "cursor"
	);
}

export function hasVisibleAssistantContent(message: any): boolean {
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

export function buildTailMessage(fullMessage: any, snapshot: any | null): any {
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

	for (let index = 0; index < fullContent.length; index += 1) {
		const fullBlock = fullContent[index];
		const snapshotBlock = snapshotContent[index];
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

export function subtractSnapshotBlock(
	fullBlock: any,
	snapshotBlock: any,
): any | null {
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

export function cloneAssistantMessage(message: any): any {
	return typeof structuredClone === "function"
		? structuredClone(message)
		: JSON.parse(JSON.stringify(message));
}

export function cloneContentBlock(block: any): any {
	return typeof structuredClone === "function"
		? structuredClone(block)
		: JSON.parse(JSON.stringify(block));
}

export function getSplitState(
	interactiveMode: any,
): CursorNativeSplitState | null {
	return interactiveMode?.__cursorNativeSplitState ?? null;
}

export function getOrCreateSplitState(
	interactiveMode: any,
): CursorNativeSplitState {
	if (!interactiveMode.__cursorNativeSplitState) {
		interactiveMode.__cursorNativeSplitState = {
			snapshot: null,
			lastFullMessage: null,
		} satisfies CursorNativeSplitState;
	}
	return interactiveMode.__cursorNativeSplitState;
}

export function setSplitState(
	interactiveMode: any,
	state: CursorNativeSplitState,
): void {
	interactiveMode.__cursorNativeSplitState = state;
}

export function clearSplitState(interactiveMode: any): void {
	if (interactiveMode) {
		interactiveMode.__cursorNativeSplitState = undefined;
	}
}
