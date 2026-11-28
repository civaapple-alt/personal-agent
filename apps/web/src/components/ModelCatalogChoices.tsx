import { useEffect, useId, useRef, useState } from "react";
import type { ModelCatalogDto, ModelSelection } from "../api/models.ts";
import { Input, Select } from "../primitives/index.ts";
import { cn } from "../utils/cn.ts";

interface ModelCatalogChoicesProps {
	models: ModelCatalogDto["models"];
	value: ModelSelection | null;
	inheritLabel: string;
	disabled?: boolean;
	onChange: (value: ModelSelection | null) => void;
}

const OPTION_BASE_CLASSES =
	"flex flex-wrap items-baseline justify-between gap-x-2 w-full min-h-8 px-2 py-1.5 rounded-sm border text-left text-sm transition-colors cursor-pointer disabled:opacity-45 disabled:pointer-events-none [overflow-wrap:anywhere]";

export function ModelCatalogChoices({ models, value, inheritLabel, disabled, onChange }: ModelCatalogChoicesProps) {
	const panelId = useId();
	const [provider, setProvider] = useState(() =>
		value && models.some((option) => option.provider === value.provider) ? value.provider : "",
	);
	const [query, setQuery] = useState("");
	const querySyncedFromSelection = useRef(false);
	const search = useRef<HTMLInputElement>(null);
	const firstResult = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		search.current?.focus({ preventScroll: true });
	}, []);

	const providers = [...new Set(models.map((option) => option.provider))];
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const results = models.filter((option) => {
		if (provider && option.provider !== provider) return false;
		const label = `${option.name} ${option.model} ${option.provider}`.toLowerCase();
		return terms.every((term) => label.includes(term));
	});

	return (
		<div className="grid gap-2 min-w-0">
			<div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
				<div className="flex flex-col gap-1 min-w-0">
					<label className="text-xs font-medium text-ink-secondary" htmlFor={`${panelId}-provider`}>
						供应商
					</label>
					<Select
						id={`${panelId}-provider`}
						size="sm"
						value={provider}
						disabled={disabled}
						onChange={(event) => {
							setProvider(event.currentTarget.value);
							if (querySyncedFromSelection.current) {
								querySyncedFromSelection.current = false;
								setQuery("");
							}
						}}
					>
						<option value="">全部供应商</option>
						{providers.map((option) => (
							<option key={option} value={option}>
								{option}
							</option>
						))}
					</Select>
				</div>
				<div className="flex flex-col gap-1 min-w-0">
					<label className="text-xs font-medium text-ink-secondary" htmlFor={`${panelId}-search`}>
						搜索模型
					</label>
					<Input
						ref={search}
						id={`${panelId}-search`}
						size="sm"
						type="search"
						name="model-search"
						autoComplete="off"
						spellCheck={false}
						placeholder="模型名称或 ID…"
						value={query}
						disabled={disabled}
						onChange={(event) => {
							querySyncedFromSelection.current = false;
							setQuery(event.currentTarget.value);
						}}
						onKeyDown={(event) => {
							if (event.nativeEvent.isComposing) return;
							if (event.key === "Enter") {
								event.preventDefault();
								if (results.length === 1) firstResult.current?.click();
							}
							if (event.key === "ArrowDown" && firstResult.current) {
								event.preventDefault();
								firstResult.current.focus();
							}
						}}
					/>
				</div>
			</div>
			<button
				type="button"
				className={cn(
					OPTION_BASE_CLASSES,
					!value
						? "bg-subtle border-line text-ink font-medium"
						: "bg-transparent border-line text-ink hover:bg-hover/60",
				)}
				aria-pressed={!value}
				disabled={disabled}
				onClick={() => {
					querySyncedFromSelection.current = false;
					setProvider("");
					setQuery("");
					onChange(null);
				}}
			>
				{inheritLabel}
			</button>
			{results.length > 0 ? (
				<ul
					className="grid gap-0.5 max-h-[min(34vh,232px)] overflow-y-auto overscroll-contain list-none m-0 p-0.5"
					aria-label="可选模型"
				>
					{results.map((option, index) => {
						const isSelected = value?.provider === option.provider && value.model === option.model;
						return (
							<li key={JSON.stringify([option.provider, option.model])}>
								<button
									ref={index === 0 ? firstResult : undefined}
									type="button"
									className={cn(
										OPTION_BASE_CLASSES,
										isSelected
											? "bg-subtle border-line text-ink font-medium"
											: "bg-transparent border-transparent text-ink hover:bg-hover/60 hover:border-line",
									)}
									aria-pressed={isSelected}
									disabled={disabled}
									onClick={() => {
										querySyncedFromSelection.current = true;
										setProvider(option.provider);
										setQuery(option.name);
										onChange({ provider: option.provider, model: option.model });
									}}
								>
									<span>{option.name}</span>
									<small className="text-xs text-ink-secondary">{option.provider}</small>
								</button>
							</li>
						);
					})}
				</ul>
			) : (
				<output className="p-2 text-xs text-ink-secondary">没有符合筛选条件的模型</output>
			)}
		</div>
	);
}
