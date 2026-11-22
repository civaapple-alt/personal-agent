import type { BootstrapPayload } from "../api.ts";
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
