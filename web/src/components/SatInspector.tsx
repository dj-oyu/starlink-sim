import { useRef } from 'preact/hooks';
import { ChevronDown, ChevronUp, X } from 'lucide-preact';
import type { SatelliteTelemetry } from '../wasm/simEngine';

export type SheetState = 'peek' | 'half' | 'full';
const SHEET_ORDER: SheetState[] = ['peek', 'half', 'full'];

interface BodyProps {
  t: SatelliteTelemetry;
  followSelected: boolean;
  showGroundTrack: boolean;
  onToggleFollow: () => void;
  onToggleGroundTrack: () => void;
  /** Also show orbit details (used by the expanded phone sheet). */
  extended?: boolean;
}

/** Shell chip, telemetry grid and action buttons (shared by the desktop panel and the phone sheet). */
export function SatInspectorBody({
  t,
  followSelected,
  showGroundTrack,
  onToggleFollow,
  onToggleGroundTrack,
  extended = false,
}: BodyProps) {
  // Circular-orbit period from the altitude (Kepler's third law, WGS-72 mu)
  const aKm = 6378.135 + t.altKm;
  const periodMin = (2 * Math.PI * Math.sqrt((aKm * aKm * aKm) / 398600.8)) / 60;
  return (
    <>
      <div
        style={{
          fontSize: '11px',
          padding: '4px 8px',
          borderRadius: '5px',
          background: 'rgba(56, 189, 248, 0.14)',
          color: '#7dd3fc',
        }}
      >
        {t.shellLabel}
      </div>

      <div className="telemetry-grid">
        <div className="telemetry-box">
          <span className="field-label">ALTITUDE (高度)</span>
          <div className="telemetry-val">{t.altKm.toFixed(2)} km</div>
        </div>
        <div className="telemetry-box">
          <span className="field-label">VELOCITY (速度)</span>
          <div className="telemetry-val">{t.speedKms.toFixed(3)} km/s</div>
        </div>
        <div className="telemetry-box">
          <span className="field-label">LATITUDE (緯度)</span>
          <div className="telemetry-val">{t.latDeg.toFixed(4)}°</div>
        </div>
        <div className="telemetry-box">
          <span className="field-label">LONGITUDE (経度)</span>
          <div className="telemetry-val">{t.lonDeg.toFixed(4)}°</div>
        </div>
        <div className="telemetry-box">
          <span className="field-label">ELEVATION (仰角)</span>
          <div
            className="telemetry-val"
            style={{ color: t.visible ? '#34d399' : '#94a3b8' }}
          >
            {t.visible ? `${t.elevationDeg.toFixed(1)}° (VISIBLE)` : 'Below FOV'}
          </div>
        </div>
        <div className="telemetry-box">
          <span className="field-label">SLANT RANGE (距離)</span>
          <div className="telemetry-val">
            {t.visible ? `${t.rangeKm.toFixed(0)} km` : '---'}
          </div>
        </div>
      </div>

      {extended && (
        <div className="telemetry-grid">
          <div className="telemetry-box">
            <span className="field-label">INCLINATION (軌道傾斜角)</span>
            <div className="telemetry-val">{t.inclinationDeg.toFixed(2)}°</div>
          </div>
          <div className="telemetry-box">
            <span className="field-label">AZIMUTH (方位角)</span>
            <div className="telemetry-val">{t.azimuthDeg.toFixed(1)}°</div>
          </div>
          <div className="telemetry-box">
            <span className="field-label">PERIOD (周期)</span>
            <div className="telemetry-val">{periodMin.toFixed(1)} min</div>
          </div>
          <div className="telemetry-box">
            <span className="field-label">REVS / DAY (周回数)</span>
            <div className="telemetry-val">{(1440 / periodMin).toFixed(2)}</div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '6px' }}>
        <button
          className={`btn ${followSelected ? 'active' : ''}`}
          style={{ flex: 1, justifyContent: 'center' }}
          onClick={onToggleFollow}
        >
          {followSelected ? '🎥 Tracking Satellite' : '🎥 Follow Camera'}
        </button>
        <button
          className={`btn ${showGroundTrack ? 'active' : ''}`}
          style={{ flex: 1, justifyContent: 'center' }}
          onClick={onToggleGroundTrack}
        >
          〰️ Ground Track
        </button>
      </div>
    </>
  );
}

/** Name / NORAD id / close button row of the desktop panel. */
export function SatInspectorTitle({
  t,
  onClose,
}: {
  t: SatelliteTelemetry;
  onClose: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <div>
        <div style={{ fontSize: '14px', fontWeight: 700, color: '#fde047' }}>
          🛰️ {t.name}
        </div>
        <div style={{ fontSize: '11px', color: '#94a3b8' }}>
          NORAD #{t.satnum} · COSPAR {t.intlDesig || 'N/A'}
        </div>
      </div>
      <button className="btn" onClick={onClose} aria-label="閉じる">
        ✕
      </button>
    </div>
  );
}

interface SheetProps extends BodyProps {
  state: SheetState;
  heightPx: number;
  onStateChange: (s: SheetState) => void;
  onClose: () => void;
  sheetRef: { current: HTMLElement | null };
}

/**
 * Phone bottom sheet for the selected satellite: collapsed (name + key figures), half, and full
 * (covers the header). Dragging or tapping the handle moves between the states.
 */
export function SatSheet({ state, heightPx, onStateChange, onClose, sheetRef, ...body }: SheetProps) {
  const { t } = body;
  const drag = useRef<{ y0: number; moved: boolean } | null>(null);
  const idx = SHEET_ORDER.indexOf(state);
  const go = (delta: number) => {
    const next = SHEET_ORDER[Math.min(SHEET_ORDER.length - 1, Math.max(0, idx + delta))];
    if (next !== state) onStateChange(next);
  };

  const onPointerDown = (e: PointerEvent) => {
    drag.current = { y0: e.clientY, moved: false };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // not an active pointer (e.g. synthetic events): dragging still works without capture
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (d && Math.abs(e.clientY - d.y0) > 6) d.moved = true;
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const dy = e.clientY - d.y0;
    if (!d.moved) {
      // tap: collapsed -> half, half -> collapsed, full -> half
      onStateChange(state === 'peek' ? 'half' : state === 'half' ? 'peek' : 'half');
    } else if (dy < -30) go(1);
    else if (dy > 30) go(-1);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowUp') go(1);
    else if (e.key === 'ArrowDown') go(-1);
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onStateChange(state === 'peek' ? 'half' : 'peek');
    }
  };

  return (
    <section
      ref={(el) => {
        sheetRef.current = el;
      }}
      className="hud-panel sat-sheet"
      data-state={state}
      style={{ height: `${heightPx}px` }}
      aria-label="衛星の詳細"
    >
      <div
        className="sheet-handle"
        role="button"
        tabIndex={0}
        aria-expanded={state !== 'peek'}
        aria-label="詳細パネルの展開・折りたたみ (ドラッグでも操作できます)"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
        onKeyDown={onKeyDown}
      >
        <span className="sheet-grip" aria-hidden="true" />
      </div>

      <div className="sheet-head">
        <div className="sheet-title">
          <div className="sheet-name">🛰️ {t.name}</div>
          <div className="sheet-figures">
            高度 {t.altKm.toFixed(0)} km · {t.speedKms.toFixed(2)} km/s
            {t.visible ? ` · 仰角 ${t.elevationDeg.toFixed(0)}°` : ''}
          </div>
        </div>
        <button
          className="icon-btn"
          aria-label={state === 'peek' ? '詳細を開く' : '折りたたむ'}
          onClick={() => onStateChange(state === 'peek' ? 'half' : 'peek')}
        >
          {state === 'peek' ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
        <button className="icon-btn" aria-label="閉じる" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <div className="sheet-body">
        <div style={{ fontSize: '11px', color: '#94a3b8' }}>
          NORAD #{t.satnum} · COSPAR {t.intlDesig || 'N/A'}
        </div>
        <SatInspectorBody {...body} extended={state === 'full'} />
      </div>
    </section>
  );
}
