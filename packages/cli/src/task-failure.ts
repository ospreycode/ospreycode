/**
 * Host 的一条 `error` 里还没有显示过的部分。agent 进程在任务中途异常退出时，Host 先让任务以失败
 * 结束（`task.ended` 的 `error` 是原因），再发一条 `error`：同一个原因，后面接着 agent 进程输出的
 * 末尾。任务结束时原因已经显示过，这里只留它后面的内容；没有别的内容时是空的，不用再显示。
 *
 * `failure` 是刚显示过的任务失败原因，没有时原样返回。
 */
export function beyondTaskFailure(
	message: string,
	failure: string | undefined,
): string {
	return failure !== undefined && message.startsWith(failure)
		? message.slice(failure.length).trim()
		: message;
}
