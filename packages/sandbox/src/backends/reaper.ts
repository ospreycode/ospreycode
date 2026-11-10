/** 收尾进程在沙盒实例里的接法。 */
export interface ReaperOptions {
	/** 沙盒实例继承的管道一端的文件描述符，另一端在 Host 手里。 */
	fd: number;
	/** 收尾进程要关掉的其他继承来的文件描述符（如通道），否则命令退出后它还占着。 */
	close: readonly number[];
	/** Host 的 pid：收尾进程动手前用它确认自己确实在沙盒里。 */
	hostPid: number;
}

function quote(word: string): string {
	return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * macOS 上给沙盒里要执行的命令加上收尾进程：它先于命令启动，读继承来的管道，Host 关闭管道
 * （命令结束、session 结束或 Host 崩溃）时在实例内执行 `kill -KILL -1`。Seatbelt 只允许给同一个
 * 沙盒实例里的进程发信号，所以它能结束以后台、`nohup` 和两次 fork 启动的进程，碰不到实例外的。
 *
 * 返回的脚本只能放进沙盒里执行：离开 Seatbelt 的 `kill -KILL -1` 会结束用户的全部进程。
 * 为此收尾进程动手前先试着给 Host 发信号 0，发得出去说明不在沙盒里，就不执行。
 */
export function withReaper(
	command: string,
	bash: string,
	options: ReaperOptions,
): string {
	const { fd } = options;
	const closing = options.close.map((other) => `exec ${other}<&-; `).join("");
	return [
		// 忽略能捕获的信号：命令里的 kill 0 不该带走收尾进程；输出指向 /dev/null，不占着命令的输出管道
		`{ trap '' TERM INT HUP; ${closing}exec >/dev/null 2>&1; read -r -u ${fd} _; kill -0 ${options.hostPid} 2>/dev/null || kill -KILL -1; } &`,
		// 命令本身不继承这个管道：它拿不到，也就不能在结束收尾进程之后假装管道还开着
		`exec ${fd}<&-`,
		`exec ${quote(bash)} -c ${quote(command)}`,
	].join("\n");
}
