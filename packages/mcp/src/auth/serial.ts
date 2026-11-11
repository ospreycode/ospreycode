/** 让交来的操作一个接一个地做，前一个做完才开始下一个。 */
export class SerialQueue {
	#last: Promise<unknown> = Promise.resolve();

	/** 排到队尾去做 `task`，返回它的结果。 */
	run<T>(task: () => Promise<T>): Promise<T> {
		const result = this.#last.then(task);
		// 失败由 result 报给交来这个操作的调用方，排在后面的操作照常进行
		this.#last = result.catch(() => undefined);
		return result;
	}
}
