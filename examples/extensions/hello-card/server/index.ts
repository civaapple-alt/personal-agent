import { defineServerExtension } from "@pa/extension-sdk/server";

export default defineServerExtension({
	name: "hello-card",
	title: "Hello Card Example",
	description: "Minimal external PA extension demonstrating server-side tool registration metadata.",
	kind: "pi-package",
	tools: ["hello_card"],
});
