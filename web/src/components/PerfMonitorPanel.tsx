import { useState } from 'preact/hooks';
import { FullPerfSnapshot } from './ConstellationView';

interface PerfMonitorPanelProps {
  perf: FullPerfSnapshot;
  history: FullPerfSnapshot[];
  satCount: number;
  onClose: () => void;
}

export function PerfMonitorPanel({
  perf,
  history,
  satCount,
  onClose,
}: PerfMonitorPanelProps) {
  const [copied, setCopied] = useState(false);

  const totalCpuWorkMs =
    perf.wasmPureSgp4Ms +
    perf.wasmReadoutMs +
    perf.threeBufferSyncMs +
    perf.webglRenderMs;
  const budgetMs = 16.667; // 60 FPS target budget
  const budgetUsagePct = Math.min(100, (totalCpuWorkMs / budgetMs) * 100);

  const pctSgp4 = Math.min(100, (perf.wasmPureSgp4Ms / budgetMs) * 100);
  const pctRead = Math.min(100, (perf.wasmReadoutMs / budgetMs) * 100);
  const pctBuf = Math.min(100, (perf.threeBufferSyncMs / budgetMs) * 100);
  const pctGl = Math.min(100, (perf.webglRenderMs / budgetMs) * 100);

  // Build SVG sparkline path (width 280, height 48, max scale 16.67ms)
  const w = 280;
  const h = 48;
  const maxMs = 18.0;
  const ptsTotal: string[] = [];
  const ptsWasm: string[] = [];

  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    const x = (i / Math.max(history.length - 1, 1)) * w;
    const tot =
      item.wasmPureSgp4Ms +
      item.wasmReadoutMs +
      item.threeBufferSyncMs +
      item.webglRenderMs;
    const yTot = h - Math.min(1, tot / maxMs) * (h - 4) - 2;
    const yWasm = h - Math.min(1, item.wasmPureSgp4Ms / maxMs) * (h - 4) - 2;
    ptsTotal.push(`${x.toFixed(1)},${yTot.toFixed(1)}`);
    ptsWasm.push(`${x.toFixed(1)},${yWasm.toFixed(1)}`);
  }

  const handleCopyReport = () => {
    const report = {
      timestamp: new Date().toISOString(),
      satellitesTracked: satCount,
      fps: Number(perf.fps.toFixed(1)),
      minFps: Number(perf.minFps.toFixed(1)),
      frameIntervalMs: Number(perf.frameTimeMs.toFixed(2)),
      cpuWorkBreakdownMs: {
        totalActiveMs: Number(totalCpuWorkMs.toFixed(2)),
        moonbitWasmSgp4PureMs: Number(perf.wasmPureSgp4Ms.toFixed(2)),
        wasmToJsReadoutMs: Number(perf.wasmReadoutMs.toFixed(2)),
        threeBufferSyncMs: Number(perf.threeBufferSyncMs.toFixed(2)),
        webglSubmitMs: Number(perf.webglRenderMs.toFixed(2)),
        frameBudget60HzUsagePercent: Number(budgetUsagePct.toFixed(1)),
      },
      webglRendererInfo: {
        drawCalls: perf.drawCalls,
        points: perf.points,
        triangles: perf.triangles,
        lines: perf.lines,
        shaderPrograms: perf.programs,
        geometries: perf.geometries,
        textures: perf.textures,
      },
      memory: {
        wasmLinearMemoryMB: Number(
          (perf.wasmMemoryBytes / (1024 * 1024)).toFixed(2),
        ),
        jsHeapUsedMB: perf.jsHeapMb ? Number(perf.jsHeapMb.toFixed(2)) : null,
      },
    };
    navigator.clipboard?.writeText(JSON.stringify(report, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div
      className="hud-panel"
      style={{
        position: 'absolute',
        top: '74px',
        right: '12px',
        width: '320px',
        zIndex: 15,
        padding: '13px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div className="section-header">
        <span>📊 Render & Wasm SGP4 Profiler</span>
        <div style={{ display: 'flex', gap: '5px' }}>
          <button className="chip" onClick={handleCopyReport}>
            {copied ? '✓ Copied JSON' : '📋 Copy JSON'}
          </button>
          <button className="chip" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>

      {/* FPS & Frame Budget Summary */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: '6px',
        }}
      >
        <div className="telemetry-box">
          <span className="field-label">AVG FPS</span>
          <div className="telemetry-val" style={{ color: '#34d399' }}>
            {perf.fps.toFixed(1)}
          </div>
        </div>
        <div className="telemetry-box">
          <span className="field-label">1% LOW FPS</span>
          <div className="telemetry-val" style={{ color: '#38bdf8' }}>
            {perf.minFps.toFixed(1)}
          </div>
        </div>
        <div className="telemetry-box">
          <span className="field-label">60Hz BUDGET</span>
          <div
            className="telemetry-val"
            style={{
              color: budgetUsagePct < 75 ? '#34d399' : '#fb923c',
            }}
          >
            {budgetUsagePct.toFixed(0)}%
          </div>
        </div>
      </div>

      {/* Stacked Frame Budget Bar (out of 16.67ms) */}
      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '10px',
            color: '#94a3b8',
            marginBottom: '4px',
          }}
        >
          <span>Frame Active Work Breakdown</span>
          <span style={{ fontFamily: 'monospace', color: '#f8fafc' }}>
            {totalCpuWorkMs.toFixed(2)} / 16.67 ms
          </span>
        </div>
        <div
          style={{
            width: '100%',
            height: '8px',
            background: 'rgba(15, 23, 42, 0.9)',
            borderRadius: '4px',
            overflow: 'hidden',
            display: 'flex',
            border: '1px solid rgba(148, 163, 184, 0.2)',
          }}
        >
          <div
            style={{ width: `${pctSgp4}%`, background: '#38bdf8' }}
            title="MoonBit SGP4 Pure Compute"
          />
          <div
            style={{ width: `${pctRead}%`, background: '#a78bfa' }}
            title="Wasm to JS Readout"
          />
          <div
            style={{ width: `${pctBuf}%`, background: '#10b981' }}
            title="Three.js Vertex Buffer Sync"
          />
          <div
            style={{ width: `${pctGl}%`, background: '#fb923c' }}
            title="WebGL Render Submit"
          />
        </div>
      </div>

      {/* Detailed Stage Timings */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          fontSize: '11px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#38bdf8' }}>
            ● MoonBit Wasm SGP4 ({satCount.toLocaleString()} sats)
          </span>
          <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>
            {perf.wasmPureSgp4Ms.toFixed(2)} ms
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#a78bfa' }}>● Wasm → JS FFI Readout</span>
          <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>
            {perf.wasmReadoutMs.toFixed(2)} ms
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#10b981' }}>
            ● Three.js Float32Buffer Sync
          </span>
          <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>
            {perf.threeBufferSyncMs.toFixed(2)} ms
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#fb923c' }}>● WebGL Draw Call Submit</span>
          <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>
            {perf.webglRenderMs.toFixed(2)} ms
          </span>
        </div>
      </div>

      {/* Real-time Sparkline */}
      <div
        style={{
          background: 'rgba(15, 23, 42, 0.75)',
          border: '1px solid rgba(148, 163, 184, 0.16)',
          borderRadius: '6px',
          padding: '6px 8px',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '9px',
            color: '#94a3b8',
            marginBottom: '2px',
          }}
        >
          <span>60-Frame History (Green=Total, Cyan=Wasm SGP4)</span>
          <span>Max 18ms</span>
        </div>
        <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`}>
          <line
            x1="0"
            y1="4"
            x2={w}
            y2="4"
            stroke="rgba(248, 113, 113, 0.35)"
            strokeDasharray="3,3"
          />
          {ptsTotal.length > 1 && (
            <polyline
              fill="none"
              stroke="#34d399"
              strokeWidth="1.5"
              points={ptsTotal.join(' ')}
            />
          )}
          {ptsWasm.length > 1 && (
            <polyline
              fill="none"
              stroke="#38bdf8"
              strokeWidth="1.5"
              points={ptsWasm.join(' ')}
            />
          )}
        </svg>
      </div>

      {/* WebGL GPU & Memory Telemetry */}
      <div className="telemetry-grid">
        <div className="telemetry-box">
          <span className="field-label">DRAW CALLS / FRAME</span>
          <div className="telemetry-val">{perf.drawCalls} calls</div>
        </div>
        <div className="telemetry-box">
          <span className="field-label">GPU POINTS / TRIS</span>
          <div className="telemetry-val" style={{ fontSize: '11px' }}>
            {perf.points.toLocaleString()} pts ·{' '}
            {(perf.triangles / 1000).toFixed(1)}k tris
          </div>
        </div>
        <div className="telemetry-box">
          <span className="field-label">WASM LINEAR MEM</span>
          <div className="telemetry-val">
            {(perf.wasmMemoryBytes / (1024 * 1024)).toFixed(2)} MB
          </div>
        </div>
        <div className="telemetry-box">
          <span className="field-label">JS HEAP / SHADERS</span>
          <div className="telemetry-val" style={{ fontSize: '11px' }}>
            {perf.jsHeapMb ? `${perf.jsHeapMb.toFixed(1)} MB` : 'N/A'} ·{' '}
            {perf.programs} progs
          </div>
        </div>
      </div>
    </div>
  );
}
