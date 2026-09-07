import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mihomoApi, type ConnectionsResponse } from "../api/mihomo";
import { connectionStore } from "../stores/connectionStore";
import { useConnections } from "./useConnections";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const snapshot: ConnectionsResponse = { downloadTotal: 42, uploadTotal: 0, connections: [] };

afterEach(() => { cleanup(); connectionStore.reset(); vi.restoreAllMocks(); });

it.each(["success", "failure"])("ignores a late %s after the core stops", async (outcome) => {
  const pending = deferred<ConnectionsResponse>();
  vi.spyOn(mihomoApi, "connections").mockReturnValue(pending.promise);
  const { rerender } = renderHook(({ enabled }) => useConnections(enabled), { initialProps: { enabled: true } });
  rerender({ enabled: false });
  await act(async () => {
    if (outcome === "success") pending.resolve(snapshot);
    else pending.reject(new Error("old core failed"));
  });
  expect(connectionStore.getSnapshot()).toEqual({ data: null, loading: false, error: null });
});

it("starts a fresh request after restart while an old request is still pending", async () => {
  const old = deferred<ConnectionsResponse>();
  const fresh = deferred<ConnectionsResponse>();
  const fetch = vi.spyOn(mihomoApi, "connections").mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const { rerender } = renderHook(({ enabled }) => useConnections(enabled), { initialProps: { enabled: true } });
  rerender({ enabled: false });
  rerender({ enabled: true });
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => { fresh.resolve(snapshot); });
  await act(async () => { old.resolve({ ...snapshot, downloadTotal: 1 }); });
  expect(connectionStore.getSnapshot().data).toEqual(snapshot);
});

it("does not publish a response after unmount", async () => {
  const pending = deferred<ConnectionsResponse>();
  vi.spyOn(mihomoApi, "connections").mockReturnValue(pending.promise);
  const { unmount } = renderHook(() => useConnections(true));
  unmount();
  connectionStore.reset();
  await act(async () => { pending.resolve(snapshot); });
  expect(connectionStore.getSnapshot().data).toBeNull();
});

it("keeps the new request locked when an old request finishes", async () => {
  const old = deferred<ConnectionsResponse>();
  const fresh = deferred<ConnectionsResponse>();
  const fetch = vi.spyOn(mihomoApi, "connections").mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const { result, rerender } = renderHook(({ enabled }) => useConnections(enabled), { initialProps: { enabled: true } });
  rerender({ enabled: false });
  rerender({ enabled: true });
  await act(async () => { old.reject(new Error("old core failed")); });
  await act(async () => { await result.current.refresh(); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(result.current.loading).toBe(true);
  expect(result.current.error).toBeNull();
  await act(async () => { fresh.resolve(snapshot); });
  expect(result.current.data).toEqual(snapshot);
  expect(result.current.loading).toBe(false);
});
