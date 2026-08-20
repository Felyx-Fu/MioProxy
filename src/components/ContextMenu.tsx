import { ReactNode, useEffect, useRef } from "react";

export type ContextMenuAction = {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

export function ContextMenu({ x, y, actions, onClose }: { x: number; y: number; actions: ContextMenuAction[]; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const left = Math.min(x, window.innerWidth - 190);
  const top = Math.min(y, window.innerHeight - actions.length * 32 - 12);

  useEffect(() => {
    const close = () => onClose();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", keydown);
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", keydown);
    };
  }, [onClose]);

  return (
    <div ref={menuRef} className="context-menu" role="menu" style={{ left, top }} onPointerDown={(event) => event.stopPropagation()}>
      {actions.map((action) => <button key={action.label} type="button" role="menuitem" className={action.danger ? "danger" : ""} disabled={action.disabled} onClick={() => { action.onSelect(); onClose(); }}>{action.icon}{action.label}</button>)}
    </div>
  );
}
