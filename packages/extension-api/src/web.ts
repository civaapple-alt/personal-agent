export interface PaToolDisplayContext {
	toolName: string;
	summary?: string;
	args?: Record<string, unknown>;
}

/** Declarative display descriptor for a tool call shown in PA execution records or chat cards. */
export interface PaToolDisplaySpec {
	/** Short human-readable label (e.g. "联网搜索", "提请确认"). */
	readonly label: string;
	/** Category badge used for compact execution rows. */
	readonly category: "team" | "web" | "skill" | "decision" | "space";
	/** Optional override for the success status badge (e.g. "已提交"). */
	readonly successLabel?: string;
	/** Optional formatter to refine the one-line summary from tool arguments or raw summary. */
	readonly formatSummary?: (context: PaToolDisplayContext) => string | undefined;
}

/**
 * Browser-only extension descriptor for PA Web UI.
 * Never imports server code, Node built-ins, or Pi runtime modules.
 */
export interface PaWebExtension {
	readonly name: string;
	readonly title: string;
	readonly description?: string;
	readonly toolDisplays?: Readonly<Record<string, PaToolDisplaySpec>>;
}

export function defineWebExtension<T extends PaWebExtension>(extension: T): T {
	return extension;
}
