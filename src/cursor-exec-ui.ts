export type CursorExecUiStatus =
	| "running"
	| "success"
	| "error"
	| "rejected"
	| "info";

export interface CursorExecUiMessage {
	tool: string;
	title: string;
	status: CursorExecUiStatus;
	body?: string;
	preview?: string;
	meta?: Record<string, unknown>;
	timestamp: number;
}

let currentCursorExecUiSink: ((message: CursorExecUiMessage) => void) | null =
	null;

export function setCursorExecUiSink(
	sink: ((message: CursorExecUiMessage) => void) | null,
): void {
	currentCursorExecUiSink = sink;
}

export function emitCursorExecUi(
	message: Omit<CursorExecUiMessage, "timestamp">,
): void {
	currentCursorExecUiSink?.({ ...message, timestamp: Date.now() });
}
