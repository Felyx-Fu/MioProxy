import { AlertTriangle, Check, Info, X } from "lucide-react";
import { useEffect } from "react";

export type ToastTone = "success" | "error" | "info";

export type ToastMessage = {
  id: number;
  tone: ToastTone;
  message: string;
};

export function ToastHost({ toasts, onDismiss }: { toasts: ToastMessage[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toast-host" aria-live="polite">
      {toasts.map((toast) => <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />)}
    </div>
  );
}

function Toast({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), 4200);
    return () => window.clearTimeout(timer);
  }, [onDismiss, toast.id]);

  const Icon = toast.tone === "success" ? Check : toast.tone === "error" ? AlertTriangle : Info;
  return (
    <div className={`toast toast-${toast.tone}`}>
      <Icon size={17} />
      <span>{toast.message}</span>
      <button className="toast-close" type="button" onClick={() => onDismiss(toast.id)} aria-label="关闭提示"><X size={14} /></button>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "确认",
  danger = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <div className="dialog-icon"><AlertTriangle size={20} /></div>
        <h2 id="dialog-title">{title}</h2>
        <p>{message}</p>
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
          <button className={danger ? "danger-button" : "primary-button"} type="button" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
