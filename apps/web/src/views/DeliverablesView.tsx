import type { BootstrapPayload } from "../api.ts";
import { PageShell, PaneHeader } from "../primitives/index.ts";
import { SpacePages } from "./SpacePages.tsx";

interface DeliverablesViewProps {
	spaceRoute: { pageId?: string };
	bootstrap: BootstrapPayload | null;
	memberName: (id: string) => string;
	onOpenMatterChat: (matterId: string) => void;
}

/** Browse documents and their Git revisions across accessible spaces. */
export function DeliverablesView(props: DeliverablesViewProps) {
	return (
		<PageShell maxWidth="wide">
			<PaneHeader
				title="资料空间"
				subtitle="每个组织、仓库、用户、AI 角色与自定义空间均以独立 Git 仓库管理资料与修订历史"
			/>
			<SpacePages
				bootstrap={props.bootstrap}
				pageId={props.spaceRoute.pageId}
				memberName={props.memberName}
				onOpenMatter={props.onOpenMatterChat}
			/>
		</PageShell>
	);
}
