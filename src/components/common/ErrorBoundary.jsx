import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { getFriendlyError } from '../../utils/errorMessages';

/**
 * ErrorBoundary — catches render-time throws so a single bad component can't
 * white-screen the app. Mounted at the root (main.jsx) and nested around the
 * report body, so a malformed section doesn't take the header and sidebar with it.
 *
 * Visual shape mirrors ErrorScreen.jsx (friendly line + <details> technical
 * disclosure) so a crash doesn't look like a different product.
 *
 * @prop {React.ReactNode} children
 * @prop {string} [title] - heading shown above the friendly message
 * @prop {'page'|'inline'} [variant] - 'page' fills the viewport, 'inline' sits in a pane
 * @prop {Function} [onReset] - extra cleanup to run when the user retries
 */
export default class ErrorBoundary extends React.Component {
    state = { error: null };

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, info) {
        console.error('[ErrorBoundary]', error, info?.componentStack);
    }

    handleReset = () => {
        this.setState({ error: null });
        this.props.onReset?.();
    };

    render() {
        const { error } = this.state;
        if (!error) return this.props.children;

        const { title = 'Something went wrong', variant = 'page' } = this.props;
        const { friendly, technical } = getFriendlyError(error?.message);

        return (
            <div
                className={
                    variant === 'page'
                        ? 'min-h-dvh bg-bah-bg flex items-center justify-center p-4'
                        : 'flex items-center justify-center p-8 h-full'
                }
            >
                <div className="max-w-md w-full bg-bah-panel-strong p-8 rounded-2xl border border-red-500/20 text-center">
                    <div className="w-12 h-12 bg-bah-danger-soft rounded-full flex items-center justify-center mx-auto mb-4 text-bah-danger">
                        <AlertTriangle className="w-6 h-6" />
                    </div>
                    <h3 className="text-bah-strong text-lg font-medium mb-2">{title}</h3>
                    <p className="text-bah text-sm mb-4">{friendly}</p>
                    {technical && (
                        <details className="mb-6 text-left">
                            <summary className="text-bah-muted text-xs cursor-pointer hover:text-bah-muted select-none">
                                Technical details
                            </summary>
                            <p className="text-bah-danger font-mono text-xs mt-2 bg-bah-danger-soft p-3 rounded break-words">
                                {technical}
                            </p>
                        </details>
                    )}
                    <div className="flex gap-4 justify-center">
                        <button
                            onClick={this.handleReset}
                            className="px-4 py-2 bg-bah-panel-soft hover:bg-bah-panel-soft text-bah rounded-lg"
                        >
                            Try again
                        </button>
                        <button
                            onClick={() => window.location.reload()}
                            className="bah-button-primary px-4 py-2 rounded-lg"
                        >
                            Reload
                        </button>
                    </div>
                </div>
            </div>
        );
    }
}
