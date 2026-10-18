import React, { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal — the one dialog primitive.
 *
 * The three ad-hoc modals in this app were bare divs: no role, no focus trap,
 * no Escape, no focus restore, so keyboard and screen-reader users could tab
 * straight out of a "dialog" into the page behind it.
 *
 * @prop {boolean} open
 * @prop {Function} onClose - called on Escape, backdrop click, and close button
 * @prop {string} title - the accessible name (aria-labelledby)
 * @prop {string} [description] - optional supporting copy (aria-describedby)
 * @prop {React.ReactNode} children - body + actions
 * @prop {'sm'|'md'} [size]
 */
export default function Modal({ open, onClose, title, description, children, size = 'sm' }) {
  const panelRef = useRef(null);
  const restoreRef = useRef(null);
  const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2, 9)}`).current;
  const descId = useRef(`modal-desc-${Math.random().toString(36).slice(2, 9)}`).current;

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
        return;
      }
      if (e.key !== 'Tab') return;

      const nodes = panelRef.current?.querySelectorAll(FOCUSABLE);
      if (!nodes?.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];

      // Cycle focus inside the panel rather than escaping to the page behind.
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  useEffect(() => {
    if (!open) return;

    restoreRef.current = document.activeElement;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    // Focus the first control so keyboard users land inside the dialog.
    const t = setTimeout(() => {
      const nodes = panelRef.current?.querySelectorAll(FOCUSABLE);
      (nodes?.[0] || panelRef.current)?.focus();
    }, 0);

    return () => {
      clearTimeout(t);
      document.body.style.overflow = overflow;
      // Return focus to whatever opened the dialog.
      if (restoreRef.current instanceof HTMLElement) restoreRef.current.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-fade-in"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`w-full ${size === 'md' ? 'max-w-lg' : 'max-w-sm'} bah-panel-strong p-6 shadow-clay-lg animate-scale-in outline-none`}
      >
        <h3 id={titleId} className="text-lg font-display font-semibold text-bah-strong mb-2">
          {title}
        </h3>
        {description && (
          <p id={descId} className="text-sm text-bah-muted mb-5 leading-relaxed">
            {description}
          </p>
        )}
        {children}
      </div>
    </div>,
    document.body
  );
}

/**
 * ConfirmDialog — replaces window.confirm(), whose OK/Cancel labels could not
 * describe the actual choice. The readiness gate in particular shipped as
 * "(OK = run anyway, Cancel = go back and edit)", inverting the convention.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  bullets = [],
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
  variant = 'primary'
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} description={description}>
      {bullets.length > 0 && (
        <ul className="mb-5 space-y-1.5">
          {bullets.map((b, i) => (
            <li key={i} className="text-xs text-bah-muted flex gap-2">
              <span className="text-bah-warning shrink-0" aria-hidden="true">•</span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="bah-button-secondary px-4 py-2 text-sm">
          {cancelLabel}
        </button>
        <button
          onClick={onConfirm}
          className={
            variant === 'danger'
              ? 'px-4 py-2 text-sm rounded-clay font-medium bg-bah-danger-soft text-bah-danger border border-red-500/30 hover:brightness-105 transition-all'
              : 'bah-button-primary px-4 py-2 text-sm'
          }
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
