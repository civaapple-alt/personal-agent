import { defineWebExtension, type PaToolRenderProps } from "@pa/extension-sdk/web";
import { createElement as h } from "react";

function HelloCard({ args }: PaToolRenderProps) {
	const greeting = typeof args.greeting === "string" ? args.greeting : "Hello from PA extension";
	return h("div", { className: "pa-viz-file" }, h("strong", null, greeting));
}

export default defineWebExtension({
	name: "hello-card",
	title: "Hello Card Example",
	description: "Minimal external PA web half registering a tool display and primary card renderer.",
	toolDisplays: {
		hello_card: {
			label: "示例卡片",
			category: "custom",
		},
	},
	toolRenderers: {
		hello_card: {
			renderer: HelloCard,
			prominence: "primary",
		},
	},
});
