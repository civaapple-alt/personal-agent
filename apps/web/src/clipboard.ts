/** Writes text to the system clipboard with a textarea fallback for non-HTTPS LAN origins. */
export async function writeTextToClipboard(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Fall through to legacy textarea copy for non-secure contexts.
	}
	try {
		const textarea = document.createElement("textarea");
		textarea.value = text;
		textarea.setAttribute("readonly", "");
		textarea.style.position = "fixed";
		textarea.style.opacity = "0";
		textarea.style.pointerEvents = "none";
		document.body.appendChild(textarea);
		textarea.select();
		const ok = document.execCommand("copy");
		document.body.removeChild(textarea);
		return ok;
	} catch {
		return false;
	}
}

/** Copies arbitrary text to clipboard and notifies the caller with a concise confirmation or fallback. */
export async function copyTextToClipboard(text: string, label: string, onNotice: (msg: string) => void) {
	const ok = await writeTextToClipboard(text);
	onNotice(ok ? `已复制${label}` : `${label}：${text}`);
}
