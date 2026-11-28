/** Reads a string setting from localStorage, returning `fallback` on storage unavailability. */
export function readStoredSetting(key: string, fallback = ""): string {
	try {
		if (typeof localStorage === "undefined") return fallback;
		return localStorage.getItem(key) ?? fallback;
	} catch {
		return fallback;
	}
}

/** Writes a string setting to localStorage, ignoring sandbox/private-mode storage errors. */
export function writeStoredSetting(key: string, value: string): void {
	try {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(key, value);
	} catch {
		// Ignore private-mode / sandbox storage write errors.
	}
}
