import assert from "node:assert/strict";
import test from "node:test";
import { formatNoticeEventLine, isKeyNoticeEvent } from "../apps/web/src/utils/matterStream.ts";
import workerRuntimeExtension from "../pa-extensions/worker-runtime/pi/index.ts";
import { classifyGithubFetch, classifyGithubFetches } from "../pa-extensions/worker-runtime/pi/web-fetch-evidence.js";

const url = "https://github.com/example/repo";
const clone = [
	{
		type: "text",
		text: "Repository cloned to: /tmp/pi-github-repos/runtime-1/abc\n\n## Structure\n... (truncated at 200 entries)",
	},
];

test("GitHub fetch evidence distinguishes temporary clones, API views, unknown and failed fetches", () => {
	assert.deepEqual(classifyGithubFetch({ url }, clone, false), {
		kind: "temporary_clone",
		source: url,
		truncated: true,
		clonePath: "/tmp/pi-github-repos/runtime-1/abc",
	});
	assert.equal(
		classifyGithubFetch(
			{ url },
			[{ type: "text", text: "This is an API-only view. Clone the repo or use `read`/`bash`" }],
			false,
		)?.kind,
		"github_api",
	);
	assert.equal(classifyGithubFetch({ url }, [{ type: "text", text: "ordinary content" }], false)?.kind, "unknown");
	assert.equal(
		classifyGithubFetch(
			{ url },
			[{ type: "text", text: "Repository cloned to: /tmp/clone\nShowing 100 of 1000 chars" }],
			false,
		)?.truncated,
		true,
	);
	assert.equal(classifyGithubFetch({ url }, clone, true), null);
	assert.equal(classifyGithubFetch({ url: "https://example.com" }, clone, false), null);
	assert.equal(classifyGithubFetch({ urls: [url, "https://github.com/example/other"] }, clone, false), null);
	const other = "https://github.com/example/other";
	const batch = classifyGithubFetches({ urls: [url, other] }, [], false, {
		urls: [
			{ url, content: clone[0]!.text, error: null },
			{ url: other, content: "This is an API-only view.", error: null },
			{ url: "https://github.com/outside/not-requested", content: clone[0]!.text, error: null },
		],
	});
	assert.deepEqual(
		batch.map((entry) => [entry.source, entry.kind]),
		[
			[url, "temporary_clone"],
			[other, "github_api"],
		],
	);
	assert.deepEqual(classifyGithubFetches({ urls: [url, other] }, clone, false, null), []);
	const notice = JSON.stringify({
		method: "web_fetch_evidence",
		kind: "temporary_clone",
		source: url,
		truncated: true,
	});
	assert.equal(isKeyNoticeEvent(notice), true);
	assert.match(formatNoticeEventLine(notice), /临时副本.*跨轮次可能失效.*返回内容有截断/);
	assert.match(
		formatNoticeEventLine(JSON.stringify({ method: "web_fetch_evidence", kind: "github_api" })),
		/API 视图/,
	);
	assert.match(
		formatNoticeEventLine(JSON.stringify({ method: "web_fetch_evidence", kind: "unknown" })),
		/获取方式未确认/,
	);
});

test("tool result guidance preserves structured output and recognizes restored stale clone paths", (t) => {
	const old = process.env.PA_WEB_SEARCH_ENABLED;
	process.env.PA_WEB_SEARCH_ENABLED = "true";
	t.after(() => {
		if (old === undefined) delete process.env.PA_WEB_SEARCH_ENABLED;
		else process.env.PA_WEB_SEARCH_ENABLED = old;
	});
	type Event = {
		toolName: string;
		input: Record<string, unknown>;
		content: Array<{ type: string; [key: string]: unknown }>;
		isError: boolean;
		structuredContent?: unknown;
	};
	type Handler = (
		event: Event,
	) => { content: Array<{ type: string; [key: string]: unknown }>; structuredContent?: unknown } | undefined;
	let resultHandler: Handler | undefined;
	let beforeStart: ((event: { systemPrompt: string }, ctx: unknown) => unknown) | undefined;
	workerRuntimeExtension({
		on(event, handler) {
			if (event === "tool_result") resultHandler = handler as Handler;
			if (event === "before_agent_start") beforeStart = handler as typeof beforeStart;
		},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools() {},
	});
	assert.ok(resultHandler);
	const structuredContent = { responseId: "result", urls: [] };
	const enhanced = resultHandler({
		toolName: "fetch_content",
		input: { url },
		content: clone,
		isError: false,
		structuredContent,
	});
	assert.deepEqual(enhanced?.structuredContent, structuredContent);
	assert.match(
		String(enhanced?.content.at(-1)?.text),
		/temporary GitHub clone.*not a registered or durable workspace/,
	);
	const normal = resultHandler({
		toolName: "fetch_content",
		input: { url: "https://example.com" },
		content: clone,
		isError: false,
	});
	assert.equal(normal, undefined);
	assert.ok(beforeStart);
	beforeStart(
		{ systemPrompt: "" },
		{
			sessionManager: {
				buildSessionProjection: () => ({
					messages: [{ role: "toolResult", toolName: "fetch_content", content: clone }],
				}),
			},
		},
	);
	const missing = resultHandler({
		toolName: "read",
		input: { path: "/tmp/pi-github-repos/runtime-1/abc/README.md" },
		content: [{ type: "text", text: "ENOENT: missing" }],
		isError: true,
	});
	assert.match(String(missing?.content.at(-1)?.text), /earlier temporary GitHub clone.*Fetch the source again/);
	assert.equal(
		resultHandler({
			toolName: "read",
			input: { path: "/tmp/another/README.md" },
			content: [{ type: "text", text: "ENOENT" }],
			isError: true,
		}),
		undefined,
	);
});
