import { useMemo, useState } from "react";
import {
	type CollaboratorDto,
	exportMemberPackage,
	type MatterDto,
	type MemberMemoryDto,
	type OrganizationDto,
	type RoleTemplateDto,
	setPrimaryMember,
	type TeamMemberDto,
	type WorkspaceDto,
} from "../api.ts";
import { CollaboratorsSection } from "./team/CollaboratorsSection.tsx";
import { MemberCard } from "./team/MemberCard.tsx";
import { MemberPackageForms } from "./team/MemberPackageForms.tsx";
import { OrganizationsSection } from "./team/OrganizationsSection.tsx";

interface TeamViewProps {
	currentUser?: CollaboratorDto | null;
	collaborators?: CollaboratorDto[];
	members: TeamMemberDto[];
	workspaces: WorkspaceDto[];
	organizations?: OrganizationDto[];
	matters?: MatterDto[];
	defaultWorkspaceId?: string | null;
	memoriesByMember: Record<string, MemberMemoryDto[]>;
	templateByRoleId: Map<string, RoleTemplateDto>;
	memberName: (id: string) => string;
	workspaceName: (id: string | null) => string | null;
	organizationName?: (id: string | null) => string | null;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
	onPreviewAsCollaborator?: (token: string) => void;
	onRestoreOwner?: () => void;
	onAssignTask: (memberId: string) => void;
	onOpenArchitect?: () => void;
	onOpenArchitectMatter?: () => void;
	onOpenMatter?: (matterId: string) => void;
	onOpenDeliverable?: (deliverableId: string) => void;
}

/** Coordinates the team page: human collaborators, organizations, member creation/import/export, and role cards. */
export function TeamView({
	currentUser,
	collaborators = [],
	members,
	workspaces,
	organizations = [],
	matters = [],
	defaultWorkspaceId = null,
	memoriesByMember,
	templateByRoleId,
	memberName,
	workspaceName,
	organizationName,
	onRefresh,
	onNotice,
	onError,
	onPreviewAsCollaborator,
	onRestoreOwner,
	onAssignTask,
	onOpenArchitect,
	onOpenArchitectMatter,
	onOpenMatter,
	onOpenDeliverable,
}: TeamViewProps) {
	const isOwner = currentUser?.permissionRole !== "collaborator";
	const [showAddMember, setShowAddMember] = useState(false);
	const [showImportMember, setShowImportMember] = useState(false);
	const [exportedPackage, setExportedPackage] = useState<{
		id: string;
		filename: string;
		markdown: string;
	} | null>(null);

	const matterWorkspaceById = useMemo(
		() => new Map(matters.map((matter) => [matter.id, matter.workspaceId])),
		[matters],
	);
	const activeWorkspace = useMemo(
		() => workspaces.find((ws) => ws.id === defaultWorkspaceId) ?? null,
		[workspaces, defaultWorkspaceId],
	);
	const activeOrg = useMemo(
		() => (activeWorkspace?.orgId ? (organizations.find((org) => org.id === activeWorkspace.orgId) ?? null) : null),
		[activeWorkspace, organizations],
	);

	const handleSetPrimary = async (memberId: string) => {
		await setPrimaryMember(memberId);
		onNotice(`已将「${memberName(memberId)}」设为默认主联系人`);
		await onRefresh();
	};

	const handleExportMember = async (memberId: string) => {
		const pkg = await exportMemberPackage(memberId);
		setExportedPackage(pkg);
	};

	return (
		<div className="subpage-scroll">
			<div className="subpage-inner wide">
				<div className="pane-header-row">
					<div className="pane-header">
						<h1>我的团队</h1>
						<p>查看角色分工与积累经验，支持新增自定义角色，或导入导出脱敏角色能力包</p>
					</div>
					{isOwner && (
						<div className="actions-row compact">
							{onOpenArchitectMatter && (
								<button type="button" className="btn-pill-dark" onClick={onOpenArchitectMatter}>
									请角色架构师对话规划 / 体检
								</button>
							)}
							{onOpenArchitect && (
								<button
									type="button"
									className={onOpenArchitectMatter ? "btn-pill-outline" : "btn-pill-dark"}
									onClick={onOpenArchitect}
								>
									+ 快速表单设计角色
								</button>
							)}
							<button
								type="button"
								className={onOpenArchitect ? "btn-pill-outline" : "btn-pill-dark"}
								onClick={() => {
									setShowAddMember((v) => !v);
									setShowImportMember(false);
								}}
							>
								+ 新增角色
							</button>
							<button
								type="button"
								className="btn-pill-outline"
								onClick={() => {
									setShowImportMember((v) => !v);
									setShowAddMember(false);
								}}
							>
								导入角色包
							</button>
						</div>
					)}
				</div>

				<div className="ui-sections-stack">
					<MemberPackageForms
						showAddMember={showAddMember}
						showImportMember={showImportMember}
						exportedPackage={exportedPackage}
						onCloseAddMember={() => setShowAddMember(false)}
						onCloseImportMember={() => setShowImportMember(false)}
						onCloseExportedPackage={() => setExportedPackage(null)}
						onRefresh={onRefresh}
						onNotice={onNotice}
						onError={onError}
					/>

					<CollaboratorsSection
						isOwner={isOwner}
						currentUser={currentUser}
						collaborators={collaborators}
						organizations={organizations}
						onRefresh={onRefresh}
						onNotice={onNotice}
						onError={onError}
						onPreviewAsCollaborator={onPreviewAsCollaborator}
						onRestoreOwner={onRestoreOwner}
					/>

					<OrganizationsSection
						isOwner={isOwner}
						organizations={organizations}
						workspaces={workspaces}
						onRefresh={onRefresh}
						onNotice={onNotice}
						onError={onError}
					/>

					<section className="ui-section">
						<div className="ui-section-head">
							<div>
								<h2 className="ui-section-title">AI 团队成员（{members.length}）</h2>
								<p className="ui-section-desc">各岗位独立维护角色规范、Git 提交者署名与三层成长记忆</p>
							</div>
						</div>
						<div className="team-grid">
							{members.map((member, idx) => (
								<MemberCard
									key={member.id}
									member={member}
									index={idx}
									template={templateByRoleId.get(member.templateId)}
									memories={memoriesByMember[member.id] ?? []}
									members={members}
									workspaces={workspaces}
									organizations={organizations}
									activeWorkspace={activeWorkspace}
									activeOrg={activeOrg}
									defaultWorkspaceId={defaultWorkspaceId}
									matterWorkspaceById={matterWorkspaceById}
									memberName={memberName}
									workspaceName={workspaceName}
									organizationName={organizationName}
									onAssignTask={onAssignTask}
									onSetPrimary={handleSetPrimary}
									onExportMember={handleExportMember}
									onOpenMatter={onOpenMatter}
									onOpenDeliverable={onOpenDeliverable}
									onRefresh={onRefresh}
									onNotice={onNotice}
									onError={onError}
								/>
							))}
						</div>
					</section>
				</div>
			</div>
		</div>
	);
}
