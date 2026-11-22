import type {
	AccountUserDto,
	BootstrapPayload,
	CollaboratorDto,
	DeliverableDto,
	DistillRsiResult,
	FeedbackRating,
} from "../api.ts";
import { SpacePages } from "./SpacePages.tsx";

interface DeliverablesViewProps {
	spaceRoute: { deliverableId?: string; pageId?: string };
	bootstrap: BootstrapPayload | null;
	currentUser?: CollaboratorDto | null;
	accountUser?: AccountUserDto | null;
	isSuperAdmin?: boolean;
	activeDeliverable?: DeliverableDto | null;
	filteredDeliverables?: DeliverableDto[];
	siblingVersions?: DeliverableDto[];
	previewUrlFor?: (deliverable: DeliverableDto | null) => string | null;
	memberName: (id: string) => string;
	workspaceName?: (id: string | null) => string | null;
	organizationName?: (id: string | null) => string | null;
	onSubmitFeedback?: (
		deliverableId: string,
		payload: { feedback?: string; rating?: FeedbackRating; autoDistill?: boolean },
	) => Promise<void>;
	onDistillExperiences?: (
		deliverable: DeliverableDto,
		feedback?: string,
		rating?: FeedbackRating,
	) => Promise<DistillRsiResult | undefined>;
	onCancelDistill?: (matterId: string) => void;
	onStopPreview?: (previewId: string) => Promise<void>;
	onSelectDeliverable?: (deliverableId: string, matterId?: string) => void;
	onRequestRevision?: (deliverable: DeliverableDto) => void;
	onOpenMatterChat: (matterId: string) => void;
	onOpenTeam?: () => void;
	onRefresh?: () => Promise<void>;
	onNotice?: (message: string) => void;
	onError?: (message: string) => void;
	onNewTask?: () => void;
}

/** Unified Space view backed by per-space Git repositories (replaces the legacy dual Deliverables/Space split). */
export function DeliverablesView(props: DeliverablesViewProps) {
	return (
		<div className="subpage-scroll">
			<div className="subpage-inner wide">
				<div className="pane-header-row">
					<div className="pane-header">
						<h1>资料空间</h1>
						<p>每个组织、仓库、用户、AI 角色与自定义空间均以独立 Git 仓库管理资料与修订历史</p>
					</div>
				</div>
				<SpacePages
					bootstrap={props.bootstrap}
					pageId={props.spaceRoute.pageId}
					memberName={props.memberName}
					onOpenMatter={props.onOpenMatterChat}
				/>
			</div>
		</div>
	);
}
