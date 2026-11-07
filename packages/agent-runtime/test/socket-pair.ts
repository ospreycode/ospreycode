import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 一对相连的 UNIX socket，和 Host 交给 agent 进程的 fd 3 一样。 */
export async function socketPair(): Promise<[Socket, Socket]> {
	const dir = mkdtempSync(join(tmpdir(), "osp-pair-"));
	const server = createServer();
	try {
		server.listen(join(dir, "s"));
		await once(server, "listening");
		const accepted = once(server, "connection");
		const client = connect(join(dir, "s"));
		const [other] = (await accepted) as [Socket];
		await once(client, "connect");
		return [client, other];
	} finally {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
}
