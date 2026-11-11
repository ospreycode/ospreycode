import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { MemoryTask } from "../runners/memory-experiment.js";

function completed(outcome: string | undefined): string[] {
	return outcome === "completed"
		? []
		: [`task 的结果是 ${outcome ?? "超时"}，应当是 completed`];
}

function lines(path: string): string[] {
	return existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter((line) => line.trim() !== "")
		: [];
}

const staleMarker = ".stale-check-used";

/**
 * 试跑用的两道题：一道的信息只在之前的会话里（用户说过的约定），一道学到的做法在检验之前过期了。
 * 只用来确认对比实验的流程走得通，不是完整的场景集。
 */
export const memorySmokeTasks: readonly MemoryTask[] = [
	{
		name: "再次使用用户说过的约定",
		setup(workspace) {
			writeFileSync(
				join(workspace, "README.md"),
				"# heron\n\nA small service.\n",
			);
		},
		learn: [
			"For this project, release notes go in docs/releases/NOTES.md, one line per change, and every line starts with the tag [heron-7]. Remember this for future sessions, then reply OK. Do not create or change any file now.",
		],
		probe:
			"Add a release note for this change, following this project's convention for release notes: fixed the login timeout.",
		check(probe, workspace) {
			const notes = lines(join(workspace, "docs", "releases", "NOTES.md"));
			return [
				...completed(probe.outcome),
				...(notes.some(
					(line) =>
						line.trimStart().startsWith("[heron-7]") &&
						/login timeout/i.test(line),
				)
					? []
					: [
							"docs/releases/NOTES.md 里没有以 [heron-7] 开头、写着 login timeout 的一行",
						]),
			];
		},
		evidence: (text) => text.includes("heron-7") && text.includes("NOTES.md"),
	},
	{
		name: "做法过期后重新核实",
		setup(workspace) {
			mkdirSync(join(workspace, "tools"));
			writeFileSync(
				join(workspace, "README.md"),
				"# osprey-tools\n\nRun `sh tools/check.sh` to run the checks.\n",
			);
			writeFileSync(
				join(workspace, "tools", "check.sh"),
				"#!/bin/sh\necho ok > .check-result\necho checks passed\n",
			);
		},
		learn: [
			"Find out how this project's checks are run, run them, and remember how to run them for future sessions.",
		],
		change(workspace) {
			rmSync(join(workspace, ".check-result"), { force: true });
			writeFileSync(
				join(workspace, "README.md"),
				"# osprey-tools\n\nRun `sh tools/verify.sh` to run the checks.\n",
			);
			writeFileSync(
				join(workspace, "tools", "verify.sh"),
				"#!/bin/sh\necho ok > .verify-result\necho checks passed\n",
			);
			// 旧脚本留着，但每次运行都记一笔：数得出照搬旧做法的次数
			writeFileSync(
				join(workspace, "tools", "check.sh"),
				`#!/bin/sh\necho used >> ${staleMarker}\necho "tools/check.sh is no longer used, see README.md" >&2\nexit 1\n`,
			);
		},
		probe: "Run this project's checks and tell me whether they pass.",
		check(probe, workspace) {
			return [
				...completed(probe.outcome),
				...(lines(join(workspace, ".verify-result")).includes("ok")
					? []
					: ["没有运行 tools/verify.sh"]),
			];
		},
		evidence: (text) => text.includes("check.sh") || text.includes("verify.sh"),
		staleUses: (_probe, workspace) =>
			lines(join(workspace, staleMarker)).length,
	},
];
