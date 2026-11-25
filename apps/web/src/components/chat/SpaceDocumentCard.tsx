import { type SpaceDocumentType, spaceDocTypeLabel } from "../../api/space.ts";

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
		<div className="space-doc-card">
			<button type="button" className="space-doc-card-main" onClick={() => onOpen(false)}>
				<div className="space-doc-card-head">
					<span className={`space-doc-type-pill is-${resolvedType}`}>{spaceDocTypeLabel(resolvedType)}</span>
					<strong className="space-doc-card-title">{doc.title}</strong>
					<span className="space-doc-card-rev">
						{doc.spaceName ? `${doc.spaceName} · ` : ""}rev {doc.revision}
						{doc.headCommit ? ` · ${doc.headCommit.slice(0, 7)}` : ""}
					</span>
				</div>
				{doc.summary && <p className="space-doc-card-summary">{doc.summary}</p>}
			</button>
			<div className="space-doc-card-actions">
				{showProceed && onProceed && (
					<button type="button" className="btn-pill-dark btn-xs" onClick={onProceed}>
						确认并推进
					</button>
				)}
				<button type="button" className="btn-pill-outline btn-xs" onClick={() => onOpen(false)}>
					查看全文
				</button>
				{doc.revision > 1 && (
					<button type="button" className="btn-inline" onClick={() => onOpen(true)}>
						查看变更
					</button>
				)}
			</div>
		</div>
	);
}
