import type { NewSkillDraftDto, RoleScope, SkillStorageScope } from "../../api.ts";
import { allowedSkillScopesForRoleScope, resolveSkillStorageScopeForRole } from "../../architectApi.ts";

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
	const allowedStorageOptions = allowedSkillScopesForRoleScope(roleScope, isSuperAdmin);

	const updateItem = (idx: number, patch: Partial<NewSkillDraftDto>) => {
		onChangeSkills(skills.map((item, i) => (i === idx ? { ...item, ...patch } : item)));
	};

	return (
		<div className="new-skills-draft-box">
			<div className="new-skills-draft-head">
				<div>
					<strong>配套新建 Skill 草案（勾选确认后落盘）</strong>
					<span className="muted-tiny">仅在点击确认创建后写入对应目录的 SKILL.md，不勾选则不生成文件</span>
				</div>
				{onAddCustomSkill && !disabled && (
					<button type="button" className="btn-inline btn-xs" onClick={onAddCustomSkill}>
						+ 添加自定义 Skill
					</button>
				)}
			</div>
			{skills.length === 0 ? (
				<div className="muted-tiny">当前未附加待新建 Skill，可直接添加或仅引用现有 Skill。</div>
			) : (
				<div className="new-skills-draft-list">
					{skills.map((skill, idx) => {
						const checked = selectedIndices.includes(idx);
						const effectiveScope = resolveSkillStorageScopeForRole(skill.storageScope, roleScope, isSuperAdmin);
						return (
							<div key={`${skill.name}-${idx}`} className={`new-skill-draft-card ${checked ? "selected" : ""}`}>
								<div className="new-skill-draft-top">
									<label className="checkbox-label">
										<input
											type="checkbox"
											checked={checked}
											disabled={disabled}
											onChange={() => onToggle(idx)}
										/>
										<span className="mono-chip">{skill.name}</span>
									</label>
									<select
										className="wechat-row-select"
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
									</select>
								</div>
								<div className="form-grid">
									<label className="identity-field">
										<span className="identity-field-label">Skill 标识（小写短横线）</span>
										<input
											className="input-field"
											disabled={disabled || !checked}
											value={skill.name}
											onChange={(e) => updateItem(idx, { name: e.target.value })}
										/>
									</label>
									<label className="identity-field">
										<span className="identity-field-label">触发描述（description）</span>
										<input
											className="input-field"
											disabled={disabled || !checked}
											value={skill.description}
											onChange={(e) => updateItem(idx, { description: e.target.value })}
										/>
									</label>
								</div>
								<details>
									<summary className="muted-tiny">查看或微调 SKILL.md 正文内容</summary>
									<textarea
										rows={5}
										className="composer-input mono-input"
										disabled={disabled || !checked}
										value={skill.body}
										onChange={(e) => updateItem(idx, { body: e.target.value })}
									/>
								</details>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
