import { useEffect, useId, useRef, useState } from "react";
import {
	deleteMember,
	type OrganizationDto,
	type RoleScope,
	type RoleTemplateDto,
	type TeamMemberDto,
	type WorkspaceDto,
} from "../../api.ts";
import { getMemberScopeBadge } from "../../architectApi.ts";
import { Badge, type BadgeTone, BotFaceIcon, Button, Card, IconButton } from "../../primitives/index.ts";
import { formatMemberGitIdentity, getBotTheme, stripMarkdownFormatting } from "../../utils.ts";

const SCOPE_BADGE_TONE: Record<RoleScope, BadgeTone> = {
	global: "neutral",
	org: "info",
	personal: "observer",
};

const MENU_ITEM_CLS =
	"w-full border-0 bg-transparent text-ink text-xs font-medium text-left px-2.5 py-1.5 rounded-xs cursor-pointer whitespace-nowrap hover:bg-subtle focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45";
const MENU_ITEM_DANGER_CLS =
	"w-full border-0 bg-transparent text-danger-text text-xs font-medium text-left px-2.5 py-1.5 rounded-xs cursor-pointer whitespace-nowrap hover:bg-danger-bg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45";

interface MemberCardProps {
	member: TeamMemberDto;
	index: number;
	template?: RoleTemplateDto;
	activeWorkspace: WorkspaceDto | null;
	activeOrg: OrganizationDto | null;
	organizationName?: (id: string | null) => string | null;
	canManage?: boolean;
	isPrimary?: boolean;
	canSetPrimary?: boolean;
	primaryActionLabel?: string;
	canDispatch?: boolean;
	onAssignTask: (memberId: string) => void;
	onSetPrimary: (memberId: string) => Promise<void>;
	onExportMember: (memberId: string) => Promise<void>;
	onInspectMember: (memberId: string) => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

/** Light, scannable AI role card; Git identity and role details open in MemberInspectorModal. */
export function MemberCard({
	member,
	index,
	template,
	activeOrg,
	organizationName,
	canManage = true,
	isPrimary: isPrimaryProp,
	canSetPrimary = false,
	primaryActionLabel = "设为主联系人",
	canDispatch = true,
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
		const targetSelector = confirmDelete ? '[data-confirm-delete="true"]' : '[role="menuitem"]';
		menuRef.current?.querySelector<HTMLButtonElement>(targetSelector)?.focus();
		document.addEventListener("pointerdown", handlePointerDown);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [menuOpen, confirmDelete]);

	const theme = getBotTheme(index);
	const gitIdentity = formatMemberGitIdentity(member, activeOrg);

	const cleanResponsibility = template?.responsibilities
		? stripMarkdownFormatting(template.responsibilities.split("\n")[0] ?? "")
		: "";
	const antiJobsCount = template?.antiJobs?.length ?? 0;
	const scopeBadge = getMemberScopeBadge(member, organizationName);
	const isPrimary = isPrimaryProp ?? member.isPrimaryContact;

	return (
		<Card padding="md" className="h-full flex flex-col gap-2.5 shadow-sm">
			<div className="flex items-start justify-between gap-2.5">
				<div className="flex items-center gap-2.5 min-w-0 flex-1">
					<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="md" />
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-1.5 flex-wrap">
							<strong className="text-sm font-semibold text-ink">{member.displayName}</strong>
							{isPrimary && (
								<Badge tone="success" dot>
									主联系
								</Badge>
							)}
							<Badge tone={SCOPE_BADGE_TONE[scopeBadge.scope]}>{scopeBadge.label}</Badge>
						</div>
						{member.roleTitle &&
							member.roleTitle.trim().toLowerCase() !== member.displayName.trim().toLowerCase() && (
								<div className="mt-0.5 text-xs text-ink-muted truncate" title={member.roleTitle}>
									{member.roleTitle}
								</div>
							)}
					</div>
				</div>
			</div>

			{cleanResponsibility && (
				<p className="m-0 text-sm text-ink-secondary leading-relaxed line-clamp-3" title={cleanResponsibility}>
					{cleanResponsibility}
				</p>
			)}
			{member.identitySummary && (
				<div className="text-xs text-ink-muted leading-snug truncate">{member.identitySummary}</div>
			)}

			<div
				className="flex items-center gap-1.5 flex-wrap text-xs text-ink-muted leading-snug"
				title={`Git Author：${gitIdentity.formatted}`}
			>
				<span>共享运行工具</span>
				{antiJobsCount > 0 && (
					<>
						<span aria-hidden="true">·</span>
						<span>{antiJobsCount} 条边界</span>
					</>
				)}
			</div>

			<div className="mt-auto pt-2.5 border-t border-line-subtle flex items-center justify-between gap-2">
				<div className="flex items-center gap-2 flex-wrap">
					{canDispatch && (
						<Button variant="primary" size="xs" onClick={() => onAssignTask(member.id)}>
							向 TA 派活
						</Button>
					)}
					<Button variant="secondary" size="xs" onClick={() => onInspectMember(member.id)}>
						身份与详情
					</Button>
				</div>
				<div className="relative shrink-0" ref={menuRef}>
					<IconButton
						ref={menuButtonRef}
						size="sm"
						variant="ghost"
						active={menuOpen}
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
					</IconButton>
					{menuOpen && (
						<div
							className="absolute right-0 bottom-full mb-1.5 z-30 min-w-[148px] p-1 bg-card border border-line rounded-md shadow-md flex flex-col gap-0.5"
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
								className={MENU_ITEM_CLS}
								role="menuitem"
								onClick={() => {
									closeMenu();
									onInspectMember(member.id);
								}}
							>
								身份与 Git 署名
							</button>
							{!isPrimary && canSetPrimary && (
								<button
									type="button"
									className={MENU_ITEM_CLS}
									role="menuitem"
									onClick={() => {
										closeMenu();
										void onSetPrimary(member.id);
									}}
								>
									{primaryActionLabel}
								</button>
							)}
							<button
								type="button"
								className={MENU_ITEM_CLS}
								role="menuitem"
								onClick={() => {
									closeMenu();
									void onExportMember(member.id);
								}}
							>
								导出能力包
							</button>
							{!isPrimary &&
								!member.isPrimaryContact &&
								canManage &&
								(confirmDelete ? (
									<div className="border-t border-line mt-0.5 pt-0.5 flex flex-col">
										<button
											type="button"
											data-confirm-delete="true"
											className={MENU_ITEM_DANGER_CLS}
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
										className={MENU_ITEM_DANGER_CLS}
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
		</Card>
	);
}
