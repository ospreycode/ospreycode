import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostEvent } from "@ospreycode/agent-host";
import type { ModelEntry } from "@ospreycode/api";

/** 收集一个 session 的事件，可以等某一类事件出现。 */
export class EventLog {
	readonly events: HostEvent[] = [];
	#waiters: { match: (event: HostEvent) => boolean; resolve: () => void }[] =
		[];

	readonly push = (event: HostEvent): void => {
		this.events.push(event);
		for (const waiter of this.#waiters.filter((w) => w.match(event))) {
			waiter.resolve();
		}
		this.#waiters = this.#waiters.filter((w) => !w.match(event));
	};

	/** 已经出现过或之后出现的第一个满足条件的事件。 */
	async waitFor<Type extends HostEvent["type"]>(
		type: Type,
		match: (event: Extract<HostEvent, { type: Type }>) => boolean = () => true,
	): Promise<Extract<HostEvent, { type: Type }>> {
		const find = () =>
			this.events.find(
				(event): event is Extract<HostEvent, { type: Type }> =>
					event.type === type &&
					match(event as Extract<HostEvent, { type: Type }>),
			);
		const found = find();
		if (found !== undefined) return found;
		await new Promise<void>((resolve) => {
			this.#waiters.push({
				match: (event) =>
					event.type === type &&
					match(event as Extract<HostEvent, { type: Type }>),
				resolve,
			});
		});
		return find() as Extract<HostEvent, { type: Type }>;
	}

	types(): string[] {
		return this.events.map((event) => event.type);
	}
}

/** 一次测试用的目录：Host 根目录、工作区、临时的 HOME 和一个 0600 的凭据文件，互不包含。 */
export interface TestDirectories {
	root: string;
	workspace: string;
	home: string;
	credentialFile: string;
	/** 测试用的环境变量：只有 PATH 和临时的 HOME。 */
	env: Record<string, string | undefined>;
	cleanup(): void;
}

export function testDirectories(): TestDirectories {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "osp-host-")));
	const home = join(base, "home");
	const workspace = join(base, "workspace");
	const secrets = join(base, "secrets");
	for (const dir of [home, workspace, secrets]) mkdirSync(dir);
	const credentialFile = join(secrets, "test");
	writeFileSync(credentialFile, "test-key\n", { mode: 0o600 });
	return {
		root: join(home, ".ospreycode"),
		workspace,
		home,
		credentialFile,
		env: { PATH: process.env.PATH, HOME: home },
		cleanup: () => rmSync(base, { recursive: true, force: true }),
	};
}

/** 脚本模型用的模型清单条目，地址不会被访问。 */
export const scriptedEntry: ModelEntry = {
	id: "scripted",
	protocol: "anthropic.messages",
	service: "test",
	base_url: "https://scripted.invalid/v1",
	model: "scripted",
	context_window: 200_000,
	max_output_tokens: 8_000,
};
