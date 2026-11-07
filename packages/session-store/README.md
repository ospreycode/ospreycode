# @ospreycode/session-store

保存 session 记录：事件、会话树、检查点索引和按引用保存的大内容。设计见仓库里的 `docs/packages/session-store.md`。

## 安装

```sh
npm install @ospreycode/session-store
```

## 用法

事件的公共字段、会话树和检查点的格式。各类事件的内容由产生它的包定义，本包不理解内容。

```ts
import {
	type RunRecord,
	type StoredEvent,
	storageVersion,
} from "@ospreycode/session-store";

const run: RunRecord = {
	run_id: crypto.randomUUID(),
	task_id: crypto.randomUUID(),
	agent_id: crypto.randomUUID(),
	base: null,
};
const event: StoredEvent = {
	event_id: crypto.randomUUID(),
	session_id: crypto.randomUUID(),
	run_id: run.run_id,
	seq: 1,
	time: new Date().toISOString(),
	source: "host",
	task_id: run.task_id,
	agent_id: run.agent_id,
	type: "run.started",
	version: storageVersion,
	data: run,
};
console.log(event.type, event.seq);
```

## 平台要求

Node.js `^24.15.0 || >=26.0.0`。

## 许可证

Apache-2.0
