import { useState } from "react";
import { type ManagedEnvStatusDto, type RuntimeOverviewDto, updateRuntimeEnvCredentials } from "../api/runtime.ts";
import { Badge, Button, Card, Input } from "../primitives/index.ts";

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

	const content = (
		<>
			<div className="flex flex-col gap-0.5">
				<strong className="text-sm font-semibold text-ink">{title}</strong>
				<p className="m-0 text-xs text-ink-muted leading-normal">{subtitle}</p>
			</div>
			<div className="flex flex-col gap-2.5">
				{items.map((item) => {
					const draft = drafts[item.key] ?? "";
					const isBusy = busyKey === item.key;
					return (
						<div
							key={item.key}
							className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 pt-2.5 border-t border-dashed border-line"
						>
							<div className="flex-1 min-w-[260px]">
								<div className="flex flex-wrap items-center gap-2 text-xs text-ink">
									<code className="font-mono text-xs bg-subtle px-1.5 py-0.5 rounded-xs break-words">
										{item.key}
									</code>
									<span>{item.label}</span>
									<Badge tone={item.configured ? "success" : "neutral"} dot>
										{SOURCE_TEXT[item.source]}
									</Badge>
								</div>
								<p className="mt-1 mb-0 text-xs text-ink-muted leading-normal">{item.description}</p>
							</div>
							<form
								className="flex items-center gap-2 flex-1 min-w-[260px] max-w-[420px]"
								onSubmit={(event) => {
									event.preventDefault();
									const trimmed = draft.trim();
									if (!trimmed || isBusy) return;
									void submit(item.key, trimmed);
								}}
							>
								<Input
									type="password"
									size="sm"
									className="flex-1"
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
								<Button type="submit" variant="primary" size="xs" disabled={!draft.trim() || isBusy}>
									{isBusy ? "保存中…" : "保存"}
								</Button>
								{item.source === "dotenv" && (
									<Button
										variant="secondary"
										size="xs"
										disabled={isBusy}
										onClick={() => void submit(item.key, null)}
									>
										清除
									</Button>
								)}
							</form>
						</div>
					);
				})}
			</div>
		</>
	);

	if (embedded) {
		return (
			<div className="mt-3 pt-3 border-t border-dashed border-line flex flex-col gap-2.5 min-w-0">{content}</div>
		);
	}

	return (
		<Card padding="sm" className="flex flex-col gap-3 mb-3">
			{content}
		</Card>
	);
}
