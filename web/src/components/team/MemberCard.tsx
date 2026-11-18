import { useEffect, useId, useRef, useState } from "react";
import {
	deleteMember,
	type MemberMemoryDto,
	type OrganizationDto,
	type RoleTemplateDto,
	type TeamMemberDto,
	type WorkspaceDto,
} from "../../api.ts";
import { formatMemberGitIdentity, formatRoleToolTierLabel, getBotTheme, stripMarkdownFormatting } from "../../utils.ts";
import { BotFaceIcon } from "../BotFaceIcon.tsx";

interface MemberCardProps {
	member: TeamMemberDto;
	index: number;
	template?: RoleTemplateDto;
	memories: MemberMemoryDto[];
	activeWorkspace: WorkspaceDto | null;
	activeOrg: OrganizationDto | null;
	onAssignTask: (memberId: string) => void;
	onSetPrimary: (memberId: string) => Promise<void>;
	onExportMember: (memberId: string) => Promise<void>;
	onInspectMember: (memberId: string, tab: "identity" | "memories") => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

/** Light, scannable AI role card; Git identity, skills, and memory curation open in MemberInspectorModal. */
export function MemberCard({
	member,
	index,
	template,
	memories,
	activeOrg,
	onAssignTask,
	onSetPrimary,
	onExportMember,
	onInspectMember,
	onRefresh,
	onNotice,
	onError,
}: MemberCardProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [deletingMember, setDeletingMember] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const menuButtonRef = useRef<HTMLButtonElement>(null);
	const menuId = useId();
	const closeMenu = () => {
		setMenuOpen(false);
		menuButtonRef.current?.focus();
	};

	useEffect(() => {
		if (!menuOpen) {
			setConfirmDelete(false);
			return;
		}
		const handlePointerDown = (e: PointerEvent) => {
			if (e.target instanceof Node && menuRef.current && !menuRef.current.contains(e.target)) {
				setMenuOpen(false);
			}
		};
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				setMenuOpen(false);
				menuButtonRef.current?.focus();
				return;
			}
			if (!(e.target instanceof Node) || !menuRef.current?.contains(e.target)) return;
			const items = Array.from(
				menuRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
			);
			if (!items.length) return;
			const current =
				document.activeElement instanceof HTMLButtonElement ? items.indexOf(document.activeElement) : -1;
			let target: HTMLButtonElement | undefined;
			switch (e.key) {
				case "Home":
					target = items[0];
					break;
				case "End":
					target = items.at(-1);
					break;
				case "ArrowDown":
					target = items[(current + 1) % items.length];
					break;
				case "ArrowUp":
					target = items.at(current <= 0 ? -1 : current - 1);
					break;
				default:
					return;
			}
			e.preventDefault();
			target?.focus();
		};
		const target = confirmDelete ? ".member-more-confirm button" : '[role="menuitem"]';
		menuRef.current?.querySelector<HTMLButtonElement>(target)?.focus();
		document.addEventListener("pointerdown", handlePointerDown);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [menuOpen, confirmDelete]);

	const theme = getBotTheme(index);
	const gitIdentity = formatMemberGitIdentity(member, activeOrg);
	const verifiedCount = memories.filter((m) => m.status === "verified" || (!m.status && m.verified)).length;
	const candidateCount = memories.filter((m) => m.status === "candidate" || (!m.status && !m.verified)).length;

	const cleanResponsibility = template?.responsibilities
		? stripMarkdownFormatting(template.responsibilities.split("\n")[0] ?? "")
		: "";
	const antiJobsCount = template?.antiJobs?.length ?? 0;

	return (
		<div className="member-card">
			<div className="member-card-top">
				<div className="member-ident">
					<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="md" />
					<div className="member-ident-copy">
						<div className="member-name-row">
							<strong>{member.displayName}</strong>
							{member.isPrimaryContact && <span className="pill live">主联系</span>}
						</div>
						<div className="member-sub" title={`${member.roleTitle} · ${member.model}`}>
							{member.roleTitle}
						</div>
					</div>
				</div>
				{(candidateCount > 0 || verifiedCount > 0) && (
					<div className="member-memory-badges">
						{candidateCount > 0 && (
							<span className="rsi-badge rsi-status-candidate">{candidateCount} 待核验</span>
						)}
						{verifiedCount > 0 && <span className="pill">{verifiedCount} 经验</span>}
					</div>
				)}
			</div>

			{cleanResponsibility && (
				<p className="member-resp" title={cleanResponsibility}>
					{cleanResponsibility}
				</p>
			)}
			{member.identitySummary && <div className="member-summary-line">{member.identitySummary}</div>}

			<div
				className="member-meta-line"
				title={`Git Author：${gitIdentity.formatted}${template?.tools.length ? ` · 工具：${template.tools.join(", ")}` : ""}`}
			>
				<span>{formatRoleToolTierLabel(template?.tools)}</span>
				{antiJobsCount > 0 && (
					<>
						<span aria-hidden="true">·</span>
						<span>{antiJobsCount} 条边界</span>
					</>
				)}
				<span aria-hidden="true">·</span>
				<span className="member-meta-model">{member.model}</span>
			</div>

			<div className="member-card-footer">
				<div className="member-footer-primary">
					<button type="button" className="btn-pill-dark btn-xs" onClick={() => onAssignTask(member.id)}>
						向 TA 派活
					</button>
					<button
						type="button"
						className="btn-pill-outline btn-xs"
						onClick={() => onInspectMember(member.id, memories.length > 0 ? "memories" : "identity")}
					>
						详情与经验{memories.length > 0 ? ` (${memories.length})` : ""}
					</button>
				</div>
				<div className="member-more-wrap" ref={menuRef}>
					<button
						ref={menuButtonRef}
						type="button"
						className={`icon-btn member-more-btn${menuOpen ? " active" : ""}`}
						aria-label={`${member.displayName} 更多操作`}
						aria-expanded={menuOpen}
						aria-haspopup="menu"
						aria-controls={menuOpen ? menuId : undefined}
						onClick={() => setMenuOpen((v) => !v)}
						onKeyDown={(event) => {
							if (event.key === "ArrowDown" && !menuOpen) {
								event.preventDefault();
								setMenuOpen(true);
							}
						}}
					>
						···
					</button>
					{menuOpen && (
						<div
							className="member-more-popover"
							id={menuId}
							role="menu"
							aria-label={`${member.displayName} 操作`}
							onBlur={(event) => {
								if (event.relatedTarget instanceof Node && !menuRef.current?.contains(event.relatedTarget)) {
									setMenuOpen(false);
								}
							}}
						>
							<button
								type="button"
								className="member-more-item"
								role="menuitem"
								onClick={() => {
									closeMenu();
									onInspectMember(member.id, "identity");
								}}
							>
								身份与 Git 署名
							</button>
							{!member.isPrimaryContact && (
								<button
									type="button"
									className="member-more-item"
									role="menuitem"
									onClick={() => {
										closeMenu();
										void onSetPrimary(member.id);
									}}
								>
									设为默认主联系
								</button>
							)}
							<button
								type="button"
								className="member-more-item"
								role="menuitem"
								onClick={() => {
									closeMenu();
									void onExportMember(member.id);
								}}
							>
								导出能力包
							</button>
							{!member.isPrimaryContact &&
								(confirmDelete ? (
									<div className="member-more-confirm">
										<button
											type="button"
											className="member-more-item danger"
											role="menuitem"
											disabled={deletingMember}
											onClick={() => {
												setDeletingMember(true);
												void deleteMember(member.id)
													.then(async () => {
														setMenuOpen(false);
														onNotice(`已移除成员「${member.displayName}」`);
														await onRefresh();
													})
													.catch((err: unknown) => {
														onError(err instanceof Error ? err.message : String(err));
													})
													.finally(() => {
														setDeletingMember(false);
														setConfirmDelete(false);
													});
											}}
										>
											{deletingMember ? "移除中…" : "确认移除角色"}
										</button>
									</div>
								) : (
									<button
										type="button"
										className="member-more-item danger"
										role="menuitem"
										onClick={() => setConfirmDelete(true)}
									>
										移除角色
									</button>
								))}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
