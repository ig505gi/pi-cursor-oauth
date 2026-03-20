import type { CursorExecUiMessage } from "./cursor-exec-ui";

export const CURSOR_EXEC_MESSAGE_TYPE = "cursor-exec";

export function shouldPersistCursorExecMessage(
	event: CursorExecUiMessage,
): boolean {
	return event.status !== "running";
}

export function buildCursorExecMessage(event: CursorExecUiMessage) {
	return {
		customType: CURSOR_EXEC_MESSAGE_TYPE,
		content: formatCursorExecHeading(event),
		display: true,
		details: event,
	};
}

export function isCursorExecMessage(message: unknown): boolean {
	if (!message || typeof message !== "object") {
		return false;
	}
	const candidate = message as { role?: unknown; customType?: unknown };
	return (
		candidate.role === "custom" &&
		candidate.customType === CURSOR_EXEC_MESSAGE_TYPE
	);
}

export function renderCursorExecMessage(
	message: {
		details?: CursorExecUiMessage;
		content:
			| string
			| Array<{
					type?: string;
					text?: string;
			  }>;
	},
	options: { expanded?: boolean },
	theme: any,
) {
	const event = message.details;
	const expanded = Boolean(options.expanded);
	const previewLineLimit = expanded ? 10 : 4;
	const status = event?.status ?? "info";
	const bgColor =
		status === "success"
			? "toolSuccessBg"
			: status === "error"
				? "toolErrorBg"
				: status === "rejected"
					? "customMessageBg"
					: "toolPendingBg";
	const header = event
		? formatCursorExecHeading(event)
		: typeof message.content === "string"
			? message.content
			: message.content
					.filter(
						(item) => item?.type === "text" && typeof item.text === "string",
					)
					.map((item) => item.text || "")
					.join("\n");
	const body = event?.body?.trim();
	const preview = event?.preview?.trim();
	const timestamp = event?.timestamp
		? new Date(event.timestamp).toLocaleTimeString()
		: undefined;

	return {
		invalidate() {},
		render(width: number): string[] {
			const innerWidth = Math.max(8, width - 2);
			const lines: string[] = [];
			lines.push(
				...wrapPlainText(header, innerWidth).map((line, index) =>
					renderCardLine(
						line,
						innerWidth,
						theme,
						bgColor,
						index === 0 ? "toolTitle" : "toolOutput",
						index === 0,
					),
				),
			);

			if (body) {
				lines.push(
					...wrapPlainText(body, innerWidth).map((line) =>
						renderCardLine(line, innerWidth, theme, bgColor, "muted"),
					),
				);
			}

			if (preview) {
				const previewLines = wrapPlainText(preview, innerWidth).slice(
					0,
					previewLineLimit,
				);
				for (const line of previewLines) {
					lines.push(
						renderCardLine(line, innerWidth, theme, bgColor, "toolOutput"),
					);
				}
				const totalPreviewLines = wrapPlainText(preview, innerWidth).length;
				if (totalPreviewLines > previewLineLimit) {
					lines.push(renderCardLine("…", innerWidth, theme, bgColor, "muted"));
				}
			}

			if (expanded && timestamp) {
				lines.push(
					renderCardLine(
						`Completed at ${timestamp}`,
						innerWidth,
						theme,
						bgColor,
						"dim",
					),
				);
			}

			return lines;
		},
	};
}

function formatCursorExecHeading(event: CursorExecUiMessage): string {
	return `${getStatusIcon(event.status)} ${formatToolName(event.tool)} ${event.title}`;
}

function formatToolName(tool: string): string {
	if (tool === "ls") {
		return "Ls";
	}
	const spaced = tool.replace(/([a-z])([A-Z])/g, "$1 $2");
	return spaced.replace(/\b\w/g, (char) => char.toUpperCase());
}

function getStatusIcon(status: CursorExecUiMessage["status"]): string {
	switch (status) {
		case "running":
			return "▶";
		case "success":
			return "✓";
		case "error":
			return "✗";
		case "rejected":
			return "!";
		default:
			return "•";
	}
}

function renderCardLine(
	line: string,
	innerWidth: number,
	theme: any,
	bgColor: string,
	fgColor: string,
	bold = false,
): string {
	const padded = padRight(line, innerWidth);
	const styled = bold ? theme.bold(padded) : padded;
	return theme.bg(bgColor, ` ${theme.fg(fgColor, styled)} `);
}

function wrapPlainText(text: string, width: number): string[] {
	if (width <= 0) {
		return [""];
	}
	const lines: string[] = [];
	for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
		if (rawLine.length === 0) {
			lines.push("");
			continue;
		}
		let remaining = rawLine;
		while (remaining.length > width) {
			lines.push(remaining.slice(0, width));
			remaining = remaining.slice(width);
		}
		lines.push(remaining);
	}
	return lines;
}

function padRight(text: string, width: number): string {
	if (text.length >= width) {
		return text.slice(0, width);
	}
	return text + " ".repeat(width - text.length);
}
