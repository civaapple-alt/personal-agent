import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { fetchModelDefault, fetchModels, type ModelCatalogDto, type ModelSelection } from "../api/models.ts";
import { ModelCatalogChoices } from "./ModelCatalogChoices.tsx";
import { ModelPopover } from "./ModelPopover.tsx";

interface CatalogState {
	catalog: ModelCatalogDto | null;
	error: string | null;
	reload: () => void;
}

const ModelCatalogContext = createContext<CatalogState>({
	catalog: null,
	error: null,
	reload: () => {},
});

export function ModelCatalogProvider({ children }: { children: ReactNode }) {
	const [catalog, setCatalog] = useState<ModelCatalogDto | null>(null);
	const [error, setError] = useState<string | null>(null);
	const request = useRef<AbortController | null>(null);
	const reload = useCallback(() => {
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		void fetchModels(controller.signal).then(
			(result) => {
				if (controller.signal.aborted) return;
				setCatalog(result);
				setError(null);
			},
			(err: unknown) => {
				if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
			},
		);
	}, []);
	useEffect(() => {
		reload();
		return () => request.current?.abort();
	}, [reload]);

	const state = useMemo(() => ({ catalog, error, reload }), [catalog, error, reload]);
	return <ModelCatalogContext value={state}>{children}</ModelCatalogContext>;
}

export function useModelCatalog() {
	return useContext(ModelCatalogContext);
}

function useEffectiveModel(selection?: ModelSelection | null) {
	const { catalog } = useModelCatalog();
	const [resolved, setResolved] = useState<ModelSelection | null>(null);
	const provider = selection?.provider;
	const model = selection?.model;
	const thinkingLevel = selection?.thinkingLevel;
	const matchesPiDefault = catalog?.defaultModel?.provider === provider && catalog?.defaultModel?.model === model;
	useEffect(() => {
		if (!provider || !model || thinkingLevel || matchesPiDefault) return;
		const controller = new AbortController();
		void fetchModelDefault(provider, model, controller.signal).then(
			(result) => {
				if (!controller.signal.aborted) setResolved(result);
			},
			() => {},
		);
		return () => controller.abort();
	}, [provider, model, thinkingLevel, matchesPiDefault]);
	if (!selection || thinkingLevel) return selection;
	if (matchesPiDefault) return catalog?.defaultModel ?? selection;
	return resolved?.provider === provider && resolved?.model === model ? resolved : selection;
}

function modelLabel(model: ModelSelection) {
	return `${model.provider} / ${model.model}${model.thinkingLevel ? ` · ${model.thinkingLevel}` : ""}`;
}

interface ModelPickerProps {
	value: ModelSelection | null;
	onChange: (value: ModelSelection | null) => void;
	inheritLabel: string;
	inheritModel?: ModelSelection | null;
	disabled?: boolean;
}

function inheritedLabel(label: string, inherited?: ModelSelection | null) {
	return inherited ? `${label} · ${modelLabel(inherited)}` : label;
}

export function ModelPicker(props: ModelPickerProps) {
	const { value, inheritLabel, inheritModel, disabled } = props;
	const effective = useEffectiveModel(value ?? inheritModel);
	const label = value ? modelLabel(effective ?? value) : inheritedLabel(inheritLabel, effective ?? inheritModel);
	return (
		<div className="model-choices">
			<span className="identity-field-label">供应商与模型</span>
			<ModelPopover
				label={label}
				panelLabel="供应商与模型"
				accessibleLabel={`供应商与模型 · ${label}`}
				buttonClassName="input-field model-choices-trigger"
				disabled={disabled}
			>
				{() => <ModelPickerPanel {...props} />}
			</ModelPopover>
		</div>
	);
}

function ModelPickerPanel({ value, onChange, inheritLabel, inheritModel, disabled }: ModelPickerProps) {
	const { catalog, error, reload } = useModelCatalog();
	const options = catalog?.models ?? [];
	const selected = value
		? options.find((option) => option.provider === value.provider && option.model === value.model)
		: undefined;
	const levels = selected?.thinkingLevels ?? [];
	const effective = useEffectiveModel(value ?? inheritModel);
	const inherited = inheritModel
		? `${inheritLabel} · ${modelLabel(value ? inheritModel : (effective ?? inheritModel))}`
		: inheritLabel;
	return (
		<div className="model-picker">
			<ModelCatalogChoices
				models={options}
				value={value}
				inheritLabel={inherited}
				disabled={disabled}
				onChange={onChange}
			/>
			{value && (
				<label className="identity-field">
					<span className="identity-field-label">思考等级</span>
					<select
						className="input-field"
						value={value.thinkingLevel ?? ""}
						disabled={disabled || !selected}
						onChange={(event) =>
							onChange({ ...value, thinkingLevel: levels.find((level) => level === event.currentTarget.value) })
						}
					>
						<option value="">
							由 Pi 决定{!value.thinkingLevel && effective?.thinkingLevel ? ` · ${effective.thinkingLevel}` : ""}
						</option>
						{value.thinkingLevel && !levels.includes(value.thinkingLevel) && (
							<option value={value.thinkingLevel}>{value.thinkingLevel}（当前不可用）</option>
						)}
						{levels.map((level) => (
							<option key={level} value={level}>
								{level}
							</option>
						))}
					</select>
				</label>
			)}
			{error && (
				<div className="model-picker-error">
					<output>{error}</output>
					<button type="button" className="btn-pill-outline btn-xs" onClick={reload}>
						重新读取
					</button>
				</div>
			)}
			{catalog && !options.length && <p className="muted-hint">在运行工作台的系统账号下登录 Pi，添加可用模型。</p>}
		</div>
	);
}

export function MatterModelControl({
	label = "主责模型",
	value,
	roleModel,
	leadKnown,
	disabled,
	onSave,
}: {
	label?: "主责模型" | "架构师模型";
	value: ModelSelection | null;
	roleModel: ModelSelection | null;
	leadKnown: boolean;
	disabled: boolean;
	onSave: (value: ModelSelection | null) => void | Promise<void>;
}) {
	const { catalog, reload } = useModelCatalog();
	const [draft, setDraft] = useState<ModelSelection | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inherited = leadKnown ? (roleModel ?? catalog?.platformDefault ?? catalog?.defaultModel) : undefined;
	const effective = useEffectiveModel(value ?? inherited);
	const buttonLabel = `${label} · ${effective ? modelLabel(effective) : "按岗位配置"}`;

	const save = async (close: () => void) => {
		setSaving(true);
		setError(null);
		try {
			await onSave(draft);
			close();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="composer-model-control">
			<ModelPopover
				label={buttonLabel}
				panelLabel={label}
				buttonClassName="btn-pill-outline btn-xs model-choices-trigger"
				align="end"
				disabled={disabled}
				closeDisabled={saving}
				onOpen={() => {
					reload();
					setDraft(value);
					setError(null);
				}}
			>
				{(close) => (
					<>
						<ModelPickerPanel
							value={draft}
							onChange={setDraft}
							inheritLabel="按岗位配置"
							inheritModel={inherited}
							disabled={saving}
						/>
						{error && (
							<p className="muted-hint" role="alert">
								{error}
							</p>
						)}
						<div className="model-popover-actions">
							<button
								type="button"
								className="btn-pill-dark btn-xs"
								disabled={saving || disabled}
								onClick={() => void save(close)}
							>
								{saving ? "保存中…" : "应用"}
							</button>
						</div>
					</>
				)}
			</ModelPopover>
		</div>
	);
}
