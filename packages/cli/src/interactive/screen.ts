import {
	type Component,
	isViewportTUI,
	ScrollView,
	type Terminal,
	TuiAltScreen,
	TuiMainScreen,
	type TuiMouseEvent,
	VStack,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { TuiMode } from "@ospreycode/agent-host";
import type { Clipboard } from "./clipboard.js";
import { style } from "./view/theme.js";

/**
 * 全屏的渲染器。界面库只把落在浮层里的鼠标动作交给浮层，外面的照常交给下面的界面；这里多一件事：
 * 设了 `clickOutside` 时，浮层外面的鼠标动作不再交给下面的界面，点一下就调用它。
 */
class FullScreen extends TuiAltScreen {
	clickOutside: (() => void) | undefined;

	protected override dispatchMouseToOverlay(
		event: TuiMouseEvent,
	): ReturnType<TuiAltScreen["dispatchMouseToOverlay"]> {
		const dispatched = super.dispatchMouseToOverlay(event);
		if (dispatched.hit || this.clickOutside === undefined) return dispatched;
		if (event.type === "click") this.clickOutside();
		// 算作落在浮层上、没有组件接：按下和松开不会碰到下面的列表和输入框，滚轮照常滚动对话区
		return { hit: true };
	}
}

/**
 * 对话区滚上去之后的那一行提示。界面库把它盖在对话区最后一行的文字上：只有中间一段的话，两边露出来
 * 的文字和它连成一行，读不出来。所以占满 `columns` 列，把那一行整个换掉。
 */
function scrollToEndRow(columns: number): string {
	const label = " ↓ 回到最新的内容 · Ctrl+End ";
	const rule = Math.max(0, columns - visibleWidth(label));
	const left = Math.floor(rule / 2);
	return `${style.dim("─".repeat(left))}${style.selected(label)}${style.dim("─".repeat(rule - left))}`;
}

/** 交互界面的渲染器：`regular` 写在终端的主缓冲区里，`fullscreen` 占着备用缓冲区。 */
export type Screen = TuiMainScreen | FullScreen;

/**
 * 按渲染方式建渲染器。全屏时界面库接管鼠标：滚轮滚动对话区，拖动框选的文字交给系统剪贴板；这个
 * 环境写不了剪贴板时由界面库改用终端的 OSC 52。
 */
export function createScreen(
	terminal: Terminal,
	mode: TuiMode,
	clipboard: Clipboard,
): Screen {
	if (mode === "regular") return new TuiMainScreen(terminal);
	const { writeText } = clipboard;
	return new FullScreen(terminal, undefined, undefined, {
		wheelScrollLines: "auto",
		scrollToEndIndicator: () => scrollToEndRow(terminal.columns),
		...(writeText === undefined
			? {}
			: {
					copySelection: async (text: string) => {
						try {
							await writeText(text);
							return true;
						} catch (error) {
							// 剪贴板是外部的：写不进去时把原因显示在界面上，session 照常继续
							return (error as Error).message;
						}
					},
				}),
	});
}

/** 交互界面从上到下的几个部分。 */
export interface ScreenParts {
	/** 对话区：高度不封顶。 */
	conversation: Component;
	/** 排队的输入。 */
	queue: Component;
	/** 一行按键提示。 */
	hint: Component;
	/** 输入框的位置：输入框、询问的面板或者列表。 */
	bottom: Component;
	/** 状态行。 */
	status: Component;
}

/**
 * 把界面的各个部分放到渲染器上。主缓冲区里从上到下排开，滚动交给终端。全屏时屏幕只有终端那么高：
 * 对话区占满剩下的高度、自己滚动，其余几项固定在屏幕底部，不会被变长的对话顶出去。
 */
export function mountScreen(screen: Screen, parts: ScreenParts): void {
	// 全屏时也照从上到下的顺序挂着：停下时按这个顺序把完整的对话写回主缓冲区（见 stopScreen）
	for (const component of [
		parts.conversation,
		parts.queue,
		parts.hint,
		parts.bottom,
		parts.status,
	]) {
		screen.addChild(component);
	}
	if (!isViewportTUI(screen)) return;
	const transcript = new ScrollView(parts.conversation, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: "auto",
	});
	const dock = new VStack([
		{ component: parts.queue, shrink: 1, minSize: 0 },
		{ component: parts.hint, shrink: 0 },
		// 询问的面板比屏幕还高时留下末尾：选项和按键提示在那里，被裁掉的开头用滚轮看
		{
			component: new ScrollView(parts.bottom, { follow: "end" }),
			shrink: 1,
			minSize: 3,
		},
		{ component: parts.status, shrink: 0 },
	]);
	screen.setLayoutRoot(
		new VStack([
			{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]),
	);
}

/**
 * 浮层（图片的预览）开着时，鼠标点在它外面要做的事；`action` 为空时撤掉。主缓冲区里界面库不接管
 * 鼠标，没有这回事。
 */
export function onClickOutsideOverlay(
	screen: Screen,
	action: (() => void) | undefined,
): void {
	if (screen instanceof FullScreen) screen.clickOutside = action;
}

/**
 * 停下界面、放开终端。全屏时回到主缓冲区，由界面库把最后一份完整的内容写在原来的终端内容后面：
 * 先撤掉布局，布局里对话区的高度从 0 算起，照它写回去只有一行。
 */
export function stopScreen(screen: Screen): void {
	if (isViewportTUI(screen)) screen.setLayoutRoot(undefined);
	screen.stop();
}
