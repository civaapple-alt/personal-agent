import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";

export interface ErrorBoundaryProps {
	scope: string;
	children: ReactNode;
	onReset?: () => void;
}

interface ErrorBoundaryState {
	error: Error | null;
}

/**
 * Dependency-free React error boundary that isolates crashes per view or at the workbench root.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	state: ErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error(`[PA ErrorBoundary:${this.props.scope}]`, error, info.componentStack);
	}

	private handleRetry = (): void => {
		this.setState({ error: null });
		this.props.onReset?.();
	};

	render(): ReactNode {
		if (!this.state.error) return this.props.children;
		return (
			<div className="h-full overflow-y-auto px-6 py-10 bg-canvas" role="alert">
				<Card className="max-w-xl mx-auto mt-10" padding="md">
					<h3 className="m-0 mb-2 text-base font-semibold text-ink">当前视图渲染出现异常</h3>
					<p className="m-0 mb-3 text-sm text-ink-secondary">
						模块：<code className="font-mono text-xs">{this.props.scope}</code> —{" "}
						{this.state.error.message || "未知错误"}
					</p>
					<div className="flex items-center gap-2">
						<Button variant="primary" size="sm" onClick={this.handleRetry}>
							重试渲染
						</Button>
						<Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
							刷新页面
						</Button>
					</div>
				</Card>
			</div>
		);
	}
}
