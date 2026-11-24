import { Component, type ErrorInfo, type ReactNode } from "react";

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
			<div className="subpage-scroll" role="alert">
				<div className="ui-card" style={{ maxWidth: 560, margin: "40px auto", padding: 20 }}>
					<h3 style={{ margin: "0 0 8px" }}>当前视图渲染出现异常</h3>
					<p style={{ margin: "0 0 12px", opacity: 0.85, fontSize: 13 }}>
						模块：<code>{this.props.scope}</code> — {this.state.error.message || "未知错误"}
					</p>
					<div style={{ display: "flex", gap: 8 }}>
						<button type="button" className="btn-pill-primary" onClick={this.handleRetry}>
							重试渲染
						</button>
						<button type="button" className="btn-pill-ghost" onClick={() => window.location.reload()}>
							刷新页面
						</button>
					</div>
				</div>
			</div>
		);
	}
}
