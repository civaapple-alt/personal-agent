import { useState } from "react";
import { updateAdminSettings } from "../api/admin.ts";
import {
	type ManagedEnvStatusDto,
	type RuntimeBaseInfoDto,
	type RuntimeOverviewDto,
	type SystemOneTestResultDto,
	testRuntimeSystemOne,
} from "../api/runtime.ts";
import { EnvCredentialsSettings } from "./EnvCredentialsSettings.tsx";

/** Cohesive System One (TypeSafe / Jev) plugin card: enable/disable toggle, TYPESAFE_API_KEY config, and live connectivity test. */
export function SystemOneSettings({
	base,
	envItems,
	onRefresh,
	onOverviewChange,
	onNotice,
	onError,
}: {
	base: RuntimeBaseInfoDto;
	envItems: ManagedEnvStatusDto[];
	onRefresh: () => Promise<void>;
	onOverviewChange?: (overview: RuntimeOverviewDto) => void;
	onNotice?: (message: string) => void;
	onError?: (message: string) => void;
}) {
	const enabled = Boolean(base.systemOne?.enabled);
	const [toggling, setToggling] = useState(false);
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<SystemOneTestResultDto | null>(null);

	const handleToggle = async (nextEnabled: boolean) => {
		if (toggling) return;
		setToggling(true);
		try {
			await updateAdminSettings({ systemOneEnabled: nextEnabled });
			await onRefresh();
			onNotice?.(
				nextEnabled ? "已启用 System One（Jev）快速决策分类器" : "已停用 System One，自动降级为 Pi 决策与本地规则",
			);
		} catch (err) {
			onError?.(err instanceof Error ? err.message : String(err));
		} finally {
			setToggling(false);
		}
	};

	const handleTest = async () => {
		if (testing) return;
		setTesting(true);
		setTestResult(null);
		try {
			const res = await testRuntimeSystemOne();
			setTestResult(res);
		} catch (err) {
			setTestResult({
				ok: false,
				enabled,
				latencyMs: 0,
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setTesting(false);
		}
	};

	return (
		<article className="ui-card compact settings-ext-card">
			<div className="settings-ext-head">
				<div className="settings-ext-title-row">
					<strong>system-one (TypeSafe / Jev)</strong>
					<span className={`rsi-badge ${enabled ? "rsi-status-verified" : "rsi-status-superseded"}`}>
						{enabled ? "已启用" : "已禁用"}
					</span>
					<span className="pill">快速决策分类器</span>
				</div>
				<span className="settings-ext-path">src/orchestrator/system-one.ts</span>
			</div>
			<p className="muted-hint">
				用于工作台快速意图路由与立项阵型预判；默认禁用，禁用时自动降级为本机 Pi
				决策模型与本地规则，所有业务正常推进。
			</p>

			{envItems.length > 0 && (
				<EnvCredentialsSettings
					embedded
					title="TypeSafe 密钥配置"
					subtitle="保存后写入服务根目录 .env（权限 0600），前端不回显明文；启用开关打开后立即热生效。"
					items={envItems}
					onOverviewChange={onOverviewChange}
					onRefresh={onRefresh}
					onNotice={onNotice}
					onError={onError}
				/>
			)}

			<div className="actions-row compact" style={{ marginTop: 12 }}>
				<button
					type="button"
					className={enabled ? "btn-pill-outline" : "btn-pill-dark"}
					disabled={toggling}
					onClick={() => void handleToggle(!enabled)}
				>
					{toggling ? "切换中…" : enabled ? "停用" : "启用"}
				</button>
				<button type="button" className="btn-pill-outline" disabled={testing} onClick={() => void handleTest()}>
					{testing ? "测试中…" : "测试连通性"}
				</button>
			</div>

			{testResult && (
				<p className={testResult.ok ? "muted-hint" : "settings-ext-error"} style={{ marginTop: 8 }}>
					{testResult.ok
						? `✓ TypeSafe System One 连通正常（耗时 ${testResult.latencyMs}ms${enabled ? "" : "；当前开关处于禁用状态，点「启用」即可生效"}）`
						: `✗ 连通性测试失败（${testResult.latencyMs}ms）：${testResult.error}`}
				</p>
			)}
		</article>
	);
}
