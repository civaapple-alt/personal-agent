/** Joins conditional CSS class fragments, filtering out falsy entries. */
export function cn(...parts: Array<string | false | null | undefined>): string {
	return parts.filter(Boolean).join(" ");
}
