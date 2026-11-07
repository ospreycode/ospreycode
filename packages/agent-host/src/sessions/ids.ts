import { randomUUID } from "node:crypto";

/**
 * 生成 user、project、session、task、run、agent、tool call、后台命令和事件的标识：
 * 小写的 UUID v4 字符串。用 v4 而不用按时间排序的 v7：`tmp/` 和 `output/` 下的目录名
 * 只取 session 标识的前 12 个字符，要求这一段是随机的。
 */
export function newId(): string {
	return randomUUID();
}
