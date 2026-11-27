import type {
	ManagedEnvStatusDto,
	RuntimeBaseInfoDto,
	RuntimeConfigItemDto,
	RuntimeConfigSectionDto,
	RuntimeExtensionDto,
	RuntimeExtensionFileStatus,
	RuntimeExtensionSourceKind,
	RuntimeExtensionStatus,
	RuntimeIsolationModeDto,
	RuntimeOverviewDto,
	SystemOneTestResultDto,
	WebAccessTestResultDto,
} from "@pa/contracts/runtime";
import type { SessionInsightsReport } from "@pa/contracts/session-insights";
import { requestJson } from "./client.ts";

export type {
	ManagedEnvStatusDto,
	RuntimeBaseInfoDto,
	RuntimeConfigItemDto,
	RuntimeConfigSectionDto,
	RuntimeExtensionDto,
	RuntimeExtensionFileStatus,
	RuntimeExtensionSourceKind,
	RuntimeExtensionStatus,
	RuntimeIsolationModeDto,
	RuntimeOverviewDto,
	SessionInsightsReport,
	SystemOneTestResultDto,
	WebAccessTestResultDto,
};

export function fetchRuntimeOverview(): Promise<RuntimeOverviewDto> {
	return requestJson("/api/runtime");
}

export function fetchRuntimeInsights(options?: {
	matterId?: string;
	memberId?: string;
	limit?: number;
}): Promise<SessionInsightsReport> {
	const params = new URLSearchParams();
	if (options?.matterId) params.set("matterId", options.matterId);
	if (options?.memberId) params.set("memberId", options.memberId);
	if (options?.limit) params.set("limit", String(options.limit));
	const query = params.toString();
	return requestJson(query ? `/api/runtime/insights?${query}` : "/api/runtime/insights");
}

export function installRuntimeWebAccess(): Promise<{ overview: RuntimeOverviewDto }> {
	return requestJson("/api/admin/runtime/web-access/install", { method: "POST", body: "{}" });
}

export function configureRuntimeWebAccess(
	provider: "auto" | "deepseek" | "exa" | "kimi",
): Promise<{ overview: RuntimeOverviewDto }> {
	return requestJson("/api/admin/runtime/web-access", {
		method: "PATCH",
		body: JSON.stringify({ provider }),
	});
}

export function updateRuntimeEnvCredentials(
	values: Partial<Record<ManagedEnvStatusDto["key"], string | null>>,
): Promise<{ overview: RuntimeOverviewDto }> {
	return requestJson("/api/admin/runtime/env", { method: "PATCH", body: JSON.stringify({ values }) });
}

export function testRuntimeWebAccess(input?: {
	provider?: "auto" | "deepseek" | "exa" | "kimi";
	query?: string;
}): Promise<WebAccessTestResultDto> {
	return requestJson("/api/admin/runtime/web-access/test", {
		method: "POST",
		body: JSON.stringify(input ?? {}),
	});
}

export function testRuntimeSystemOne(): Promise<SystemOneTestResultDto> {
	return requestJson("/api/admin/runtime/system-one/test", {
		method: "POST",
		body: "{}",
	});
}
