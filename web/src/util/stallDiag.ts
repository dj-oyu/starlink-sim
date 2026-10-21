/**
 * Field diagnostics for "auto-rotate silently stopped" (seen after leaving a tab open overnight:
 * the flag is on, dragging still works, nothing in the console). Hypothesis: OrbitControls keeps a
 * stale pointer / non-NONE state after a missed pointerup, and its autoRotate only runs in NONE.
 *
 * This only observes; it never repairs anything, so the evidence is not disturbed. It keeps a
 * small log in localStorage (survives reloads), notices a stall (auto-rotate wanted, tab visible,
 * no pointer down, camera not moving for STALL_MS), and snapshots the controls' internals right
 * then and around the first click afterwards (the click is what un-stuck it last time).
 */
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Camera } from 'three';
import { collectDeviceInfo } from './clipboard';

const KEY = 'starlink-sim:stall-diag:v1';
const MAX_EVENTS = 50;
const MAX_STALLS = 5;
const STALL_MS = 10_000;
const TICK_MS = 1_000;
const HEARTBEAT_MS = 60_000;

type Snapshot = Record<string, unknown>;
interface Stall {
  at: string;
  snapshot: Snapshot;
  /** snapshots around the first click after the stall: preClick, postClick */
  probe: Record<string, Snapshot>;
}
interface Store {
  build: string;
  device: Record<string, unknown>;
  events: [string, string, ...unknown[]][];
  heartbeat: Snapshot | null;
  stalls: Stall[];
}

const listeners = new Set<() => void>();
let store: Store | null = null;

const load = (): Store => {
  if (store) return store;
  let parsed: Store | null = null;
  try {
    parsed = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    // unreadable or blocked storage: keep in memory only
  }
  store = parsed ?? { build: '', device: {}, events: [], heartbeat: null, stalls: [] };
  return store;
};

const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(load()));
  } catch {
    // quota / private mode: diagnostics must never break the app
  }
  listeners.forEach((l) => l());
};

export const stallDiagSubscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const stallDiagStalls = (): number => load().stalls.length;
export const stallDiagJson = (): string => JSON.stringify(load(), null, 1);
export const stallDiagClear = (): void => {
  store = { ...load(), events: [], heartbeat: null, stalls: [] };
  save();
  if (document.title.startsWith('⚠ ')) document.title = document.title.slice(2);
};

const stamp = () => new Date().toISOString();
const pushEvent = (...e: [string, ...unknown[]]) => {
  const s = load();
  s.events.push([stamp(), ...e] as Store['events'][number]);
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
  save();
};

export function startStallDiag(controls: OrbitControls, camera: Camera): () => void {
  // `state` and `_pointers` are internals of OrbitControls (three r169); read defensively.
  const internals = controls as unknown as { state?: unknown; _pointers?: unknown[] };
  const snapshot = (): Snapshot => ({
    at: stamp(),
    visibility: document.visibilityState,
    autoRotate: controls.autoRotate,
    enabled: controls.enabled,
    state: internals.state ?? null,
    pointers: Array.isArray(internals._pointers) ? [...internals._pointers] : null,
    pointerDownSeen: [...down],
    cameraDist: +camera.position.length().toFixed(3),
  });

  // Pointer ids we have seen go down without a matching up, tracked independently of OrbitControls
  const down = new Set<number>();
  let probing: Stall | null = null;

  const s = load();
  s.build = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
  s.device = collectDeviceInfo();
  pushEvent('load');

  const onPointer = (e: PointerEvent) => {
    if (e.type === 'pointerdown') down.add(e.pointerId);
    else down.delete(e.pointerId);
    pushEvent(e.type, e.pointerId, e.pointerType);
    if (probing) {
      if (e.type === 'pointerdown' && !probing.probe.preClick) probing.probe.preClick = snapshot();
      if (e.type === 'pointerup' && !probing.probe.postClick) {
        const p = probing;
        probing = null;
        // let OrbitControls handle the same event first
        setTimeout(() => {
          p.probe.postClick = snapshot();
          save();
        }, 100);
      }
    }
  };
  const onMisc = (e: Event) => {
    if (e.type === 'blur') down.clear();
    pushEvent(e.type, document.visibilityState);
    lastMoveAt = performance.now();
  };
  const types = ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture'] as const;
  // capture phase on window: runs before OrbitControls' own handlers
  types.forEach((t) => window.addEventListener(t, onPointer, true));
  window.addEventListener('blur', onMisc);
  document.addEventListener('visibilitychange', onMisc);

  const last = camera.position.clone();
  let lastMoveAt = performance.now();
  let lastWanted = false;
  let flagged = false;

  const tick = window.setInterval(() => {
    const now = performance.now();
    if (camera.position.distanceToSquared(last) > 1e-10) {
      last.copy(camera.position);
      lastMoveAt = now;
    }
    // the wish for rotation turning on (or the tab coming back) restarts the clock
    if (controls.autoRotate && !lastWanted) lastMoveAt = now;
    lastWanted = controls.autoRotate;

    const eligible =
      controls.autoRotate && document.visibilityState === 'visible' && down.size === 0;
    if (!eligible) {
      lastMoveAt = now;
      flagged = false;
      return;
    }
    if (!flagged && now - lastMoveAt >= STALL_MS) {
      flagged = true;
      const st: Stall = { at: stamp(), snapshot: snapshot(), probe: {} };
      const store = load();
      store.stalls.push(st);
      if (store.stalls.length > MAX_STALLS) store.stalls.shift();
      probing = st;
      if (!document.title.startsWith('⚠ ')) document.title = `⚠ ${document.title}`;
      pushEvent('stall');
    }
  }, TICK_MS);

  // Without a heartbeat an empty log cannot tell "no stall" from "the tab was frozen/discarded"
  const beat = window.setInterval(() => {
    load().heartbeat = snapshot();
    save();
  }, HEARTBEAT_MS);

  return () => {
    window.clearInterval(tick);
    window.clearInterval(beat);
    types.forEach((t) => window.removeEventListener(t, onPointer, true));
    window.removeEventListener('blur', onMisc);
    document.removeEventListener('visibilitychange', onMisc);
  };
}
