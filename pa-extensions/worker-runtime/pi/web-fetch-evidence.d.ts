export interface GithubFetchEvidence {
	kind: "temporary_clone" | "github_api" | "unknown";
	source: string;
	truncated: boolean;
	clonePath?: string;
}
export function temporaryClonePath(content: unknown): string | null;
export function temporaryClonePaths(content: unknown): string[];
export function classifyGithubFetch(input: unknown, content: unknown, isError: boolean): GithubFetchEvidence | null;
export function classifyGithubFetches(
	input: unknown,
	content: unknown,
	isError: boolean,
	structuredContent: unknown,
): GithubFetchEvidence[];
