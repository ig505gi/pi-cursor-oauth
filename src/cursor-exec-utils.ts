import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CursorGrepArgsLike {
	pattern: string;
	glob?: string;
	type?: string;
	caseInsensitive?: boolean;
	multiline?: boolean;
	sort?: string;
	sortAscending?: boolean;
	contextBefore?: number;
	contextAfter?: number;
	context?: number;
}

export function mapCursorToolToPiTool(tool: string): string {
	switch (tool) {
		case "shell":
		case "shellStream":
			return "bash";
		default:
			return tool;
	}
}

export function buildGrepArgs(
	args: CursorGrepArgsLike,
	searchPath: string,
	outputMode: string,
): string[] {
	const rgArgs = ["--hidden", "--line-number", "--color=never"];
	if (args.caseInsensitive) {
		rgArgs.push("--ignore-case");
	}
	if (args.glob) {
		rgArgs.push("--glob", args.glob);
	}
	if (args.type) {
		rgArgs.push("--type", args.type);
	}
	if (args.multiline) {
		rgArgs.push("--multiline", "--multiline-dotall");
	}
	if (args.sort) {
		rgArgs.push(args.sortAscending === false ? "--sortr" : "--sort", args.sort);
	}
	const contextBefore = args.contextBefore ?? args.context ?? 0;
	const contextAfter = args.contextAfter ?? args.context ?? 0;
	if (outputMode === "content") {
		rgArgs.push("--json");
		if (contextBefore > 0) {
			rgArgs.push("-B", String(contextBefore));
		}
		if (contextAfter > 0) {
			rgArgs.push("-A", String(contextAfter));
		}
	} else if (outputMode === "files_with_matches") {
		rgArgs.push("--files-with-matches", "-0");
	} else if (outputMode === "count") {
		rgArgs.push("--count", "-0");
	}
	rgArgs.push(args.pattern, searchPath);
	return rgArgs;
}

export function formatWorkspacePath(filePath: string, cwd: string): string {
	const relative = path.relative(cwd, filePath);
	if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
		return relative.replace(/\\/g, "/");
	}
	return filePath.replace(/\\/g, "/");
}

export function parseCountLine(
	line: string,
	cwd: string,
): { file: string; count: number } | null {
	const parts = line.split("\0");
	if (parts.length >= 2) {
		const file = parts[0]?.trim();
		const countText = parts[1]?.trim();
		const count = Number.parseInt(countText || "", 10);
		if (file && Number.isFinite(count)) {
			return { file: formatWorkspacePath(file, cwd), count };
		}
	}
	const separator = line.lastIndexOf(":");
	if (separator === -1) {
		return null;
	}
	const file = line.slice(0, separator).trim();
	const count = Number.parseInt(line.slice(separator + 1).trim(), 10);
	if (!file || !Number.isFinite(count)) {
		return null;
	}
	return { file: formatWorkspacePath(file, cwd), count };
}

export function resolveToCwd(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	if (expanded === "/") {
		return cwd;
	}
	if (path.isAbsolute(expanded)) {
		if (expanded === cwd || expanded.startsWith(`${cwd}${path.sep}`)) {
			return expanded;
		}
		if (isLikelySystemAbsolutePath(expanded)) {
			return expanded;
		}
		return path.join(cwd, expanded.slice(1));
	}
	return path.resolve(cwd, expanded);
}

export function expandPath(filePath: string): string {
	const normalized = filePath.startsWith("@") ? filePath.slice(1) : filePath;
	if (normalized === "~") {
		return os.homedir();
	}
	if (normalized.startsWith("~/")) {
		return path.join(os.homedir(), normalized.slice(2));
	}
	return normalized;
}

export function buildOutputLocation(fullOutputPath: unknown) {
	if (typeof fullOutputPath !== "string" || fullOutputPath.length === 0) {
		return undefined;
	}
	try {
		const stat = fs.statSync(fullOutputPath);
		const content = fs.readFileSync(fullOutputPath, "utf8");
		return {
			filePath: fullOutputPath,
			sizeBytes: BigInt(stat.size),
			lineCount: BigInt(countLines(content)),
		};
	} catch {
		return undefined;
	}
}

export function summarizeGrepResult(result: {
	result: { case?: string; value?: any };
}): string | undefined {
	if (result.result.case !== "success") {
		return undefined;
	}
	const workspaceResults = result.result.value?.workspaceResults;
	if (!workspaceResults || typeof workspaceResults !== "object") {
		return undefined;
	}
	for (const workspace of Object.values(workspaceResults)) {
		const unionResult = (
			workspace as { result?: { case?: string; value?: any } }
		)?.result;
		if (!unionResult) {
			continue;
		}
		if (unionResult.case === "content") {
			const matches = unionResult.value?.matches ?? [];
			const matchedLines = unionResult.value?.totalMatchedLines ?? 0;
			return `${matches.length} file(s), ${matchedLines} match(es)`;
		}
		if (unionResult.case === "files") {
			return `${unionResult.value?.totalFiles ?? 0} file(s) matched`;
		}
		if (unionResult.case === "count") {
			return `${unionResult.value?.totalMatches ?? 0} total match(es)`;
		}
	}
	return undefined;
}

export function sanitizeShellText(text: string): string {
	return Array.from(text)
		.filter((char) => {
			const code = char.codePointAt(0)!;
			if (code === 0x09 || code === 0x0a || code === 0x0d) {
				return true;
			}
			if (code <= 0x1f) {
				return false;
			}
			if (code >= 0xfff9 && code <= 0xfffb) {
				return false;
			}
			return true;
		})
		.join("");
}

function isLikelySystemAbsolutePath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	return [
		"/tmp/",
		"/var/",
		"/etc/",
		"/usr/",
		"/bin/",
		"/sbin/",
		"/opt/",
		"/private/",
		"/dev/",
		"/Users/",
		"/home/",
	].some((prefix) => normalized.startsWith(prefix));
}

function countLines(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	return text.split("\n").length;
}
