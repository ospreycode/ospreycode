# Changelog

## [Unreleased]

### Added

- 事件的公共字段 `StoredEvent` 和存储格式版本 `storageVersion`。
- 会话树的格式：位置、run 的接续关系（含子 agent 的父子字段）、当前位置、用户输入的范围、分叉的来源和 session 元数据；`runStartedType` 是在会话树上开始一个 run 的事件，`data` 为 `RunRecord`。
- 检查点的格式 `Checkpoint`。
- `SessionStore`：一个项目一个 SQLite 文件（`node:sqlite`，WAL、busy timeout 5 秒、`synchronous=FULL`、`secure_delete=ON`，文件只对当前用户可读写），格式版本记在 `user_version`，比程序新时抛出 `StorageError`。`create` 新建 session 并取得调用方提供的写锁（`SessionLocker`），返回只追加的 `SessionWriter`（`append`、`putBlob`、`setTitle`、`close`）；读取有 `sessions`、`events`、`runs`、`position`、`pathEvents`（从根到某个位置的路径）和 `blob`（只能读本 session 引用过的大内容）。
