/** 当前沙盒后端的能力，Host 据此告诉模型和用户，不假定各平台一样。 */
export interface BackendCapabilities {
	platform: "darwin" | "linux";
	/** 能否按路径放行单个 Unix socket（Linux 上不能）。 */
	unix_sockets: boolean;
	/** `local_binding` 是否改变什么：Linux 上每个命令沙盒有自己的 127.0.0.1，申请了也不变。 */
	local_binding: boolean;
	/** 怎样结束一个沙盒实例里的全部进程：macOS 用收尾进程，Linux 靠 PID 命名空间。 */
	process_cleanup: "reaper" | "pid_namespace";
}
