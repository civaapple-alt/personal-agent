import type { PlatformSettingsDto } from "./admin.ts";
import { requestJson } from "./client.ts";

export type RuntimeExtensionSourceKind = "builtin" | "builtin_conditional" | "pi_builtin" | "operator_env";

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
		version: string | null;
		modeSha256: string | null;
		skillCount: number;
		error: string | null;
		source?: "env" | "settings" | "none";
		defaultCloneUrl?: string;
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

export function enableRuntimePstack(input?: { cloneUrl?: string; update?: boolean }): Promise<{
	source: "cloned" | "updated" | "existing";
	repoPath: string;
	settings: PlatformSettingsDto;
	overview: RuntimeOverviewDto;
}> {
	return requestJson("/api/admin/runtime/pstack/enable", {
		method: "POST",
		body: JSON.stringify(input ?? {}),
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
