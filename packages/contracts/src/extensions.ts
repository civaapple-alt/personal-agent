export const PA_CONTRACT_VERSION = 1;

export type PaExtensionKind = "builtin-pi" | "third-party-pi" | "host-bridge";

/** Wire summary of a registered PA extension exposed to clients and diagnostics. */
export interface PaExtensionSummary {
	name: string;
	title: string;
	description: string;
	kind: PaExtensionKind;
	tools: readonly string[];
	piPackage?: string;
}
