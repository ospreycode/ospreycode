import {
	buildIndex,
	type MemoryRecord,
	queryTerms,
	searchRecords,
} from "@ospreycode/memory";
import { expect, test } from "vitest";

let counter = 0;

function record(fields: Partial<MemoryRecord>): MemoryRecord {
	counter += 1;
	return {
		id: `p-${String(counter).padStart(8, "0")}`,
		scope: "project",
		kind: "fact",
		title: "标题",
		body: "正文",
		status: "active",
		origin: "untrusted",
		sources: { sessions: [], files: [] },
		version: 1,
		created_at: "2026-11-01T00:00:00.000Z",
		confirmed_at: "2026-11-01T00:00:00.000Z",
		...fields,
	};
}

test("查询按空白和标点拆成词，中日韩文字按相邻两字拆", () => {
	expect(queryTerms("npm test, Run-Check!")).toEqual([
		"npm",
		"test",
		"run",
		"check",
	]);
	expect(queryTerms("测试命令")).toEqual(["测试", "试命", "命令"]);
	expect(queryTerms("用 pnpm 装")).toEqual(["用", "pnpm", "装"]);
	expect(queryTerms("a b")).toEqual([]);
});

test("子串匹配不区分大小写，按命中的词数排序，整句命中的排最前", () => {
	const build = record({ title: "构建用 pnpm build", body: "不要用 npm。" });
	const test_ = record({
		title: "Test command",
		body: "Run `PNPM test` from the repository root.",
	});
	const phrase = record({ title: "pnpm test 很慢", body: "要十分钟。" });
	const unrelated = record({ title: "回复用中文", body: "用户说的。" });
	const records = [build, test_, phrase, unrelated];

	expect(searchRecords(records, "pnpm", 5).map((r) => r.id)).toEqual([
		build.id,
		test_.id,
		phrase.id,
	]);
	expect(
		searchRecords(records, "repository root pnpm", 5).map((r) => r.id)[0],
	).toBe(test_.id);
	expect(searchRecords(records, "pnpm test", 2).map((r) => r.id)).toEqual([
		test_.id,
		phrase.id,
	]);
	expect(searchRecords(records, "中文", 5).map((r) => r.id)).toEqual([
		unrelated.id,
	]);
	expect(searchRecords(records, "kubernetes", 5)).toEqual([]);
});

test("同分的按确认时间从新到旧", () => {
	const older = record({
		title: "pnpm 一",
		confirmed_at: "2026-11-01T00:00:00.000Z",
	});
	const newer = record({
		title: "pnpm 二",
		confirmed_at: "2026-11-05T00:00:00.000Z",
	});
	expect(searchRecords([older, newer], "pnpm", 5).map((r) => r.id)).toEqual([
		newer.id,
		older.id,
	]);
});

test("索引只列生效的记忆，每条一行：编号、范围、类型、标题和来源", () => {
	const active = record({
		kind: "decision",
		title: "用 pnpm，不用 npm",
		origin: "user",
		sources: {
			sessions: [],
			files: [
				{ path: "package.json", line: 3, sha256: "a".repeat(64) },
				{ path: "README.md" },
			],
		},
	});
	const index = buildIndex(
		[
			active,
			record({ status: "pending" }),
			record({ status: "retired" }),
			record({ status: "expired" }),
		],
		{ maxTokens: 1000, countTokens: (text) => text.length },
	);
	expect(index).toEqual({
		entries: [
			{
				id: active.id,
				version: 1,
				line: `[${active.id}] project decision: 用 pnpm，不用 npm (stated by the user; refs: package.json:3, README.md)`,
				references: [{ path: "package.json", line: 3, sha256: "a".repeat(64) }],
			},
		],
		omitted: 0,
	});
});

test("索引超出长度上限时留最近用过和确认的，其余只计数", () => {
	const old = record({
		title: "旧的",
		confirmed_at: "2026-10-01T00:00:00.000Z",
	});
	const recent = record({
		title: "新确认的",
		confirmed_at: "2026-11-10T00:00:00.000Z",
	});
	const used = record({
		title: "旧的但刚用过",
		confirmed_at: "2026-09-01T00:00:00.000Z",
		last_used_at: "2026-11-11T00:00:00.000Z",
	});
	const index = buildIndex([old, recent, used], {
		maxTokens: 2,
		countTokens: () => 1,
	});
	expect(index.entries.map((entry) => entry.id)).toEqual([used.id, recent.id]);
	expect(index.omitted).toBe(1);
});

test("来源 session 都被清理后，索引上注明来源已删除", () => {
	const index = buildIndex(
		[
			record({
				sources: {
					sessions: [{ session_id: "s1", event_ids: [], deleted: true }],
					files: [],
				},
			}),
		],
		{ maxTokens: 1000, countTokens: (text) => text.length },
	);
	expect(index.entries[0]?.line).toContain("source session deleted");
});
