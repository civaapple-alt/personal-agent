import { useEffect, useId, useRef, useState } from "react";
import type { ModelCatalogDto, ModelSelection } from "../api/models.ts";

interface ModelCatalogChoicesProps {
	models: ModelCatalogDto["models"];
	value: ModelSelection | null;
	inheritLabel: string;
	disabled?: boolean;
	onChange: (value: ModelSelection | null) => void;
}

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
		<div className="model-choices-panel">
			<div className="model-choices-filters">
				<div className="identity-field">
					<label className="identity-field-label" htmlFor={`${panelId}-provider`}>
						供应商
					</label>
					<select
						id={`${panelId}-provider`}
						className="input-field"
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
					</select>
				</div>
				<div className="identity-field">
					<label className="identity-field-label" htmlFor={`${panelId}-search`}>
						搜索模型
					</label>
					<input
						ref={search}
						id={`${panelId}-search`}
						className="input-field"
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
				className="model-choices-option model-choices-inherit"
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
				<ul className="model-choices-results" aria-label="可选模型">
					{results.map((option, index) => (
						<li key={JSON.stringify([option.provider, option.model])}>
							<button
								ref={index === 0 ? firstResult : undefined}
								type="button"
								className="model-choices-option"
								aria-pressed={value?.provider === option.provider && value.model === option.model}
								disabled={disabled}
								onClick={() => {
									querySyncedFromSelection.current = true;
									setProvider(option.provider);
									setQuery(option.name);
									onChange({ provider: option.provider, model: option.model });
								}}
							>
								<span>{option.name}</span>
								<small>{option.provider}</small>
							</button>
						</li>
					))}
				</ul>
			) : (
				<output className="model-choices-empty">没有符合筛选条件的模型</output>
			)}
		</div>
	);
}
