import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { processStartTime } from "../src/processes/info.js";

/**
 * 启动一个马上会退出的进程，不停地查它的启动时间，直到查不到它为止。后台的 sleep 在 sh 退出之后由
 * init 收尸：测试进程同步地查它的时候它随时会消失。
 */
function watchUntilGone(): void {
	const pid = Number(
		execFileSync("/bin/sh", ["-c", "sleep 0.02 >/dev/null 2>&1 & echo $!"], {
			encoding: "utf8",
		}),
	);
	// 没有收尸的进程时（有的容器里）它一直是僵尸：只等一会
	const deadline = Date.now() + 100;
	while (processStartTime(pid) !== undefined && Date.now() < deadline);
}

// 只有 Linux 从 /proc 读启动时间；macOS 上问的是 ps，没有这个竞争
test.runIf(process.platform === "linux")(
	"进程在查它的启动时间时退出：按进程不存在处理，不抛出",
	() => {
		// 打开 /proc/<pid>/stat 之后进程才消失的话，读到的是 ESRCH 而不是 ENOENT：多试几次才碰得上
		expect(() => {
			for (let round = 0; round < 100; round++) watchUntilGone();
		}).not.toThrow();
	},
);
