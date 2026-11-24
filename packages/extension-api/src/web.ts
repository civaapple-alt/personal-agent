import type { ReactNode } from "react";

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
	readonly category: "team" | "web" | "skill" | "decision" | "space" | "visual";
	/** Optional override for the success status badge (e.g. "已提交"). */
	readonly successLabel?: string;
	/** Optional formatter to refine the one-line summary from tool arguments or raw summary. */
	readonly formatSummary?: (context: PaToolDisplayContext) => string | undefined;
}

export interface PaToolRenderProps {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: Record<string, unknown>;
	readonly status: "running" | "success" | "error" | "unknown";
	readonly detail?: string;
}

export type PaToolRenderer = (props: PaToolRenderProps) => ReactNode;

export interface PaToolRendererRegistration {
	readonly renderer: PaToolRenderer;
	readonly prominence?: "routine" | "primary";
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
	readonly toolRenderers?: Readonly<Record<string, PaToolRendererRegistration>>;
}

export function defineWebExtension<T extends PaWebExtension>(extension: T): T {
	return extension;
}
