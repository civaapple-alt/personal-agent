import type { SessionInsightFinding, SessionInsightsReport } from "@pa/contracts/session-insights";
import { useCallback, useEffect, useState } from "react";
import { fetchRuntimeInsights } from "../api/runtime.ts";
import { Badge, type BadgeTone, Banner, Button, Card, CardBody, CardHeader, EmptyState } from "../primitives/index.ts";

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

const SEVERITY_BADGE: Record<"error" | "warn" | "info", { label: string; tone: BadgeTone }> = {
	error: { label: "异常", tone: "danger" },
	warn: { label: "提醒", tone: "warn" },
	info: { label: "洞察", tone: "accent" },
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
		<section className="flex flex-col gap-3">
			<div className="flex items-start justify-between gap-3 flex-wrap">
				<div className="flex flex-col min-w-0">
					<h2 className="m-0 text-lg font-semibold leading-snug text-ink">运行洞察（Session Insights）</h2>
					<p className="mt-0.5 mb-0 text-xs leading-normal text-ink-muted">
						仅在本机只读分析当前账号有权访问的 Pi 会话记录，零模型调用、零网络请求
						{lastScanMs !== null ? ` · 本次扫描耗时 ${lastScanMs}ms` : ""}
					</p>
				</div>
				<div className="flex items-center gap-2 flex-wrap">
					{confirmingRescan ? (
						<div className="inline-flex items-center gap-2 flex-wrap px-2.5 py-1 border border-line rounded-md bg-sidebar">
							<span className="text-xs text-ink-secondary">
								确认重新扫描最近 40 个本机会话？（零模型调用，约 &lt;100ms）
							</span>
							<Button variant="primary" size="xs" onClick={() => void load()} disabled={loading}>
								确认扫描
							</Button>
							<Button variant="inline" size="xs" onClick={() => setConfirmingRescan(false)} disabled={loading}>
								取消
							</Button>
						</div>
					) : (
						<Button variant="secondary" size="xs" onClick={() => setConfirmingRescan(true)} disabled={loading}>
							{loading ? "分析中…" : "重新扫描"}
						</Button>
					)}
				</div>
			</div>

			{error && <Banner tone="danger">{error}</Banner>}

			{!report && loading ? (
				<Card padding="md" className="text-xs text-ink-secondary">
					正在扫描本地 Pi 会话文件…
				</Card>
			) : report ? (
				<div className="flex flex-col gap-3">
					<div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
						<Card padding="sm" className="bg-stage flex flex-col gap-1">
							<span className="text-xs font-medium text-ink-muted">分析会话</span>
							<strong className="text-xl leading-tight font-bold text-ink tabular-nums">
								{report.usage.sessions}
							</strong>
							<span className="text-micro text-ink-secondary">{report.usage.turns} 轮对话</span>
						</Card>
						<Card padding="sm" className="bg-stage flex flex-col gap-1">
							<span className="text-xs font-medium text-ink-muted">工具调用</span>
							<strong className="text-xl leading-tight font-bold text-ink tabular-nums">
								{report.usage.toolCalls}
							</strong>
							<span className="text-micro text-ink-secondary">失败 {report.usage.toolErrors} 次</span>
						</Card>
						<Card padding="sm" className="bg-stage flex flex-col gap-1">
							<span className="text-xs font-medium text-ink-muted">Token 用量</span>
							<strong className="text-xl leading-tight font-bold text-ink tabular-nums">
								{formatCompactNumber(report.usage.inputTokens + report.usage.outputTokens)}
							</strong>
							<span className="text-micro text-ink-secondary">
								缓存命中 {formatCompactNumber(report.usage.cacheReadTokens)}
							</span>
						</Card>
						<Card padding="sm" className="bg-stage flex flex-col gap-1">
							<span className="text-xs font-medium text-ink-muted">Pi 记录成本</span>
							<strong className="text-xl leading-tight font-bold text-ink tabular-nums">
								${report.usage.totalCostUsd.toFixed(2)}
							</strong>
							<span className="text-micro text-ink-secondary">{report.usage.byModel.length} 个模型</span>
						</Card>
					</div>

					<Card padding="md">
						<CardHeader
							title={<span className="text-sm font-semibold">确定性规则发现（{report.findings.length}）</span>}
							className="mb-2.5"
						/>
						<CardBody>
							{report.findings.length === 0 ? (
								<EmptyState
									compact
									title="暂无异常发现"
									description="未发现反复失败命令、未加载的僵尸 Skill、高频返工或重复死循环。"
								/>
							) : (
								<div className="flex flex-col gap-2">
									{report.findings.map((item) => {
										const badge = SEVERITY_BADGE[item.severity];
										return (
											<div
												key={item.id}
												className="p-2.5 border border-line rounded-md bg-sidebar flex flex-col gap-1.5"
											>
												<div className="flex items-center justify-between gap-2.5 flex-wrap">
													<div className="flex items-center gap-1.5 flex-wrap min-w-0">
														<Badge tone={badge.tone} size="xs">
															{badge.label}
														</Badge>
														<strong className="text-sm font-semibold text-ink">{item.title}</strong>
														{item.suggestSkillCapture && (
															<Badge tone="accent" size="xs">
																建议沉淀为 Skill
															</Badge>
														)}
													</div>
													{onStartMatterWithPrompt && (
														<Button
															variant={item.suggestSkillCapture ? "primary" : "secondary"}
															size="xs"
															onClick={() => onStartMatterWithPrompt(buildFindingPrompt(item))}
														>
															{item.suggestSkillCapture ? "去沉淀为 Skill →" : "发起排查 →"}
														</Button>
													)}
												</div>
												<p className="m-0 text-xs text-ink-secondary leading-normal">{item.detail}</p>
												{item.evidence && item.evidence.length > 0 && (
													<div className="text-micro font-mono text-ink-muted leading-normal break-words">
														{item.evidence.join(" · ")}
													</div>
												)}
											</div>
										);
									})}
								</div>
							)}
						</CardBody>
					</Card>

					{report.usage.byTool.length > 0 && (
						<Card padding="md">
							<CardHeader
								title={<span className="text-sm font-semibold">高频工具分布</span>}
								className="mb-2.5"
							/>
							<CardBody className="flex flex-wrap gap-1.5">
								{report.usage.byTool.slice(0, 12).map((item) => (
									<Badge key={item.tool} tone="neutral" size="sm">
										<code className="font-mono">{item.tool}</code> · {item.calls}
										{item.errors > 0 ? ` (错 ${item.errors})` : ""}
									</Badge>
								))}
							</CardBody>
						</Card>
					)}

					{report.recentSessions.length > 0 && (
						<Card padding="md">
							<CardHeader
								title={
									<span className="text-sm font-semibold">最近会话（{report.recentSessions.length}）</span>
								}
								className="mb-2"
							/>
							<CardBody className="flex flex-col">
								{report.recentSessions.slice(0, 10).map((session, idx, arr) => (
									<div
										key={session.sessionId}
										className={`grid grid-cols-1 md:grid-cols-[minmax(150px,auto)_minmax(0,1fr)_auto] items-center gap-1 md:gap-3 py-2 text-xs ${
											idx < arr.length - 1 ? "border-b border-dashed border-line" : ""
										}`}
									>
										<div className="flex items-center gap-1.5 min-w-0 whitespace-nowrap">
											<code className="font-mono text-ink">{session.sessionId.slice(0, 8)}</code>
											<span className="text-ink-secondary font-medium">
												{session.memberName ?? session.memberId ?? "未知岗位"}
											</span>
										</div>
										<div className="min-w-0 text-ink truncate" title={session.title ?? "无标题"}>
											{session.title ?? "无标题"}
										</div>
										<div className="flex items-center gap-2 text-ink-muted whitespace-nowrap tabular-nums">
											<span>
												{session.turns} 轮 · {session.toolCalls} 工具 · ${session.costUsd.toFixed(3)}
											</span>
											{session.matterId && onOpenMatter && (
												<Button variant="inline" size="xs" onClick={() => onOpenMatter(session.matterId!)}>
													打开事项 →
												</Button>
											)}
										</div>
									</div>
								))}
							</CardBody>
						</Card>
					)}

					<p className="m-0 text-micro text-ink-muted">{report.privacyNote}</p>
				</div>
			) : null}
		</section>
	);
}
