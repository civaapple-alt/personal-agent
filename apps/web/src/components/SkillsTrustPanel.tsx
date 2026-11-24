import {
	type ManagedSkillDetailDto,
	type ManagedSkillEntryDto,
	SKILL_TRUST_LEVEL_LABELS,
	type SkillTrustLevel,
	type SkillTrustScope,
} from "@pa/contracts/skill-trust";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchManagedSkillDetail, fetchManagedSkills, updateSkillTrustPolicy } from "../api.ts";

interface SkillsTrustPanelProps {
	onNotice?: (message: string) => void;
	onError?: (message: string) => void;
}

const TRUST_BADGE_CLASS: Record<SkillTrustLevel, string> = {
	confirm: "rsi-status-candidate",
	autonomous: "rsi-status-verified",
	disabled: "rsi-status-rejected",
};

/** Settings → 技能与信任 panel for inspecting disk-persisted Skills and promoting Four-Step Trust policies. */
export function SkillsTrustPanel({ onNotice, onError }: SkillsTrustPanelProps) {
	const [skills, setSkills] = useState<ManagedSkillEntryDto[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [scopeFilter, setScopeFilter] = useState<"all" | SkillTrustScope>("all");
	const [updatingKey, setUpdatingKey] = useState<string | null>(null);
	const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});
	const [detailsByKey, setDetailsByKey] = useState<Record<string, ManagedSkillDetailDto>>({});
	const [loadingDetailKeys, setLoadingDetailKeys] = useState<Record<string, boolean>>({});
	const [detailErrorByKey, setDetailErrorByKey] = useState<Record<string, string>>({});

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetchManagedSkills();
			setSkills(res.skills);
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const visibleSkills = useMemo(() => {
		if (scopeFilter === "all") return skills;
		return skills.filter((item) => item.scope === scopeFilter);
	}, [skills, scopeFilter]);

	const handleToggleDetail = async (skill: ManagedSkillEntryDto) => {
		const key = `${skill.scope}:${skill.scopeId}:${skill.name}`;
		const nextOpen = !expandedKeys[key];
		setExpandedKeys((prev) => ({ ...prev, [key]: nextOpen }));
		if (!nextOpen || detailsByKey[key] || loadingDetailKeys[key]) return;
		setLoadingDetailKeys((prev) => ({ ...prev, [key]: true }));
		setDetailErrorByKey((prev) => {
			const next = { ...prev };
			delete next[key];
			return next;
		});
		try {
			const { detail } = await fetchManagedSkillDetail({
				scope: skill.scope,
				scopeId: skill.scopeId,
				skillName: skill.name,
			});
			setDetailsByKey((prev) => ({ ...prev, [key]: detail }));
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			setDetailErrorByKey((prev) => ({ ...prev, [key]: msg }));
		} finally {
			setLoadingDetailKeys((prev) => ({ ...prev, [key]: false }));
		}
	};

	const handleSetTrust = async (skill: ManagedSkillEntryDto, trustLevel: SkillTrustLevel) => {
		const key = `${skill.scope}:${skill.scopeId}:${skill.name}`;
		if (updatingKey) return;
		setUpdatingKey(key);
		try {
			await updateSkillTrustPolicy({
				scope: skill.scope,
				scopeId: skill.scopeId,
				skillName: skill.name,
				trustLevel,
			});
			onNotice?.(`已将 Skill「${skill.name}」设为「${SKILL_TRUST_LEVEL_LABELS[trustLevel]}」`);
			await load();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			onError?.(msg);
		} finally {
			setUpdatingKey(null);
		}
	};

	return (
		<section className="ui-section">
			<div className="ui-section-head">
				<div>
					<h2 className="ui-section-title">技能与信任（信任四步）</h2>
					<p className="ui-section-desc">
						先试探 → 通过 <code>propose_skill</code> 存为标准 <code>SKILL.md</code> 与脚本 → 步骤
						3（执行前弹窗确认）→ 步骤 4（授权自主执行）。所有 Skill 本体保存在磁盘，此处仅管理脚本执行信任策略。
					</p>
				</div>
				<div className="actions-row compact">
					{(
						[
							["all", `全部 (${skills.length})`],
							["workspace", "仓库"],
							["org", "组织"],
							["personal", "个人"],
							["global", "全局"],
						] as const
					).map(([id, label]) => (
						<button
							key={id}
							type="button"
							className={`choice-chip ${scopeFilter === id ? "active" : ""}`}
							onClick={() => setScopeFilter(id)}
						>
							{label}
						</button>
					))}
					<button type="button" className="btn-pill-outline btn-xs" onClick={() => void load()} disabled={loading}>
						{loading ? "扫描中…" : "重新扫描"}
					</button>
				</div>
			</div>

			{error && (
				<div className="approval-card" role="alert">
					读取 Skill 列表失败：{error}
				</div>
			)}

			{!loading && visibleSkills.length === 0 ? (
				<div className="ui-card">
					<p className="muted-tiny">
						当前作用域下暂无已落盘的自定义 Skill。在事项对话中完成可复用流程后，可让角色调用{" "}
						<code>propose_skill</code> 生成确认卡并保存为标准 Pi Skill。
					</p>
				</div>
			) : (
				<div className="settings-ext-grid">
					{visibleSkills.map((skill) => {
						const key = `${skill.scope}:${skill.scopeId}:${skill.name}`;
						const busy = updatingKey === key;
						const expanded = Boolean(expandedKeys[key]);
						const detail = detailsByKey[key];
						const detailLoading = Boolean(loadingDetailKeys[key]);
						const detailError = detailErrorByKey[key];
						return (
							<div key={key} className="ui-card settings-ext-card">
								<div className="banner-row">
									<div>
										<strong>{skill.name}</strong> <span className="pill">{skill.scopeLabel}</span>{" "}
										<span className={`pill ${TRUST_BADGE_CLASS[skill.trustLevel]}`}>
											{SKILL_TRUST_LEVEL_LABELS[skill.trustLevel]}
										</span>
									</div>
									<span className="muted-tiny">
										{skill.runCount > 0 ? `已执行 ${skill.runCount} 次` : "尚未触发脚本"}
									</span>
								</div>
								<p className="muted-tiny">{skill.description}</p>
								{skill.scripts.length > 0 && (
									<div className="tag-list">
										{skill.scripts.map((script) => (
											<span key={script} className="tag-chip skill">
												{script}
											</span>
										))}
									</div>
								)}
								<div className="muted-tiny" title={skill.filePath}>
									路径：<code>{skill.filePath}</code>
								</div>
								<div className="actions-row compact">
									<button
										type="button"
										className="btn-pill-outline btn-xs"
										onClick={() => void handleToggleDetail(skill)}
									>
										{expanded
											? "收起内容"
											: skill.scripts.length > 0
												? `查看 SKILL.md 与 ${skill.scripts.length} 个脚本`
												: "查看 SKILL.md"}
									</button>
									{skill.canManage && skill.trustLevel !== "autonomous" && (
										<button
											type="button"
											className="btn-pill-dark btn-xs"
											disabled={busy}
											onClick={() => void handleSetTrust(skill, "autonomous")}
										>
											升级为自主执行
										</button>
									)}
									{skill.canManage && skill.trustLevel !== "confirm" && (
										<button
											type="button"
											className="btn-pill-outline btn-xs"
											disabled={busy}
											onClick={() => void handleSetTrust(skill, "confirm")}
										>
											设为执行前确认
										</button>
									)}
									{skill.canManage && skill.trustLevel !== "disabled" && (
										<button
											type="button"
											className="btn-inline"
											disabled={busy}
											onClick={() => void handleSetTrust(skill, "disabled")}
										>
											停用脚本
										</button>
									)}
								</div>
								{expanded && (
									<div className="stack-gap-sm" style={{ marginTop: 8 }}>
										{detailLoading && <p className="muted-tiny">正在读取 SKILL.md 与脚本内容…</p>}
										{detailError && (
											<p className="muted-tiny" style={{ color: "var(--danger, #b91c1c)" }}>
												读取失败：{detailError}
											</p>
										)}
										{detail && (
											<>
												<div>
													<div className="muted-xs" style={{ fontWeight: 600, marginBottom: 4 }}>
														<code>SKILL.md</code>
													</div>
													<pre className="pa-viz-code">
														<code>{detail.content}</code>
													</pre>
												</div>
												{detail.scripts.map((script) => (
													<div key={script.path}>
														<div className="muted-xs" style={{ fontWeight: 600, marginBottom: 4 }}>
															<code>{script.path}</code>
														</div>
														<pre className="pa-viz-code">
															<code>{script.content}</code>
														</pre>
													</div>
												))}
											</>
										)}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}
