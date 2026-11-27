import { useId } from "react";
import type { NewSkillDraftDto, RoleScope, SkillStorageScope } from "../../api.ts";
import { allowedSkillScopesForRoleScope, resolveSkillStorageScopeForRole } from "../../architectApi.ts";
import { Button, Card, FieldGroup, Input, Select, SettingsDisclosure, Textarea } from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";

interface NewSkillsDraftSectionProps {
	skills: NewSkillDraftDto[];
	selectedIndices: number[];
	roleScope: RoleScope;
	isSuperAdmin: boolean;
	disabled?: boolean;
	onToggle: (index: number) => void;
	onChangeSkills: (next: NewSkillDraftDto[]) => void;
	onAddCustomSkill?: () => void;
}

/** Shared editable preview & confirmation list for optional new SKILL.md drafts proposed before writing to disk. */
export function NewSkillsDraftSection({
	skills,
	selectedIndices,
	roleScope,
	isSuperAdmin,
	disabled = false,
	onToggle,
	onChangeSkills,
	onAddCustomSkill,
}: NewSkillsDraftSectionProps) {
	const baseId = useId();
	const allowedStorageOptions = allowedSkillScopesForRoleScope(roleScope, isSuperAdmin);

	const updateItem = (idx: number, patch: Partial<NewSkillDraftDto>) => {
		onChangeSkills(skills.map((item, i) => (i === idx ? { ...item, ...patch } : item)));
	};

	return (
		<div className="mt-2.5 p-3 rounded-md border border-dashed border-line bg-sidebar flex flex-col gap-2.5">
			<div className="flex items-start justify-between gap-2 flex-wrap text-xs">
				<div className="flex flex-col gap-0.5 min-w-0">
					<strong className="font-semibold text-ink">配套新建 Skill 草案（勾选确认后落盘）</strong>
					<span className="text-micro text-ink-muted">
						仅在点击确认创建后写入对应目录的 SKILL.md，不勾选则不生成文件
					</span>
				</div>
				{onAddCustomSkill && !disabled && (
					<Button variant="inline" size="xs" onClick={onAddCustomSkill}>
						+ 添加自定义 Skill
					</Button>
				)}
			</div>
			{skills.length === 0 ? (
				<div className="text-xs text-ink-muted">当前未附加待新建 Skill，可直接添加或仅引用现有 Skill。</div>
			) : (
				<div className="flex flex-col gap-2">
					{skills.map((skill, idx) => {
						const checked = selectedIndices.includes(idx);
						const effectiveScope = resolveSkillStorageScopeForRole(skill.storageScope, roleScope, isSuperAdmin);
						const nameInputId = `${baseId}-name-${idx}`;
						const descInputId = `${baseId}-desc-${idx}`;
						return (
							<Card
								key={`${skill.name}-${idx}`}
								padding="sm"
								className={cn(
									"flex flex-col gap-2.5 transition-colors",
									checked ? "border-accent-border bg-surface-accent" : "bg-stage",
								)}
							>
								<div className="flex items-center justify-between gap-2 flex-wrap">
									<label className="inline-flex items-center gap-2 text-xs text-ink-secondary cursor-pointer select-none">
										<input
											type="checkbox"
											checked={checked}
											disabled={disabled}
											onChange={() => onToggle(idx)}
											className="size-3.5 accent-accent cursor-pointer"
										/>
										<code className="px-1.5 py-0.5 rounded-xs bg-subtle border border-line font-mono text-micro text-ink">
											{skill.name}
										</code>
									</label>
									<div className="max-w-full sm:max-w-[280px]">
										<Select
											size="sm"
											aria-label="Skill 保存位置"
											disabled={disabled || !checked}
											value={effectiveScope}
											onChange={(e) => updateItem(idx, { storageScope: e.target.value as SkillStorageScope })}
										>
											{allowedStorageOptions.map((opt) => (
												<option key={opt.value} value={opt.value}>
													{opt.label}
												</option>
											))}
										</Select>
									</div>
								</div>
								<div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
									<FieldGroup label="Skill 标识（小写短横线）" htmlFor={nameInputId}>
										<Input
											id={nameInputId}
											size="sm"
											mono
											disabled={disabled || !checked}
											value={skill.name}
											onChange={(e) => updateItem(idx, { name: e.target.value })}
										/>
									</FieldGroup>
									<FieldGroup label="触发描述（description）" htmlFor={descInputId}>
										<Input
											id={descInputId}
											size="sm"
											disabled={disabled || !checked}
											value={skill.description}
											onChange={(e) => updateItem(idx, { description: e.target.value })}
										/>
									</FieldGroup>
								</div>
								<SettingsDisclosure summary="查看或微调 SKILL.md 正文内容">
									<Textarea
										rows={5}
										mono
										disabled={disabled || !checked}
										value={skill.body}
										onChange={(e) => updateItem(idx, { body: e.target.value })}
									/>
								</SettingsDisclosure>
							</Card>
						);
					})}
				</div>
			)}
		</div>
	);
}
