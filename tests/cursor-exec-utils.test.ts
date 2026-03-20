import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildGrepArgs,
	buildOutputLocation,
	expandPath,
	formatWorkspacePath,
	mapCursorToolToPiTool,
	parseCountLine,
	resolveToCwd,
	sanitizeShellText,
	summarizeGrepResult,
} from "../src/cursor-exec-utils";

describe("cursor-exec-utils", () => {
	test("maps Cursor tool names to pi tool names", () => {
		expect(mapCursorToolToPiTool("shell")).toBe("bash");
		expect(mapCursorToolToPiTool("shellStream")).toBe("bash");
		expect(mapCursorToolToPiTool("grep")).toBe("grep");
	});

	test("buildGrepArgs assembles ripgrep arguments for supported output modes", () => {
		expect(
			buildGrepArgs(
				{
					pattern: "needle",
					glob: "*.ts",
					type: "ts",
					caseInsensitive: true,
					multiline: true,
					sort: "path",
					sortAscending: false,
					contextBefore: 1,
					contextAfter: 2,
				} as any,
				".",
				"content",
			),
		).toEqual([
			"--hidden",
			"--line-number",
			"--color=never",
			"--ignore-case",
			"--glob",
			"*.ts",
			"--type",
			"ts",
			"--multiline",
			"--multiline-dotall",
			"--sortr",
			"path",
			"--json",
			"-B",
			"1",
			"-A",
			"2",
			"needle",
			".",
		]);
		expect(
			buildGrepArgs({ pattern: "needle" } as any, ".", "files_with_matches"),
		).toContain("--files-with-matches");
		expect(buildGrepArgs({ pattern: "needle" } as any, ".", "count")).toContain(
			"--count",
		);
		expect(
			buildGrepArgs(
				{ pattern: "needle", sort: "path", context: 2 } as any,
				".",
				"content",
			),
		).toEqual([
			"--hidden",
			"--line-number",
			"--color=never",
			"--sort",
			"path",
			"--json",
			"-B",
			"2",
			"-A",
			"2",
			"needle",
			".",
		]);
	});

	test("path helpers resolve workspace, home, and system paths correctly", () => {
		const cwd = "/workspace/project";

		expect(formatWorkspacePath("/workspace/project/src/index.ts", cwd)).toBe(
			"src/index.ts",
		);
		expect(resolveToCwd("src/index.ts", cwd)).toBe(
			"/workspace/project/src/index.ts",
		);
		expect(resolveToCwd("/workspace/project/src/index.ts", cwd)).toBe(
			"/workspace/project/src/index.ts",
		);
		expect(resolveToCwd("/", cwd)).toBe(cwd);
		expect(resolveToCwd("/tmp/output.log", cwd)).toBe("/tmp/output.log");
		expect(resolveToCwd("/outside/project.txt", cwd)).toBe(
			"/workspace/project/outside/project.txt",
		);
		expect(formatWorkspacePath("/workspace/other/index.ts", cwd)).toBe(
			"/workspace/other/index.ts",
		);
		expect(expandPath("~")).toBe(os.homedir());
		expect(expandPath("@~/notes.txt")).toBe(
			path.join(os.homedir(), "notes.txt"),
		);
	});

	test("parseCountLine normalizes both null-delimited and colon-separated formats", () => {
		expect(
			parseCountLine(
				"/workspace/project/src/index.ts\x003",
				"/workspace/project",
			),
		).toEqual({
			file: "src/index.ts",
			count: 3,
		});
		expect(
			parseCountLine("/workspace/project/src/index.ts:4", "/workspace/project"),
		).toEqual({
			file: "src/index.ts",
			count: 4,
		});
		expect(parseCountLine("not-a-count", "/workspace/project")).toBe(null);
		expect(
			parseCountLine(
				"/workspace/project/src/index.ts\x00nope",
				"/workspace/project",
			),
		).toBe(null);
		expect(parseCountLine(":4", "/workspace/project")).toBe(null);
		expect(
			parseCountLine(
				"/workspace/project/src/index.ts:not-a-number",
				"/workspace/project",
			),
		).toBe(null);
	});

	test("summarizeGrepResult summarizes content, file, and count responses", () => {
		expect(
			summarizeGrepResult({
				result: {
					case: "success",
					value: {
						workspaceResults: {
							workspace: {
								result: {
									case: "content",
									value: { matches: [{}, {}], totalMatchedLines: 3 },
								},
							},
						},
					},
				},
			}),
		).toBe("2 file(s), 3 match(es)");
		expect(
			summarizeGrepResult({
				result: {
					case: "success",
					value: {
						workspaceResults: {
							workspace: {
								result: {
									case: "files",
									value: { totalFiles: 5 },
								},
							},
						},
					},
				},
			}),
		).toBe("5 file(s) matched");
		expect(
			summarizeGrepResult({
				result: {
					case: "success",
					value: {
						workspaceResults: {
							workspace: {
								result: {
									case: "count",
									value: { totalMatches: 8 },
								},
							},
						},
					},
				},
			}),
		).toBe("8 total match(es)");
		expect(
			summarizeGrepResult({
				result: {
					case: "error",
				},
			}),
		).toBeUndefined();
		expect(
			summarizeGrepResult({
				result: {
					case: "success",
					value: {},
				},
			}),
		).toBeUndefined();
		expect(
			summarizeGrepResult({
				result: {
					case: "success",
					value: {
						workspaceResults: {
							workspace: {},
						},
					},
				},
			}),
		).toBeUndefined();
		expect(
			summarizeGrepResult({
				result: {
					case: "success",
					value: {
						workspaceResults: {
							workspace: {
								result: {
									case: "other",
									value: {},
								},
							},
						},
					},
				},
			}),
		).toBeUndefined();
	});

	test("sanitizeShellText strips control characters but preserves whitespace", () => {
		expect(sanitizeShellText("hello\u0007\tworld\nnext\uFFF9")).toBe(
			"hello\tworld\nnext",
		);
		expect(sanitizeShellText("ok\rkeep 😀\uFFFB")).toBe("ok\rkeep 😀");
	});

	test("buildOutputLocation reports file metadata for captured shell output", () => {
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "cursor-exec-utils-"),
		);
		const outputPath = path.join(tempDir, "output.log");
		fs.writeFileSync(outputPath, "line one\nline two\n");

		expect(buildOutputLocation(outputPath)).toEqual({
			filePath: outputPath,
			sizeBytes: BigInt(Buffer.byteLength("line one\nline two\n")),
			lineCount: 3n,
		});
		expect(
			buildOutputLocation(path.join(tempDir, "missing.log")),
		).toBeUndefined();
		expect(buildOutputLocation("")).toBeUndefined();
	});
});
