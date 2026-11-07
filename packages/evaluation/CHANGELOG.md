# Changelog

## [Unreleased]

### Added

- `runScenario`：经 Host 的 SDK 运行一个评测场景，每个场景从干净的临时目录和 HOME 开始，按脚本回答询问和取消，返回结构化的结果（task 的结果、事件、用量、耗时和不满足的检查）。被测的模型、推理强度和凭据由 `EvaluationEnvironment` 给出。
- `p0Scenarios`：P0 的验收场景，完成任务、等待批准（含一次越界申请）、被用户拒绝、被审批策略拒绝、运行中取消。
- `summarize`、`formatSummary`：汇总一组场景的通过数、费用和耗时。
