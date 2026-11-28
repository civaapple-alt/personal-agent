import { useState } from "react";
import {
	configureRuntimeWebAccess,
	installRuntimeWebAccess,
	type ManagedEnvStatusDto,
	type RuntimeBaseInfoDto,
	type RuntimeOverviewDto,
	testRuntimeWebAccess,
	type WebAccessTestResultDto,
} from "../api/runtime.ts";
import { Banner, Button, FieldGroup, Input, Select } from "../primitives/index.ts";
import { EnvCredentialsSettings } from "./EnvCredentialsSettings.tsx";

export function WebAccessSettings({
	base,
	envItems = [],
	onRefresh,
	onOverviewChange,
	onNotice,
	onError,
}: {
	base: RuntimeBaseInfoDto;
	envItems?: ManagedEnvStatusDto[];
	onRefresh: () => Promise<void>;
	onOverviewChange?: (overview: RuntimeOverviewDto) => void;
	onNotice?: (message: string) => void;
	onError?: (message: string) => void;
}) {
	const { installedVersion, provider: savedProvider = "auto", effectiveProvider = null } = base.webAccess;
	const [providerDraft, setProviderDraft] = useState<"auto" | "deepseek" | "exa" | "kimi" | null>(null);
	const [pending, setPending] = useState<"install" | "save" | null>(null);
	const [testQuery, setTestQuery] = useState("DeepSeek Search API");
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<WebAccessTestResultDto | null>(null);
	const [error, setError] = useState<string | null>(null);
	const activeProvider = providerDraft ?? savedProvider;
	const changed = activeProvider !== savedProvider;
	const canSave = changed && Boolean(installedVersion);

	async function update(action: "install" | "save") {
		setPending(action);
		setError(null);
		try {
			const { overview } =
				action === "install" ? await installRuntimeWebAccess() : await configureRuntimeWebAccess(activeProvider);
			if (onOverviewChange) onOverviewChange(overview);
			else await onRefresh();
			setProviderDraft(null);
			onNotice?.(action === "install" ? "pi-web-access 已安装，角色下次运行时可使用" : "网页检索配置已保存");
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			onError?.(message);
		} finally {
			setPending(null);
		}
	}

	async function handleTestSearch() {
		if (testing) return;
		setTesting(true);
		setTestResult(null);
		try {
			const result = await testRuntimeWebAccess({
				provider: activeProvider,
				query: testQuery.trim() || "DeepSeek Search API",
			});
			setTestResult(result);
		} catch (cause) {
			setTestResult({
				ok: false,
				provider: activeProvider,
				latencyMs: 0,
				error: cause instanceof Error ? cause.message : String(cause),
			});
		} finally {
			setTesting(false);
		}
	}

	return (
		<div className="mt-1 pt-2.5 border-t border-dashed border-line flex flex-col gap-2 min-w-0">
			{installedVersion ? (
				<p className="m-0 text-xs text-ink-muted leading-normal">
					Pi 已安装 v{installedVersion}。所有 AI 角色均可使用网页检索，供应商配置在下次运行生效。
				</p>
			) : (
				<div className="flex items-center gap-2 flex-wrap">
					<Button
						variant="secondary"
						size="sm"
						disabled={!base.available || pending !== null}
						onClick={() => void update("install")}
					>
						{pending === "install" ? "安装中…" : "通过 Pi 安装"}
					</Button>
					<span className="text-xs text-ink-muted">
						也可在服务主机运行{" "}
						<code className="font-mono text-xs bg-subtle px-1 py-0.5 rounded-xs">
							pi install npm:pi-web-access
						</code>
						，再刷新设置。
					</span>
				</div>
			)}
			{installedVersion && (
				<form
					className="flex flex-col gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (canSave && !pending) void update("save");
					}}
				>
					<FieldGroup label="默认搜索供应商（web_search）" htmlFor="web-access-provider">
						<Select
							id="web-access-provider"
							size="sm"
							className="max-w-[460px]"
							disabled={pending !== null}
							value={activeProvider}
							onChange={(event) => setProviderDraft(event.target.value as "auto" | "deepseek" | "exa" | "kimi")}
						>
							<option value="auto">
								自动选择（按 Exa → DeepSeek → Kimi 优先级
								{effectiveProvider ? `，当前命中：${effectiveProvider}` : "，当前交由 Pi 默认"}）
							</option>
							<option value="deepseek">DeepSeek Search（需配置 DEEPSEEK_API_KEY）</option>
							<option value="exa">Exa Search（需配置 EXA_API_KEY）</option>
							<option value="kimi">Moonshot / Kimi（需配置 MOONSHOT_API_KEY 或 Pi /login kimi-coding）</option>
						</Select>
					</FieldGroup>

					<div className="flex items-center gap-2 flex-wrap">
						<Button variant="primary" size="sm" type="submit" disabled={!canSave || pending !== null}>
							{pending === "save" ? "保存中…" : "保存配置"}
						</Button>
						{changed && <span className="text-xs text-ink-muted">默认供应商有未保存修改</span>}
					</div>
				</form>
			)}

			{envItems.length > 0 && (
				<EnvCredentialsSettings
					embedded
					title="检索供应商密钥（.env）"
					subtitle="保存后写入服务根目录 .env（权限 0600），前端不回显明文，注入使用 pi-web-access 的岗位进程。"
					items={envItems}
					onOverviewChange={onOverviewChange}
					onRefresh={onRefresh}
					onNotice={onNotice}
					onError={onError}
				/>
			)}

			<div className="mt-2 pt-3 border-t border-dashed border-line flex flex-col gap-2">
				<div className="flex items-center gap-2 flex-wrap">
					<Input
						type="text"
						size="sm"
						className="max-w-[340px]"
						aria-label="测试搜索关键词"
						placeholder="输入测试搜索关键词…"
						value={testQuery}
						disabled={testing}
						onChange={(e) => setTestQuery(e.target.value)}
					/>
					<Button variant="secondary" size="sm" disabled={testing} onClick={() => void handleTestSearch()}>
						{testing ? "测试中…" : "测试搜索"}
					</Button>
				</div>
				{testResult && (
					<div className={testResult.ok ? "text-xs text-ink-muted" : "text-xs text-danger-text"}>
						{testResult.ok ? (
							<>
								<div>
									✓ 搜索成功（供应商：{testResult.provider} · 耗时 {testResult.latencyMs}ms · 返回{" "}
									{testResult.resultCount ?? 0} 条）
								</div>
								{testResult.sampleTitles && testResult.sampleTitles.length > 0 && (
									<div className="mt-1">示例结果：{testResult.sampleTitles.join(" ｜ ")}</div>
								)}
							</>
						) : (
							`✗ 搜索测试失败（${testResult.provider ?? "未命中供应商"} · ${testResult.latencyMs}ms）：${testResult.error}`
						)}
					</div>
				)}
			</div>

			{error && <Banner tone="danger">{error}</Banner>}
		</div>
	);
}
