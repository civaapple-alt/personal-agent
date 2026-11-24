import { isAbsolute } from "node:path";

/** Recognize only explicit signals returned by pi-web-access; unknown formats remain unknown. */
export function temporaryClonePaths(content) {
	if (!Array.isArray(content)) return [];
	const paths = [];
	for (const item of content) {
		if (!item || item.type !== "text" || typeof item.text !== "string") continue;
		for (const match of item.text.matchAll(/^Repository cloned to: ([^\r\n]+)\r?$/gm)) {
			if (isAbsolute(match[1]) && !match[1].includes("\0")) paths.push(match[1]);
		}
	}
	return paths;
}

export function temporaryClonePath(content) {
	return temporaryClonePaths(content)[0] ?? null;
}

export function classifyGithubFetch(input, content, isError) {
	if (isError || !input || typeof input !== "object") return null;
	const urls = typeof input.url === "string" ? [input.url] : Array.isArray(input.urls) ? input.urls : [];
	if (urls.length !== 1 || typeof urls[0] !== "string") return null;
	let url;
	try {
		url = new URL(urls[0]);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) return null;
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length < 2 || !/^[\w.-]+$/.test(parts[0]) || !/^[\w.-]+$/.test(parts[1])) return null;
	const source = `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/, "")}`;
	const texts = Array.isArray(content)
		? content.filter((x) => x && x.type === "text" && typeof x.text === "string").map((x) => x.text)
		: [];
	if (texts.length === 0) return null;
	const text = texts.join("\n");
	const clonePath = temporaryClonePath(content);
	const kind = clonePath
		? "temporary_clone"
		: /This is an API-only view\.|Showing API-fetched content instead of full clone\.|Commit SHA URLs use the GitHub API instead of cloning\./.test(
					text,
				)
			? "github_api"
			: "unknown";
	return {
		kind,
		source,
		truncated:
			/(?:\.\.\. \(truncated at \d+ entries\)|\[(?:README|File) truncated at \d+K chars|\[Output truncated\.\]|Showing \d+ of \d+ chars)/i.test(
				text,
			),
		...(clonePath ? { clonePath } : {}),
	};
}

/** Attribute batch results only when the tool supplies per-URL structured content. */
export function classifyGithubFetches(input, content, isError, structuredContent) {
	if (isError || !input || typeof input !== "object") return [];
	const urls = typeof input.url === "string" ? [input.url] : Array.isArray(input.urls) ? input.urls : [];
	if (urls.length === 1) {
		const result = classifyGithubFetch(input, content, false);
		return result ? [result] : [];
	}
	if (!structuredContent || typeof structuredContent !== "object" || !Array.isArray(structuredContent.urls)) return [];
	const requested = new Set(urls.filter((url) => typeof url === "string"));
	const batchTruncated =
		Array.isArray(content) &&
		content.some(
			(item) => item?.type === "text" && typeof item.text === "string" && /\[Output truncated\.\]/i.test(item.text),
		);
	return structuredContent.urls.flatMap((item) => {
		if (
			!item ||
			typeof item.url !== "string" ||
			!requested.has(item.url) ||
			item.error ||
			typeof item.content !== "string"
		)
			return [];
		const evidence = classifyGithubFetch({ url: item.url }, [{ type: "text", text: item.content }], false);
		return evidence ? [{ ...evidence, truncated: evidence.truncated || batchTruncated }] : [];
	});
}
