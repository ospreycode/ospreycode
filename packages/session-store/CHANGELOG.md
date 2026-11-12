# Changelog

## [Unreleased]

### Breaking Changes

- 存储格式升到第 2 版（`storageVersion` 为 2）：加了分叉的来源、被放弃的位置和检查点索引。打开第 1 版的库时自动迁移（先在同一目录备份，成功后删除），不需要手工处理；本包定义的事件的格式版本接受 1 到 `storageVersion`，写 `run.started` 的代码不用改。
- `Checkpoint` 的字段改了：`position` 是输入事件的位置，回退的目标是新加的 `before`；`changed_paths` 换成各次快照的记录 `snapshots`（改动的路径在每条记录的 `paths` 里），另加 `kind`、`cleaned` 和 `on_path`。`InputRange.to_seq` 为空表示同一个 run 里之后没有别的输入。
- `run.started` 的 `base` 要在这个 session 的会话树里（自己的、属于 task 的事件，或分叉沿用的那段路径），否则 `append` 抛出 `StorageError`。

### Added

- 回退：`position.moved` 事件（`positionMovedType`、`PositionMove`）移动当前位置，`SessionStore.abandoned` 读出被放弃的位置。
- 分叉：`SessionStore.fork` 新建一个引用父 session 的 session，`forks` 列出一个 session 的全部分叉；`pathEvents` 能读到父 session 里分叉位置之前的那一段，`SessionMetadata.fork` 带来源。
- 恢复：`SessionStore.resume` 取得已有 session 的写锁；`SessionStore.session` 读一个 session 的元数据。
- 检查点索引：`checkpoint.created`、`checkpoint.snapshot`、`checkpoints.inherited` 三种事件和它们的内容类型，`SessionStore.checkpoints`、`inputs`、`unreferencedSnapshots`，每个 session 只留最近 `retainedCheckpoints` 个检查点的快照。
- 删除、导出和重建：`SessionStore.delete`（分叉仍引用的事件改记到分叉名下，结果是 `DeletedSession`）、`export`（JSONL 的各行，`ExportHeader`、`ExportedEvent`、`Redactor`）和 `rebuild`。
- 按事件脱敏：`SessionWriter.redact`、`SessionStore.redactionScope`、`event.redacted` 事件（`eventRedactedType`、`EventRedaction`）。脱敏之后 `putBlob` 再保存同样的字节会把内容存回去。`redact` 可以另给一个标题，在同一个事务里换掉这个 session 的标题（标题取自被覆盖的输入时用）；不给时标题不变。
- `SessionStore.sessionsMentioning`：列出自己的事件内容里出现过一段文字的 session，调用方用它在整个项目里找带着某个编号（如记忆的编号）的事件。
- 子 agent 的 run（`run.started` 的内容带 `parent_agent_id` 和 `parent_tool_call_id`）不进入会话树的路径：它的事件写入时不移动 session 的当前位置，它里面的位置不能作为 `base`、回退或分叉的位置。两个父字段要一起出现，`base` 要为空，否则 `append` 抛出 `StorageError`。

- 事件的公共字段 `StoredEvent` 和存储格式版本 `storageVersion`。
- 会话树的格式：位置、run 的接续关系（含子 agent 的父子字段）、当前位置、用户输入的范围、分叉的来源和 session 元数据；`runStartedType` 是在会话树上开始一个 run 的事件，`data` 为 `RunRecord`。
- 检查点的格式 `Checkpoint`。
- `SessionStore`：一个项目一个 SQLite 文件（`node:sqlite`，WAL、busy timeout 5 秒、`synchronous=FULL`、`secure_delete=ON`，文件只对当前用户可读写），格式版本记在 `user_version`，比程序新时抛出 `StorageError`。`create` 新建 session 并取得调用方提供的写锁（`SessionLocker`），返回只追加的 `SessionWriter`（`append`、`putBlob`、`setTitle`、`close`）；读取有 `sessions`、`events`、`runs`、`position`、`pathEvents`（从根到某个位置的路径）和 `blob`（只能读本 session 引用过的大内容）。
