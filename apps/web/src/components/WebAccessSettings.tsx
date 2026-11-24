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
		<div className="settings-web-access-panel">
			{installedVersion ? (
				<p className="muted-hint">
					Pi 已安装 v{installedVersion}。所有 AI 角色均可使用网页检索，供应商配置在下次运行生效。
				</p>
			) : (
				<div className="actions-row compact">
					<button
						type="button"
						className="btn-pill-outline"
						disabled={!base.available || pending !== null}
						onClick={() => void update("install")}
					>
						{pending === "install" ? "安装中…" : "通过 Pi 安装"}
					</button>
					<span className="muted-hint">
						也可在服务主机运行 <code>pi install npm:pi-web-access</code>，再刷新设置。
					</span>
				</div>
			)}
			{installedVersion && (
				<form
					className="settings-web-access-setup"
					onSubmit={(event) => {
						event.preventDefault();
						if (canSave && !pending) void update("save");
					}}
				>
					<label className="auth-field-label">
						<span>默认搜索供应商（web_search）</span>
						<select
							className="input-field"
							style={{ maxWidth: 460 }}
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
						</select>
					</label>

					<div className="actions-row compact">
						<button className="btn-pill-dark" type="submit" disabled={!canSave || pending !== null}>
							{pending === "save" ? "保存中…" : "保存配置"}
						</button>
						{changed && <span className="muted-hint">默认供应商有未保存修改</span>}
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

			<div className="settings-test-box">
				<div className="settings-test-row">
					<input
						type="text"
						className="input-field"
						style={{ maxWidth: 340 }}
						aria-label="测试搜索关键词"
						placeholder="输入测试搜索关键词…"
						value={testQuery}
						disabled={testing}
						onChange={(e) => setTestQuery(e.target.value)}
					/>
					<button
						type="button"
						className="btn-pill-outline"
						disabled={testing}
						onClick={() => void handleTestSearch()}
					>
						{testing ? "测试中…" : "测试搜索"}
					</button>
				</div>
				{testResult && (
					<div className={testResult.ok ? "muted-hint" : "settings-ext-error"} style={{ marginTop: 8 }}>
						{testResult.ok ? (
							<>
								<div>
									✓ 搜索成功（供应商：{testResult.provider} · 耗时 {testResult.latencyMs}ms · 返回{" "}
									{testResult.resultCount ?? 0} 条）
								</div>
								{testResult.sampleTitles && testResult.sampleTitles.length > 0 && (
									<div style={{ marginTop: 4 }}>示例结果：{testResult.sampleTitles.join(" ｜ ")}</div>
								)}
							</>
						) : (
							`✗ 搜索测试失败（${testResult.provider ?? "未命中供应商"} · ${testResult.latencyMs}ms）：${testResult.error}`
						)}
					</div>
				)}
			</div>

			{error && (
				<p role="alert" className="settings-ext-error">
					{error}
				</p>
			)}
		</div>
	);
}
