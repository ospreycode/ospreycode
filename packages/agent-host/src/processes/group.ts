/** 结束整个进程组。Host 用单独的进程组启动全部子进程，进程组的编号就是组长的 pid。 */
export function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		// ESRCH：进程组里已经没有进程。EPERM：macOS 上进程组里只剩还没回收的僵尸进程时也报它；
		// 以其他用户身份运行的 setuid 程序同样收不到信号，它们仍受沙盒限制
		const { code } = error as NodeJS.ErrnoException;
		if (code !== "ESRCH" && code !== "EPERM") throw error;
	}
}
