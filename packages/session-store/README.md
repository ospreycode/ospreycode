# @ospreycode/session-store

保存 session 记录：事件、会话树、检查点索引和按引用保存的大内容。设计见仓库里的 `docs/packages/session-store.md`。

## 安装

```sh
npm install @ospreycode/session-store
```

## 用法

每个项目一个 SQLite 文件，位置由调用方给出。`SessionStore.open(path)` 打开或创建它（格式版本较旧时先备份再迁移）；`create` 新建一个 session 并取得写锁，返回只追加的 `SessionWriter`，`resume` 取得已有 session 的写锁接着写，`fork` 从某个位置分叉出新的 session。写锁的实现由调用方提供（Host 用 pid 文件），同一个 session 同时只有一个写入者。各类事件的内容由产生它的包定义，本包只读自己定义的几种事件，按它们维护会话树和检查点索引：`run.started`（`data` 是 `RunRecord`）、`position.moved`、`checkpoint.created`、`checkpoint.snapshot`、`checkpoints.inherited` 和 `event.redacted`。

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

- **回退**：追加一个 `position.moved` 事件把当前位置移到某次输入之前（`checkpoints` 里每个检查点的 `before`），被放弃的位置用 `abandoned` 读出，可以再移回去。
- **分叉**：`fork` 只记下父 session 和截止的位置，不复制事件；分叉按路径读得到父 session 里分叉位置之前的那一段。
- **检查点**：每次用户输入之后追加 `checkpoint.created`，每次快照追加 `checkpoint.snapshot`；`checkpoints` 按建立的先后列出它们，只留最近 100 个检查点的快照，`unreferencedSnapshots` 从影子仓库现有的引用里挑出不再被引用的。
- **删除、导出和重建**：`delete` 彻底删除一个 session，分叉仍引用的事件先改记到分叉名下；`export` 给出 JSONL 的各行（大内容以 base64 内嵌，密钥由调用方传入的函数换成占位）；`rebuild` 从事件表重建会话树和检查点索引。
- **按事件脱敏**：`SessionWriter.redact` 用占位内容覆盖事件和它引用的大内容，并追加一条 `event.redacted`；可以另给一个标题，在同一个事务里换掉 session 的标题。`SessionStore.redactionScope` 只读地给出会覆盖哪些大内容、哪些别的 session 也引用它们。`SessionStore.sessionsMentioning` 列出自己的事件内容里出现过一段文字的 session，用来在整个项目里找带着某个编号的事件。

## 平台要求

Node.js `^24.15.0 || >=26.0.0`（`node:sqlite`）。

## 许可证

Apache-2.0
