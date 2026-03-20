import { ToolExecutionComponent } from "@mariozechner/pi-coding-agent";
import type { CursorExecUiMessage } from "./cursor-exec-ui";

const EXEC_CWD_KEY = "cwd";

export function createCursorExecWidget(events: CursorExecUiMessage[]) {
	const snapshot = [...events].reverse();
	return (tui: any, theme: any) => {
		const components = snapshot.map((event) =>
			createToolExecutionComponent(event, tui),
		);
		return {
			invalidate() {
				for (const component of components) {
					component.invalidate();
				}
			},
			render(width: number): string[] {
				const lines = [theme.fg("accent", theme.bold("Cursor exec"))];
				for (const component of components) {
					lines.push(...component.render(width));
				}
				return lines;
			},
		};
	};
}

function createToolExecutionComponent(
	event: CursorExecUiMessage,
	tui: any,
): ToolExecutionComponent {
	const toolName = mapCursorToolToPiTool(event.tool);
	const args = getToolArgs(event);
	const cwd =
		typeof event.meta?.[EXEC_CWD_KEY] === "string"
			? String(event.meta?.[EXEC_CWD_KEY])
			: process.cwd();
	const component = new ToolExecutionComponent(
		toolName,
		args,
		{ showImages: false },
		undefined,
		tui,
		cwd,
	);
	component.setArgsComplete();
	if (event.status !== "running") {
		component.updateResult(buildResult(event), false);
	}
	return component;
}

function mapCursorToolToPiTool(tool: string): string {
	switch (tool) {
		case "shell":
		case "shellStream":
			return "bash";
		case "read":
		case "ls":
		case "write":
		case "grep":
			return tool;
		default:
			return tool;
	}
}

function getToolArgs(event: CursorExecUiMessage): Record<string, unknown> {
	const meta = event.meta ?? {};
	switch (event.tool) {
		case "shell":
		case "shellStream":
			return {
				command:
					pickString(meta.command, event.title) ?? event.title ?? "command",
				timeout: pickNumber(meta.timeout),
			};
		case "read":
			return {
				path: pickString(meta.path, event.title) ?? event.title,
			};
		case "ls":
			return {
				path: pickString(meta.path, event.title) ?? event.title,
			};
		case "write":
			return {
				path: pickString(meta.path, event.title) ?? event.title,
				content: pickString(meta.content),
			};
		case "grep":
			return {
				pattern: pickString(meta.pattern, event.title) ?? event.title,
				path: pickString(meta.path, event.body),
				glob: pickString(meta.glob),
			};
		case "delete":
			return {
				path: pickString(meta.path, event.title) ?? event.title,
			};
		default:
			return {
				path: pickString(meta.path, event.title),
				command: pickString(meta.command, event.title),
			};
	}
}

function buildResult(event: CursorExecUiMessage) {
	const text = [event.body, event.preview].filter(Boolean).join("\n\n").trim();
	return {
		content: text ? [{ type: "text", text }] : [],
		details: buildResultDetails(event),
		isError: event.status === "error" || event.status === "rejected",
	};
}

function buildResultDetails(
	event: CursorExecUiMessage,
): Record<string, unknown> | undefined {
	if (event.tool !== "shell" && event.tool !== "shellStream") {
		return undefined;
	}
	const meta = event.meta ?? {};
	const details: Record<string, unknown> = {};
	const fullOutputPath = pickString(meta.fullOutputPath, meta.outputFilePath);
	if (fullOutputPath) {
		details.fullOutputPath = fullOutputPath;
	}
	return Object.keys(details).length > 0 ? details : undefined;
}

function pickString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (trimmed) {
				return trimmed;
			}
		}
	}
	return undefined;
}

function pickNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}
