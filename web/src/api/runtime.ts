import type { PlatformSettingsDto } from "./admin.ts";
import { requestJson } from "./client.ts";

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
	id: "worker" | "decision" | "architect" | "distill";
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
	pstack: {
		configured: boolean;
		available: boolean;
		root: string | null;
		installedRoot: string | null;
		version: string | null;
		modeSha256: string | null;
		skillCount: number;
		error: string | null;
		source?: "env" | "settings" | "none";
	};
	webAccess: {
		installedVersion: string | null;
		roles: Array<{ id: string; name: string; enabled: boolean }>;
	};
	isolationModes: RuntimeIsolationModeDto[];
	envFlags: {
		turnTimeoutMs: number;
		promptTimeoutMs: number;
		idleTimeoutMs: number;
		customExtensionsEnvConfigured: boolean;
		pstackDirEnvConfigured: boolean;
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

export interface RuntimeOverviewDto {
	base: RuntimeBaseInfoDto;
	extensions: RuntimeExtensionDto[];
	configSections: RuntimeConfigSectionDto[];
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

export function installRuntimePstack(): Promise<{ installedRoot: string; overview: RuntimeOverviewDto }> {
	return requestJson("/api/admin/runtime/pstack/install", { method: "POST", body: "{}" });
}

export function enableRuntimePstack(path: string): Promise<{
	settings: PlatformSettingsDto;
	overview: RuntimeOverviewDto;
}> {
	return requestJson("/api/admin/runtime/pstack/enable", {
		method: "POST",
		body: JSON.stringify({ path }),
	});
}

export function disableRuntimePstack(): Promise<{
	settings: PlatformSettingsDto;
	overview: RuntimeOverviewDto;
}> {
	return requestJson("/api/admin/runtime/pstack/disable", {
		method: "POST",
		body: JSON.stringify({}),
	});
}

export function installRuntimeWebAccess(): Promise<{ overview: RuntimeOverviewDto }> {
	return requestJson("/api/admin/runtime/web-access/install", { method: "POST", body: "{}" });
}

export function configureRuntimeWebAccess(roleIds: string[]): Promise<{ overview: RuntimeOverviewDto }> {
	return requestJson("/api/admin/runtime/web-access", { method: "PATCH", body: JSON.stringify({ roleIds }) });
}
