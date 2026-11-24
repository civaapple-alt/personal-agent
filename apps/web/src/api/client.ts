let authRevokedHandler: ((message?: string) => void) | null = null;

export function setAuthRevokedHandler(handler: ((message?: string) => void) | null): void {
	authRevokedHandler = handler;
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, {
		...init,
		headers: {
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	const data = (await res.json()) as T & { error?: string };
	if (!res.ok) {
		if (
			res.status === 401 &&
			url !== "/api/auth/login" &&
			url !== "/api/auth/register" &&
			url !== "/api/auth/setup-admin" &&
			url !== "/api/auth/session"
		) {
			authRevokedHandler?.(data.error ?? "当前登录态已失效或无访问权限，请重新登录");
		}
		throw new Error(data.error ?? `Request failed (${res.status})`);
	}
	return data;
}
