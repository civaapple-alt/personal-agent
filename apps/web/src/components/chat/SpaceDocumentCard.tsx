import { type SpaceDocumentType, spaceDocTypeLabel } from "../../api/space.ts";
import { Badge, type BadgeTone, Button, Card } from "../../primitives/index.ts";

export interface ChatSpaceDocumentItem {
	id: string;
	spaceId: string;
	spaceName?: string;
	title: string;
	docType?: SpaceDocumentType;
	revision: number;
	headCommit?: string;
	summary?: string;
}

const DOC_TYPE_TONE: Record<SpaceDocumentType, BadgeTone> = {
	plan: "accent",
	spec: "info",
	decision: "warn",
	rule: "observer",
	note: "neutral",
};

/** Actionable card rendered under an AI reply for a saved Space document, supporting right-pane content, Git diff, and plan-only proceed. */
export function SpaceDocumentCard({
	doc,
	canProceed = false,
	onOpen,
	onProceed,
}: {
	doc: ChatSpaceDocumentItem;
	canProceed?: boolean;
	onOpen: (showDiff: boolean) => void;
	onProceed?: () => void;
}) {
	const resolvedType: SpaceDocumentType = doc.docType ?? "note";
	const showProceed = canProceed && resolvedType === "plan" && Boolean(onProceed);
	return (
		<Card
			padding="none"
			className="mt-2.5 rounded-xl bg-surface overflow-hidden transition-all hover:border-accent-border hover:shadow-sm"
		>
			<button
				type="button"
				className="flex flex-col gap-1.5 w-full px-4 pt-3 pb-2.5 border-0 bg-transparent text-inherit text-left cursor-pointer"
				onClick={() => onOpen(false)}
			>
				<div className="flex items-center flex-wrap gap-2">
					<Badge tone={DOC_TYPE_TONE[resolvedType]} size="xs">
						{spaceDocTypeLabel(resolvedType)}
					</Badge>
					<strong className="text-sm font-semibold text-ink">{doc.title}</strong>
					<span className="text-micro text-ink-muted font-mono">
						{doc.spaceName ? `${doc.spaceName} · ` : ""}rev {doc.revision}
						{doc.headCommit ? ` · ${doc.headCommit.slice(0, 7)}` : ""}
					</span>
				</div>
				{doc.summary && <p className="m-0 text-xs text-ink-secondary leading-normal line-clamp-2">{doc.summary}</p>}
			</button>
			<div className="flex items-center gap-2.5 px-4 pb-3">
				{showProceed && onProceed && (
					<Button variant="primary" size="xs" onClick={onProceed}>
						确认并推进
					</Button>
				)}
				<Button variant="secondary" size="xs" onClick={() => onOpen(false)}>
					查看全文
				</Button>
				{doc.revision > 1 && (
					<Button variant="inline" size="xs" onClick={() => onOpen(true)}>
						查看变更
					</Button>
				)}
			</div>
		</Card>
	);
}
