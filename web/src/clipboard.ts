/** Copies arbitrary text to clipboard and notifies the caller with a concise confirmation or fallback. */
export async function copyTextToClipboard(text: string, label: string, onNotice: (msg: string) => void) {
	try {
		await navigator.clipboard.writeText(text);
		onNotice(`已复制${label}`);
	} catch {
		onNotice(`${label}：${text}`);
	}
}
