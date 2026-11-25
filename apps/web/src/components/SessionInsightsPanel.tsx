import type { SessionInsightFinding, SessionInsightsReport } from "@pa/contracts/session-insights";
import { useCallback, useEffect, useState } from "react";
import { fetchRuntimeInsights } from "../api/runtime.ts";

interface SessionInsightsPanelProps {
	onStartMatterWithPrompt?: (prompt: string) => void;
	onOpenMatter?: (matterId: string) => void;
}

function buildFindingPrompt(item: SessionInsightFinding): string {
	const evidence = item.evidence?.length ? `\n相关证据：${item.evidence.join("；")}` : "";
	if (item.suggestSkillCapture) {
		return `运行洞察发现一条值得沉淀的模式：「${item.title}」。\n详情：${item.detail}${evidence}\n\n请帮我梳理成可复用的标准操作流程或脚本，并通过 propose_skill 提出 Skill 沉淀提案供我确认。`;
	}
	return `运行洞察发现异常/提醒：「${item.title}」。\n详情：${item.detail}${evidence}\n\n请帮我排查根因并给出具体修复建议；如果适合沉淀为长期约定或脚本，也请通过 propose_skill 提出。`;
}

function formatCompactNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

const SEVERITY_BADGE: Record<"error" | "warn" | "info", { label: string; className: string }> = {
	error: { label: "异常", className: "rsi-status-rejected" },
	warn: { label: "提醒", className: "rsi-status-candidate" },
	info: { label: "洞察", className: "rsi-status-verified" },
};

export function SessionInsightsPanel({ onStartMatterWithPrompt, onOpenMatter }: SessionInsightsPanelProps) {
	const [report, setReport] = useState<SessionInsightsReport | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [confirmingRescan, setConfirmingRescan] = useState(false);
	const [lastScanMs, setLastScanMs] = useState<number | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		setConfirmingRescan(false);
		const startedAt = performance.now();
		try {
			const data = await fetchRuntimeInsights({ limit: 40 });
			setReport(data);
			setLastScanMs(Math.max(1, Math.round(performance.now() - startedAt)));
		} catch (err) {
			setError(err instanceof Error ? err.message : "加载运行洞察失败");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<section className="ui-section">
			<div className="ui-section-head">
				<div className="ui-section-heading">
					<h2 className="ui-section-title">运行洞察（Session Insights）</h2>
					<p className="ui-section-desc">
						仅在本机只读分析当前账号有权访问的 Pi 会话记录，零模型调用、零网络请求
						{lastScanMs !== null ? ` · 本次扫描耗时 ${lastScanMs}ms` : ""}
					</p>
				</div>
				<div className="ui-section-actions">
					{confirmingRescan ? (
						<div className="insights-confirm-bar">
							<span className="insights-confirm-text">
								确认重新扫描最近 40 个本机会话？（零模型调用，约 &lt;100ms）
							</span>
							<button
								type="button"
								className="btn-pill-dark btn-xs"
								onClick={() => void load()}
								disabled={loading}
							>
								确认扫描
							</button>
							<button
								type="button"
								className="btn-inline btn-xs"
								onClick={() => setConfirmingRescan(false)}
								disabled={loading}
							>
								取消
							</button>
						</div>
					) : (
						<button
							type="button"
							className="btn-pill-outline btn-xs"
							onClick={() => setConfirmingRescan(true)}
							disabled={loading}
						>
							{loading ? "分析中…" : "重新扫描"}
						</button>
					)}
				</div>
			</div>

			{error && <div className="ui-banner error">{error}</div>}

			{!report && loading ? (
				<div className="ui-card insights-empty">正在扫描本地 Pi 会话文件…</div>
			) : report ? (
				<div className="insights-stack">
					<div className="insights-stats-grid">
						<div className="insights-stat-card">
							<span className="insights-stat-label">分析会话</span>
							<strong className="insights-stat-val">{report.usage.sessions}</strong>
							<span className="insights-stat-sub">{report.usage.turns} 轮对话</span>
						</div>
						<div className="insights-stat-card">
							<span className="insights-stat-label">工具调用</span>
							<strong className="insights-stat-val">{report.usage.toolCalls}</strong>
							<span className="insights-stat-sub">失败 {report.usage.toolErrors} 次</span>
						</div>
						<div className="insights-stat-card">
							<span className="insights-stat-label">Token 用量</span>
							<strong className="insights-stat-val">
								{formatCompactNumber(report.usage.inputTokens + report.usage.outputTokens)}
							</strong>
							<span className="insights-stat-sub">
								缓存命中 {formatCompactNumber(report.usage.cacheReadTokens)}
							</span>
						</div>
						<div className="insights-stat-card">
							<span className="insights-stat-label">Pi 记录成本</span>
							<strong className="insights-stat-val">${report.usage.totalCostUsd.toFixed(2)}</strong>
							<span className="insights-stat-sub">{report.usage.byModel.length} 个模型</span>
						</div>
					</div>

					<div className="ui-card insights-card">
						<h3 className="insights-card-title">确定性规则发现（{report.findings.length}）</h3>
						{report.findings.length === 0 ? (
							<p className="insights-muted">未发现反复失败命令、未加载的僵尸 Skill、高频返工或重复死循环。</p>
						) : (
							<div className="insights-findings-list">
								{report.findings.map((item) => {
									const badge = SEVERITY_BADGE[item.severity];
									return (
										<div key={item.id} className="insights-finding-item">
											<div className="insights-finding-head">
												<div className="insights-finding-title-row">
													<span className={`pill ${badge.className}`}>{badge.label}</span>
													<strong className="insights-finding-title">{item.title}</strong>
													{item.suggestSkillCapture && (
														<span className="tag-chip skill">建议沉淀为 Skill</span>
													)}
												</div>
												{onStartMatterWithPrompt && (
													<button
														type="button"
														className={
															item.suggestSkillCapture
																? "btn-pill-dark btn-xs"
																: "btn-pill-outline btn-xs"
														}
														onClick={() => onStartMatterWithPrompt(buildFindingPrompt(item))}
													>
														{item.suggestSkillCapture ? "去沉淀为 Skill →" : "发起排查 →"}
													</button>
												)}
											</div>
											<p className="insights-finding-detail">{item.detail}</p>
											{item.evidence && item.evidence.length > 0 && (
												<div className="insights-finding-evidence mono-wrap">
													{item.evidence.join(" · ")}
												</div>
											)}
										</div>
									);
								})}
							</div>
						)}
					</div>

					{report.usage.byTool.length > 0 && (
						<div className="ui-card insights-card">
							<h3 className="insights-card-title">高频工具分布</h3>
							<div className="insights-tool-chips">
								{report.usage.byTool.slice(0, 12).map((item) => (
									<span key={item.tool} className="pill">
										<code>{item.tool}</code> · {item.calls}
										{item.errors > 0 ? ` (错 ${item.errors})` : ""}
									</span>
								))}
							</div>
						</div>
					)}

					{report.recentSessions.length > 0 && (
						<div className="ui-card insights-card">
							<h3 className="insights-card-title">最近会话（{report.recentSessions.length}）</h3>
							<div className="insights-session-list">
								{report.recentSessions.slice(0, 10).map((session) => (
									<div key={session.sessionId} className="insights-session-row">
										<div className="insights-session-meta">
											<code>{session.sessionId.slice(0, 8)}</code>
											<span className="insights-session-member">
												{session.memberName ?? session.memberId ?? "未知岗位"}
											</span>
										</div>
										<div className="insights-session-title" title={session.title ?? "无标题"}>
											{session.title ?? "无标题"}
										</div>
										<div className="insights-session-stats">
											<span>
												{session.turns} 轮 · {session.toolCalls} 工具 · ${session.costUsd.toFixed(3)}
											</span>
											{session.matterId && onOpenMatter && (
												<button
													type="button"
													className="btn-inline btn-xs"
													onClick={() => onOpenMatter(session.matterId!)}
												>
													打开事项 →
												</button>
											)}
										</div>
									</div>
								))}
							</div>
						</div>
					)}

					<p className="insights-footnote">{report.privacyNote}</p>
				</div>
			) : null}
		</section>
	);
}
