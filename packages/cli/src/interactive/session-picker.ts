import type { Terminal } from "@earendil-works/pi-tui";
import type { SessionInfo, TuiMode } from "@ospreycode/agent-host";
import type { CliContext, CliSignal } from "../context.js";
import type { Clipboard } from "./clipboard.js";
import { brief } from "./format.js";
import { createScreen } from "./screen.js";
import { Picker } from "./view/picker.js";

/** 选择的结果：选中的 session，用户取消了，或者进程收到了信号。 */
export type PickedSession =
	| { kind: "selected"; sessionId: string }
	| { kind: "cancelled" }
	| { kind: "signalled"; signal: CliSignal };

/**
 * `ospreycode resume` 没有指定 session 时的列表：列出能恢复的 session，最近写过的在前，每项是最后
 * 写入的时间和标题，由用户选一个。它在打开 session 之前自己占一会终端，结束时不留下列表、放开终端：
 * 之后 session 打不开的话，错误照常写到 stderr。
 */
export async function pickSession(
	screen: { terminal: Terminal; mode: TuiMode; clipboard: Clipboard },
	context: CliContext,
	sessions: readonly SessionInfo[],
): Promise<PickedSession> {
	const { terminal } = screen;
	const tui = createScreen(terminal, screen.mode, screen.clipboard);
	const picked = Promise.withResolvers<PickedSession>();
	const picker = new Picker({
		title: "选择要恢复的 session",
		hint: "↑↓ 选择 · Enter 恢复 · Esc 取消",
		items: sessions.map((session) => ({
			value: session.session_id,
			label: session.last_written_at,
			// 标题是用户输入的第一行，要去掉里面的控制序列
			description:
				session.title === null ? "（还没有输入）" : brief(session.title),
		})),
		onSelect: (sessionId) => picked.resolve({ kind: "selected", sessionId }),
		onCancel: () => picked.resolve({ kind: "cancelled" }),
	});
	tui.addChild(picker);
	tui.setFocus(picker);
	const unsubscribe = context.onSignal((signal) =>
		picked.resolve({ kind: "signalled", signal }),
	);
	tui.start();
	try {
		return await picked.promise;
	} finally {
		unsubscribe();
		// 主缓冲区里的列表要自己擦掉；备用缓冲区随界面停下整个撤掉，不把列表写回主缓冲区
		if (tui.mode === "regular") {
			tui.clear();
			tui.renderNow();
		}
		await terminal.drainInput();
		tui.stop({ preserveScreen: tui.mode === "fullscreen" });
	}
}
