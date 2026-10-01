"use client";

import { useSyncExternalStore } from "react";

// A tiny localStorage-backed store. State is per browser: nothing here leaves
// the device.
export function createStore<T>(key: string, initial: T) {
  let state = initial;
  let loaded = false;
  const listeners = new Set<() => void>();

  function load() {
    if (loaded || typeof window === "undefined") return;
    loaded = true;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) state = { ...initial, ...JSON.parse(raw) };
    } catch {
      // Storage blocked or corrupt: keep the defaults.
    }
    window.addEventListener("storage", (e) => {
      if (e.key !== key || !e.newValue) return;
      try {
        state = { ...initial, ...JSON.parse(e.newValue) };
        listeners.forEach((l) => l());
      } catch {}
    });
  }

  function get(): T {
    load();
    return state;
  }

  function set(next: T) {
    load();
    state = next;
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {}
    listeners.forEach((l) => l());
  }

  function update(fn: (s: T) => T) {
    set(fn(get()));
  }

  function subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }

  function use(): T {
    return useSyncExternalStore(subscribe, get, () => initial);
  }

  return { get, set, update, subscribe, use };
}
