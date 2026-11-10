import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import type { Status } from "../state.js";
import { clipped, style } from "./theme.js";

/** 把家目录下的路径写成 `~` 开头，状态行上短一些。 */
export function shortPath(path: string, home: string | undefined): string {
	if (home === undefined || home === "") return path;
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** 放不下的路径留末尾：区分各个工作区的是最后几级目录。 */
function tail(path: string, width: number): string {
	if (visibleWidth(path) <= width) return path;
	let kept = "";
	for (const character of [...path].reverse()) {
		if (visibleWidth(`…${character}${kept}`) > width) break;
		kept = `${character}${kept}`;
	}
	return `…${kept}`;
}

/** 输入框上面的一行提示：现在按键会做什么。内容由界面按当前的状态给出。 */
export class HintLine implements Component {
	readonly #hint: () => { text: string; emphasis: boolean };

	constructor(hint: () => { text: string; emphasis: boolean }) {
		this.#hint = hint;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { text, emphasis } = this.#hint();
		if (text === "") return [];
		return [clipped(text, width, emphasis ? style.warning : style.dim)];
	}
}

/** 最底下的状态行：模型、推理强度、沙盒模式、审批策略和工作区。 */
export class StatusLine implements Component {
	readonly #status: Status;
	readonly #home: string | undefined;

	constructor(status: Status, home: string | undefined) {
		this.#status = status;
		this.#home = home;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const status = this.#status;
		const settings = [
			status.model,
			`推理 ${status.reasoningEffort}`,
			`沙盒 ${status.sandboxMode}`,
			`审批 ${status.approvalPolicy}`,
			"",
		].join(" · ");
		const workspace = tail(
			shortPath(status.workspace, this.#home),
			width - visibleWidth(settings),
		);
		return [clipped(`${settings}${workspace}`, width, style.dim)];
	}
}
