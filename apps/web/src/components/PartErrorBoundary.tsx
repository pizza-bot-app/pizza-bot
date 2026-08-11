import { Component, type ErrorInfo, type ReactNode } from "react";

// Isolate malformed message parts so one renderer cannot unmount the transcript.
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class PartErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[chat] failed to render message part:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="part-render-error" role="alert">
          ⚠️ This part couldn’t be displayed.
        </div>
      );
    }
    return this.props.children;
  }
}
