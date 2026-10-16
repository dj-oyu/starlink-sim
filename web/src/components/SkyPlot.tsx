import { useEffect, useRef } from 'preact/hooks';
import { ObserverConfig, SHELL_INFO, StarlinkSimEngine } from '../wasm/simEngine';
import type { PerfListener } from './PerfMonitorPanel';

interface SkyPlotProps {
  engine: StarlinkSimEngine;
  observer: ObserverConfig;
  enabledShells: boolean[];
  selectedSatIndex: number | null;
  onSelectSat: (idx: number) => void;
  subscribePerf: (cb: PerfListener) => () => void;
}

const SIZE = 220; // CSS px (square)
const MAX_DOTS = 512;
const DEG = Math.PI / 180;

/**
 * Polar sky chart of the satellites currently above the observer's minimum
 * elevation (zenith at the centre, horizon at the rim, north up, east left as
 * when looking up at the sky). Redrawn at the HUD's 4 Hz telemetry tick with
 * preallocated buffers, so it adds no per-frame JS allocation.
 */
export function SkyPlot({
  engine,
  observer,
  enabledShells,
  selectedSatIndex,
  onSelectSat,
  subscribePerf,
}: SkyPlotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dotsRef = useRef({
    n: 0,
    x: new Float32Array(MAX_DOTS),
    y: new Float32Array(MAX_DOTS),
    idx: new Int32Array(MAX_DOTS),
  });

  useEffect(() => {
    const dots = dotsRef.current;
    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const R = SIZE / 2 - 18;
    const dash: number[] = [3, 3];
    const solid: number[] = [];

    const draw = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      ctx.setTransform(canvas.width / SIZE, 0, 0, canvas.height / SIZE, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);

      // Grid: horizon, 30° and 60° elevation rings, N-S / E-W axes
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
      ctx.lineWidth = 1;
      for (let el = 0; el < 90; el += 30) {
        ctx.beginPath();
        ctx.arc(cx, cy, R * ((90 - el) / 90), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(cx - R, cy);
      ctx.lineTo(cx + R, cy);
      ctx.moveTo(cx, cy - R);
      ctx.lineTo(cx, cy + R);
      ctx.stroke();

      // Minimum-elevation ring (dish field-of-view edge)
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.6)';
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.arc(cx, cy, R * ((90 - observer.minElDeg) / 90), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash(solid);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', cx, cy - R - 9);
      ctx.fillText('S', cx, cy + R + 9);
      ctx.fillText('E', cx - R - 9, cy); // east is on the left when looking up
      ctx.fillText('W', cx + R + 9, cy);

      dots.n = 0;
      if (!observer.enabled) return;
      const api = engine.api;
      const satStatus = engine.satStatus;
      const vLen = Math.min(api.get_visible_count(), MAX_DOTS);
      for (let k = 0; k < vLen; k++) {
        const idx = api.get_visible_sat_index(k);
        const shId = satStatus[idx] & 7;
        if (!(enabledShells[shId] ?? true)) continue;
        const el = api.get_sat_elevation_deg(idx);
        const az = api.get_sat_azimuth_deg(idx) * DEG;
        const r = R * ((90 - el) / 90);
        const x = cx - r * Math.sin(az);
        const y = cy - r * Math.cos(az);
        const n = dots.n++;
        dots.x[n] = x;
        dots.y[n] = y;
        dots.idx[n] = idx;
        const selected = idx === selectedSatIndex;
        ctx.fillStyle = selected
          ? '#fde047'
          : (SHELL_INFO[shId] ?? SHELL_INFO[0]).color;
        ctx.beginPath();
        ctx.arc(x, y, selected ? 5 : 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    draw();
    return subscribePerf(draw);
  }, [engine, observer, enabledShells, selectedSatIndex, subscribePerf]);

  const handleClick = (e: MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * SIZE;
    const sy = ((e.clientY - rect.top) / rect.height) * SIZE;
    const dots = dotsRef.current;
    let best = -1;
    let bestD = 100; // 10 px pick radius, squared
    for (let i = 0; i < dots.n; i++) {
      const dx = dots.x[i] - sx;
      const dy = dots.y[i] - sy;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) onSelectSat(dots.idx[best]);
  };

  return (
    <canvas
      ref={canvasRef}
      className="sky-plot"
      width={SIZE * 2}
      height={SIZE * 2}
      style={{ width: `${SIZE}px`, height: `${SIZE}px` }}
      role="img"
      aria-label="上空の衛星の方位・仰角図 (クリックで衛星を選択)"
      onClick={handleClick}
    />
  );
}
