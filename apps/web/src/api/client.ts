let authRevokedHandler: ((message?: string) => void) | null = null;
let configuredApiBaseUrl: string | null = null;

function normalizeBaseUrl(raw: string | null | undefined): string {
	const trimmed = raw?.trim() ?? "";
	return trimmed.replace(/\/+$/u, "");
}

/**
 * Return the active Personal Agent host base URL.
 * Empty string means same-origin (default web deployment); desktop shells or remote static frontends
 * can supply `window.__PA_API_BASE__` or call `setApiBaseUrl(...)` before rendering.
 */
export function getApiBaseUrl(): string {
	if (configuredApiBaseUrl !== null) return configuredApiBaseUrl;
	const globalBase = (globalThis as { __PA_API_BASE__?: unknown }).__PA_API_BASE__;
	return typeof globalBase === "string" ? normalizeBaseUrl(globalBase) : "";
}

export function setApiBaseUrl(baseUrl: string | null): void {
	configuredApiBaseUrl = baseUrl === null ? null : normalizeBaseUrl(baseUrl);
}

/** Resolve an API/SSE/upload path against the active host base URL while preserving absolute URLs. */
export function resolveApiUrl(path: string): string {
	if (/^https?:\/\//i.test(path)) return path;
	const base = getApiBaseUrl();
	if (!base) return path;
	return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

export function setAuthRevokedHandler(handler: ((message?: string) => void) | null): void {
	authRevokedHandler = handler;
}

const AUTH_EXEMPT_PATHS = new Set([
	"/api/auth/login",
	"/api/auth/register",
	"/api/auth/setup-admin",
	"/api/auth/session",
]);

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(resolveApiUrl(url), {
		...init,
		headers: {
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	const data = (await res.json()) as T & { error?: string };
	if (!res.ok) {
		if (res.status === 401 && !AUTH_EXEMPT_PATHS.has(url)) {
			authRevokedHandler?.(data.error ?? "当前登录态已失效或无访问权限，请重新登录");
		}
		throw new Error(data.error ?? `Request failed (${res.status})`);
	}
	return data;
}
