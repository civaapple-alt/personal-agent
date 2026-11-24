import { defineServerExtension } from "@pa/extension-api/server";

export const WEB_ACCESS_TOOLS = ["web_search", "get_search_content", "fetch_content"] as const;

export default defineServerExtension({
	name: "web-access",
	title: "联网检索（pi-web-access）",
	description: "直接复用原生 Pi 社区包 pi-web-access，由 PA 统一治理搜索供应商优先级与 .env 密钥隔离。",
	kind: "third-party-pi",
	piPackage: "pi-web-access",
	tools: WEB_ACCESS_TOOLS,
});
