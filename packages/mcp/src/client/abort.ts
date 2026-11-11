/** 等 `promise` 的结果，`signal` 中止时立刻以中止原因失败，不管 `promise` 自己看不看信号。 */
export function abortable<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		if (signal.aborted) onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		promise
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", onAbort));
	});
}
