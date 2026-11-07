import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { isInside } from "./paths.js";

/** Linux `statfs` 的 `f_type`：网络文件系统，SQLite 的 WAL 在上面不可靠。 */
const networkFilesystems = new Map([
	[0x6969, "NFS"],
	[0x517b, "SMB"],
	[0xff534d42, "CIFS"],
	[0xfe534d42, "SMB2"],
	[0x5346414f, "AFS"],
	[0x73757245, "Coda"],
	[0x564c, "NCP"],
	[0x01021997, "9P"],
	[0x00c36400, "Ceph"],
]);

/**
 * `mount` 的输出里包含 `path` 的那个挂载点的选项。macOS 的 `statfs` 里文件系统的编号由内核动态分配，
 * 判断不了是不是网络文件系统；`mount` 给本地卷标 `local`。
 */
function macMountOptions(path: string): string[] {
	const output = execFileSync("/sbin/mount", { encoding: "utf8" });
	let best: { point: string; options: string[] } | undefined;
	for (const line of output.split("\n")) {
		const match = / on (.+) \(([^()]*)\)$/.exec(line);
		if (match === null) continue;
		const [, point = "", options = ""] = match;
		if (!isInside(path, point)) continue;
		if (best === undefined || point.length > best.point.length) {
			best = { point, options: options.split(", ") };
		}
	}
	if (best === undefined)
		throw new Error(`mount 的输出里找不到 ${path} 的挂载点`);
	return best.options;
}

/** `path` 在网络文件系统上时返回文件系统的名字，否则返回空。 */
export function networkFilesystem(path: string): string | undefined {
	if (process.platform === "darwin") {
		const options = macMountOptions(path);
		return options.includes("local") ? undefined : options[0];
	}
	return networkFilesystems.get(statfsSync(path).type >>> 0);
}
