import { defineWebExtension } from "@pa/extension-api/web";

const DOC_TYPE_LABELS: Record<string, string> = {
	plan: "方案",
	spec: "规格",
	decision: "决策",
	rule: "规范",
	note: "资料",
};

export default defineWebExtension({
	name: "space",
	title: "Git 资料空间读写",
	description: "在执行记录中呈现资料空间的文档类型、标题与读取路径。",
	toolDisplays: {
		read_space: {
			label: "读取资料空间",
			category: "space",
			formatSummary: ({ args, summary }) => {
				if (!args) return summary;
				const pageId = typeof args.pageId === "string" ? args.pageId.trim() : "";
				const subPath = typeof args.subPath === "string" ? args.subPath.trim() : "";
				const docType = typeof args.docType === "string" ? (DOC_TYPE_LABELS[args.docType] ?? args.docType) : "";
				if (pageId) return subPath ? `${pageId}/${subPath}` : pageId;
				if (docType) return `列出 ${docType} 文档`;
				return summary || "列出当前事项资料空间";
			},
		},
		save_space_page: {
			label: "保存资料空间页面",
			category: "space",
			formatSummary: ({ args, summary }) => {
				if (!args) return summary;
				const title = typeof args.title === "string" ? args.title.trim() : "";
				const docType = typeof args.docType === "string" ? (DOC_TYPE_LABELS[args.docType] ?? args.docType) : "";
				if (title) return docType ? `[${docType}] ${title}` : title;
				return summary;
			},
		},
	},
});
