# @ospreycode/session-store

保存 session 记录：事件、会话树、检查点索引和按引用保存的大内容。设计见仓库里的 `docs/packages/session-store.md`。

## 安装

```sh
npm install @ospreycode/session-store
```

## 用法

每个项目一个 SQLite 文件，位置由调用方给出。`SessionStore.open(path)` 打开或创建它；`create` 新建一个 session 并取得写锁，返回只追加的 `SessionWriter`。写锁的实现由调用方提供（Host 用 pid 文件），同一个 session 同时只有一个写入者。各类事件的内容由产生它的包定义，本包只读 `run.started`：它的 `data` 是 `RunRecord`，按它维护会话树。

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type RunRecord,
	runStartedType,
	SessionStore,
	storageVersion,
} from "@ospreycode/session-store";

const dir = mkdtempSync(join(tmpdir(), "session-store-example-"));
const store = SessionStore.open(join(dir, "sessions.sqlite"));
const writer = await store.create(
	{
		session_id: "s1",
		workspace: "/path/to/workspace",
		created_at: new Date().toISOString(),
	},
	// 示例只在一个进程里，用一个什么也不做的锁
	async () => ({ release: () => {} }),
);
const run: RunRecord = { run_id: "r1", task_id: "t1", agent_id: "a1", base: null };
writer.append({
	event_id: crypto.randomUUID(),
	session_id: "s1",
	run_id: "r1",
	seq: 1,
	time: new Date().toISOString(),
	source: "host",
	task_id: "t1",
	agent_id: "a1",
	type: runStartedType,
	version: storageVersion,
	data: run,
});
writer.setTitle("第一个任务");
writer.close();
console.log(store.events("s1").length, store.position("s1"), store.sessions()[0]?.title);
store.close();
rmSync(dir, { recursive: true, force: true });
```

`pathEvents(sessionId, position)` 读出从会话树的根到某个位置的事件，恢复、重启和回退后发给模型的历史按它重建；`putBlob` 按 SHA-256 只存一份大内容，`blob` 只能读本 session 引用过的。

## 平台要求

Node.js `^24.15.0 || >=26.0.0`（`node:sqlite`）。

## 许可证

Apache-2.0
