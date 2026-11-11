import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** 登录期间在环回地址上等授权服务器回调的端口。 */
export interface CallbackListener {
	/** 这次登录的回调地址，带着实际监听的端口。 */
	readonly redirectUrl: string;
	/** 第一个到达回调地址的请求带的参数。 */
	readonly callback: Promise<URLSearchParams>;
	/** 关闭端口。 */
	close(): Promise<void>;
}

const callbackPath = "/callback";

// 回应浏览器的时候还没核对 state、没兑换授权码，所以不说"登录成功"
const page = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>MCP 授权</title></head>
<body><p>已收到授权结果，可以关闭这个页面，回到终端查看是否登录成功。</p></body>
</html>
`;

/** 在 `127.0.0.1` 上监听回调；`port` 为 0 时由系统挑一个空闲端口。 */
export async function listenForCallback(
	port: number,
): Promise<CallbackListener> {
	const callback = Promise.withResolvers<URLSearchParams>();
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "", "http://127.0.0.1");
		if (request.method !== "GET" || url.pathname !== callbackPath) {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		// 页面发完再交出参数：登录随后就关闭端口，不能把还没发完的回应切断
		response.end(page, () => callback.resolve(url.searchParams));
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(port, "127.0.0.1", listening.resolve);
	await listening.promise;
	server.off("error", listening.reject);

	const address = server.address() as AddressInfo;
	return {
		redirectUrl: `http://127.0.0.1:${address.port}${callbackPath}`,
		callback: callback.promise,
		close() {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			// 浏览器的 keep-alive 连接不关，close 的回调就等不到
			server.closeAllConnections();
			return closed.promise;
		},
	};
}
