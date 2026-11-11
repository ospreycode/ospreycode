import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	expireSessionSources,
	forgetSessionSources,
	type MemoryPaths,
	memoryPaths,
	openMemoryStore,
} from "../src/memory/session-sources.js";

let data: string;
let paths: MemoryPaths;

beforeEach(() => {
	data = mkdtempSync(join(tmpdir(), "osp-memory-sources-"));
	paths = memoryPaths(data, "project-1");
	mkdirSync(join(data, "projects", "project-1"), { recursive: true });
	mkdirSync(join(data, "user"));
});

afterEach(() => {
	rmSync(data, { recursive: true, force: true });
});

const content = { kind: "fact", title: "标题", body: "正文" } as const;

function sources(sessionId: string, eventIds: string[]) {
	return {
		sessions: [{ session_id: sessionId, event_ids: eventIds, deleted: false }],
		files: [],
	};
}

/** 两个范围里各有一条来自 session s1 的记忆，project 里另有一条来自 s2 的。 */
function seed() {
	const project = openMemoryStore(paths.project, "project");
	const user = openMemoryStore(paths.user, "user");
	const ids = {
		project: project.add({ ...content, sources: sources("s1", ["e1", "e2"]) })
			.id,
		other: project.add({
			...content,
			title: "别的 session 的",
			sources: sources("s2", ["e9"]),
		}).id,
		user: user.add({ ...content, sources: sources("s1", ["e3"]) }).id,
	};
	project.close();
	user.close();
	return ids;
}

function read() {
	const project = openMemoryStore(paths.project, "project");
	const user = openMemoryStore(paths.user, "user");
	const records = [...project.list(), ...user.list()];
	project.close();
	user.close();
	return records;
}

test("用户删除 session：两个范围里只来自它的记忆一起删除，别的 session 的不动", () => {
	const ids = seed();
	expect(forgetSessionSources(paths, "s1", []).sort()).toEqual(
		[ids.project, ids.user].sort(),
	);
	expect(read().map((record) => record.id)).toEqual([ids.other]);
});

test("事件改记到分叉名下的记忆保留，来源跟着改记", () => {
	const ids = seed();
	expect(
		forgetSessionSources(paths, "s1", [
			{ toSessionId: "fork", eventIds: ["e1", "e2"] },
		]),
	).toEqual([ids.user]);
	const kept = read().find((record) => record.id === ids.project);
	expect(kept?.sources.sessions).toEqual([
		{ session_id: "fork", event_ids: ["e1", "e2"], deleted: false },
	]);
});

test("session 到期被清理：记忆保留，来源标为已删除", () => {
	const ids = seed();
	expireSessionSources(paths, "s1");
	const records = read();
	expect(records.map((record) => record.id).sort()).toEqual(
		Object.values(ids).sort(),
	);
	expect(
		records.find((record) => record.id === ids.user)?.sources.sessions,
	).toEqual([{ session_id: "s1", event_ids: [], deleted: true }]);
	expect(
		records.find((record) => record.id === ids.other)?.sources.sessions,
	).toEqual([{ session_id: "s2", event_ids: ["e9"], deleted: false }]);
});

test("从没用过长期记忆时什么也不做，不创建记忆库", () => {
	expect(forgetSessionSources(paths, "s1", [])).toEqual([]);
	expireSessionSources(paths, "s1");
	expect(readdirSync(join(data, "user"))).toEqual([]);
	expect(readdirSync(join(data, "projects", "project-1"))).toEqual([]);
});
