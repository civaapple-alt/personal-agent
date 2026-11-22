import { useState } from "react";
import { type ManagedEnvStatusDto, type RuntimeOverviewDto, updateRuntimeEnvCredentials } from "../api/runtime.ts";

interface EnvCredentialsSettingsProps {
	items: ManagedEnvStatusDto[];
	embedded?: boolean;
	title?: string;
	subtitle?: string;
	onOverviewChange?: (overview: RuntimeOverviewDto) => void;
	onRefresh: () => Promise<void>;
	onNotice?: (message: string) => void;
	onError?: (message: string) => void;
}

const SOURCE_TEXT: Record<ManagedEnvStatusDto["source"], string> = {
	process_env: "已配置 · 环境变量",
	dotenv: "已配置 · .env",
	unset: "未配置",
};

export function EnvCredentialsSettings({
	items,
	embedded = false,
	title = ".env 密钥配置",
	subtitle = "保存后写入服务根目录 .env（权限 0600），前端不回显明文。",
	onOverviewChange,
	onRefresh,
	onNotice,
	onError,
}: EnvCredentialsSettingsProps) {
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [busyKey, setBusyKey] = useState<string | null>(null);

	const submit = async (key: ManagedEnvStatusDto["key"], value: string | null) => {
		setBusyKey(key);
		try {
			const result = await updateRuntimeEnvCredentials({ [key]: value });
			onOverviewChange?.(result.overview);
			if (!onOverviewChange) await onRefresh();
			setDrafts((prev) => ({ ...prev, [key]: "" }));
			onNotice?.(value ? `已将 ${key} 保存到 .env` : `已从 .env 清除 ${key}`);
		} catch (err) {
			onError?.(err instanceof Error ? err.message : String(err));
		} finally {
			setBusyKey(null);
		}
	};

	return (
		<div className={embedded ? "settings-env-embedded" : "ui-card compact settings-env-card"}>
			<div className="settings-env-head">
				<div>
					<strong>{title}</strong>
					<p className="muted-hint">{subtitle}</p>
				</div>
			</div>
			<div className="settings-env-list">
				{items.map((item) => {
					const draft = drafts[item.key] ?? "";
					const isBusy = busyKey === item.key;
					return (
						<div key={item.key} className="settings-env-row">
							<div className="settings-env-meta">
								<div className="settings-env-title-line">
									<code>{item.key}</code>
									<span>{item.label}</span>
									<span
										className={`rsi-badge ${item.configured ? "rsi-status-verified" : "rsi-status-superseded"}`}
									>
										{SOURCE_TEXT[item.source]}
									</span>
								</div>
								<p className="muted-hint">{item.description}</p>
							</div>
							<form
								className="settings-env-form"
								onSubmit={(event) => {
									event.preventDefault();
									const trimmed = draft.trim();
									if (!trimmed || isBusy) return;
									void submit(item.key, trimmed);
								}}
							>
								<input
									type="password"
									className="input-field"
									autoComplete="off"
									spellCheck={false}
									name={`env-${item.key}`}
									aria-label={`输入新的 ${item.key}`}
									placeholder={item.configured ? "输入新密钥以覆盖 .env…" : `输入 ${item.key}…`}
									value={draft}
									disabled={isBusy}
									onChange={(event) =>
										setDrafts((prev) => ({
											...prev,
											[item.key]: event.target.value,
										}))
									}
								/>
								<button type="submit" className="btn-pill-dark btn-xs" disabled={!draft.trim() || isBusy}>
									{isBusy ? "保存中…" : "保存"}
								</button>
								{item.source === "dotenv" && (
									<button
										type="button"
										className="btn-pill-outline btn-xs"
										disabled={isBusy}
										onClick={() => void submit(item.key, null)}
									>
										清除
									</button>
								)}
							</form>
						</div>
					);
				})}
			</div>
		</div>
	);
}
