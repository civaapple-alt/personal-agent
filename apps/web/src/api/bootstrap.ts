import type { BootstrapPayload } from "@pa/contracts/runtime";
import { requestJson } from "./client.ts";

export type { BootstrapPayload };

export function fetchBootstrap(): Promise<BootstrapPayload> {
	return requestJson<BootstrapPayload>("/api/bootstrap");
}
