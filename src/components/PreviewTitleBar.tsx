import { Minus, Square, X } from "lucide-react";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __MIOPROXY_VISUAL_PREVIEW__?: boolean;
  }
}

/** Browser-only representation of the native Windows caption used by visual QA. */
export function PreviewTitleBar() {
  if (window.__TAURI_INTERNALS__ && !window.__MIOPROXY_VISUAL_PREVIEW__) return null;

  return (
    <div className="preview-titlebar" aria-label="MioProxy preview window caption">
      <span className="preview-title">MioProxy</span>
      <div className="preview-window-controls" aria-hidden="true">
        <span><Minus size={13} /></span>
        <span><Square size={11} /></span>
        <span><X size={13} /></span>
      </div>
    </div>
  );
}
