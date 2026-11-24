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

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await fetchRuntimeInsights({ limit: 40 });
			setReport(data);
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
		<section className="settings-section">
			<div className="pane-header-row">
				<div className="pane-header">
					<h2>运行洞察（Session Insights）</h2>
					<p>仅在本机只读分析当前账号有权访问的 Pi 会话记录，零模型调用、零网络请求</p>
				</div>
				<button type="button" className="btn-pill-outline" onClick={() => void load()} disabled={loading}>
					{loading ? "分析中…" : "重新扫描"}
				</button>
			</div>

			{error && <div className="ui-banner error">{error}</div>}

			{!report && loading ? (
				<div className="ui-card">正在扫描本地 Pi 会话文件…</div>
			) : report ? (
				<div className="stack-gap">
					<div className="stats-grid">
						<div className="ui-card compact">
							<div className="muted-sm">分析会话</div>
							<strong className="stat-val">{report.usage.sessions}</strong>
							<div className="muted-xs">{report.usage.turns} 轮对话</div>
						</div>
						<div className="ui-card compact">
							<div className="muted-sm">工具调用</div>
							<strong className="stat-val">{report.usage.toolCalls}</strong>
							<div className="muted-xs">失败 {report.usage.toolErrors} 次</div>
						</div>
						<div className="ui-card compact">
							<div className="muted-sm">Token 用量</div>
							<strong className="stat-val">
								{formatCompactNumber(report.usage.inputTokens + report.usage.outputTokens)}
							</strong>
							<div className="muted-xs">缓存命中 {formatCompactNumber(report.usage.cacheReadTokens)}</div>
						</div>
						<div className="ui-card compact">
							<div className="muted-sm">Pi 记录成本</div>
							<strong className="stat-val">${report.usage.totalCostUsd.toFixed(2)}</strong>
							<div className="muted-xs">{report.usage.byModel.length} 个模型</div>
						</div>
					</div>

					<div className="ui-card">
						<h3 style={{ marginTop: 0 }}>确定性规则发现（{report.findings.length}）</h3>
						{report.findings.length === 0 ? (
							<p className="muted-sm">未发现反复失败命令、未加载的僵尸 Skill、高频返工或重复死循环。</p>
						) : (
							<div className="stack-gap-sm">
								{report.findings.map((item) => {
									const badge = SEVERITY_BADGE[item.severity];
									return (
										<div key={item.id} className="ui-card compact">
											<div className="banner-row">
												<div className="row-wrap-gap">
													<span className={`pill ${badge.className}`}>{badge.label}</span>
													<strong>{item.title}</strong>
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
											<p className="muted-sm" style={{ margin: "6px 0 0" }}>
												{item.detail}
											</p>
											{item.evidence && item.evidence.length > 0 && (
												<div className="muted-xs mono-wrap" style={{ marginTop: "4px" }}>
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
						<div className="ui-card">
							<h3 style={{ marginTop: 0 }}>高频工具分布</h3>
							<div className="row-wrap-gap">
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
						<div className="ui-card">
							<h3 style={{ marginTop: 0 }}>最近会话（{report.recentSessions.length}）</h3>
							<div className="stack-gap-sm">
								{report.recentSessions.slice(0, 10).map((session) => (
									<div key={session.sessionId} className="settings-config-row">
										<div className="settings-config-keycol">
											<code>{session.sessionId.slice(0, 8)}</code>
											<span>{session.memberName ?? session.memberId ?? "未知岗位"}</span>
										</div>
										<div className="settings-config-valcol">
											<span className="mono-wrap">{session.title ?? "无标题"}</span>
											<div className="row-wrap-gap" style={{ alignItems: "center" }}>
												<span className="muted-xs">
													{session.turns} 轮 · {session.toolCalls} 工具 · ${session.costUsd.toFixed(3)}
												</span>
												{session.matterId && onOpenMatter && (
													<button
														type="button"
														className="btn-inline"
														onClick={() => onOpenMatter(session.matterId!)}
													>
														打开事项 →
													</button>
												)}
											</div>
										</div>
									</div>
								))}
							</div>
						</div>
					)}

					<p className="muted-xs">{report.privacyNote}</p>
				</div>
			) : null}
		</section>
	);
}
