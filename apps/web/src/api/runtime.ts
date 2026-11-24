import type { SessionInsightsReport } from "@pa/contracts/session-insights";
import { requestJson } from "./client.ts";

export type { SessionInsightsReport };

export type RuntimeExtensionSourceKind =
	| "builtin"
	| "builtin_conditional"
	| "pi_builtin"
	| "operator_env"
	| "pi_package";

export type RuntimeExtensionStatus = "active" | "conditional" | "inactive" | "error";

export type RuntimeExtensionFileStatus = "present" | "missing" | "builtin" | "unknown";

export interface RuntimeExtensionDto {
	id: string;
	name: string;
	sourceKind: RuntimeExtensionSourceKind;
	status: RuntimeExtensionStatus;
	entryPath: string | null;
	fileStatus: RuntimeExtensionFileStatus;
	scopeSummary: string;
	description: string;
	registeredTools: string[];
	hooks: string[];
	declaredByRoles: string[];
	mcpServers: string[];
	error?: string | null;
}

export interface RuntimeIsolationModeDto {
	id: "worker" | "decision" | "architect-aux";
	label: string;
	usage: string;
	sessionStrategy: string;
	extensionsPolicy: string;
	toolsPolicy: string;
}

export interface RuntimeBaseInfoDto {
	name: string;
	executable: string;
	transport: string;
	available: boolean;
	version: string | null;
	probeError: string | null;
	nodeVersion: string;
	platform: string;
	pathsRedacted: boolean;
	sessionMode: "persisted" | "no_session";
	sessionDir: string | null;
	defaultCwd: string | null;
	webAccess: {
		installedVersion: string | null;
		roles: Array<{ id: string; name: string; enabled: boolean }>;
		provider?: "auto" | "deepseek" | "exa" | "kimi";
		effectiveProvider?: "deepseek" | "exa" | "kimi" | null;
	};
	systemOne?: {
		enabled: boolean;
	};
	isolationModes: RuntimeIsolationModeDto[];
	envFlags: {
		turnTimeoutMs: number;
		promptTimeoutMs: number;
		idleTimeoutMs: number;
		customExtensionsEnvConfigured: boolean;
	};
}

export interface RuntimeConfigItemDto {
	key: string;
	label: string;
	value: string;
	defaultValue?: string;
	overridden?: boolean;
}

export interface RuntimeConfigSectionDto {
	id: "env" | "paths" | "rpc" | "orchestrator";
	title: string;
	items: RuntimeConfigItemDto[];
}

export interface ManagedEnvStatusDto {
	key: "TYPESAFE_API_KEY" | "EXA_API_KEY" | "DEEPSEEK_API_KEY" | "MOONSHOT_API_KEY";
	label: string;
	description: string;
	scope: "classifier" | "web_access";
	configured: boolean;
	source: "process_env" | "dotenv" | "unset";
}

export interface RuntimeOverviewDto {
	base: RuntimeBaseInfoDto;
	extensions: RuntimeExtensionDto[];
	configSections: RuntimeConfigSectionDto[];
	envCredentials?: ManagedEnvStatusDto[];
	summary: {
		activeCount: number;
		conditionalCount: number;
		operatorCount: number;
		inactiveCount: number;
		errorCount: number;
	};
	checkedAt: string;
}

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

export interface WebAccessTestResultDto {
	ok: boolean;
	provider: string | null;
	latencyMs: number;
	resultCount?: number;
	sampleTitles?: string[];
	error?: string;
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

export interface SystemOneTestResultDto {
	ok: boolean;
	enabled: boolean;
	latencyMs: number;
	answer?: string;
	error?: string;
}

export function testRuntimeSystemOne(): Promise<SystemOneTestResultDto> {
	return requestJson("/api/admin/runtime/system-one/test", {
		method: "POST",
		body: "{}",
	});
}
