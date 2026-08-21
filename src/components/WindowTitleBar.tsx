import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useI18n } from "../i18n/I18nProvider";

type MaximizeButtonRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function isWindowControl(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("button"));
}

export function WindowTitleBar() {
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const { t } = useI18n();
  const maximizeButton = useRef<HTMLButtonElement>(null);
  const [maximized, setMaximized] = useState(false);

  const syncMaximized = useCallback(async () => {
    try {
      setMaximized(await appWindow.isMaximized());
    } catch {
      // Browser preview and early native startup can temporarily lack window state.
    }
  }, [appWindow]);

  const publishMaximizeButtonRect = useCallback(() => {
    const element = maximizeButton.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    const rect: MaximizeButtonRect = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
    void invoke("window_set_maximize_button_rect", { rect }).catch(() => undefined);
  }, []);

  useEffect(() => {
    void syncMaximized();
    let active = true;
    let unlisten: (() => void) | undefined;
    void appWindow.onResized(() => {
      void syncMaximized();
      publishMaximizeButtonRect();
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    }).catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, [appWindow, publishMaximizeButtonRect, syncMaximized]);

  useLayoutEffect(() => {
    const element = maximizeButton.current;
    if (!element) return;
    const observer = new ResizeObserver(publishMaximizeButtonRect);
    observer.observe(element);
    publishMaximizeButtonRect();
    return () => observer.disconnect();
  }, [publishMaximizeButtonRect]);

  async function minimize() {
    await appWindow.minimize();
  }

  async function toggleMaximize() {
    await appWindow.toggleMaximize();
    await syncMaximized();
    publishMaximizeButtonRect();
  }

  async function hideToTray() {
    await invoke("window_hide_to_tray");
  }

  function handleMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || isWindowControl(event.target)) return;
    if (event.detail > 1) {
      void toggleMaximize();
      return;
    }
    void appWindow.startDragging();
  }

  function handleContextMenu(event: MouseEvent<HTMLDivElement>) {
    if (isWindowControl(event.target)) return;
    event.preventDefault();
    void invoke("window_show_system_menu").catch(() => undefined);
  }

  return (
    <div
      className="window-titlebar"
      aria-label={t("titlebar.label")}
      onContextMenu={handleContextMenu}
      onMouseDown={handleMouseDown}
    >
      <span className="window-titlebar-title">MioProxy</span>
      <div className="window-titlebar-controls">
        <button className="window-titlebar-control" type="button" aria-label={t("titlebar.minimize")} onClick={() => void minimize()}>
          <Minus size={14} strokeWidth={1.7} />
        </button>
        <button
          ref={maximizeButton}
          className="window-titlebar-control"
          type="button"
          aria-label={maximized ? t("titlebar.restore") : t("titlebar.maximize")}
          onClick={() => void toggleMaximize()}
        >
          <Square size={13} strokeWidth={1.7} />
        </button>
        <button className="window-titlebar-control window-titlebar-close" type="button" aria-label={t("titlebar.close")} onClick={() => void hideToTray()}>
          <X size={14} strokeWidth={1.7} />
        </button>
      </div>
    </div>
  );
}
