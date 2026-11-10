/** 命令行写得不对：未知的命令或选项、缺少参数、取值不合法。输出到 stderr，退出码 2。 */
export class UsageError extends Error {
	override name = "UsageError";
}
