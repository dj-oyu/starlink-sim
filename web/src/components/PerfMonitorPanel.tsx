import { useEffect, useRef, useState } from 'preact/hooks';
import { collectDeviceInfo, copyText } from '../util/clipboard';
import { FullPerfSnapshot } from './ConstellationView';

export type PerfListener = (perf: FullPerfSnapshot) => void;

interface PerfMonitorPanelProps {
  latestPerfRef: { current: FullPerfSnapshot };
  subscribePerf: (cb: PerfListener) => () => void;
  satCount: number;
  onClose: () => void;
  /** Runs the on-device GPU benchmark; resolves to the report object. */
  onRunGpuBench?: (onProgress: (msg: string) => void) => Promise<Record<string, unknown>>;
}

export function PerfMonitorPanel({
  latestPerfRef,
  subscribePerf,
  satCount,
  onClose,
  onRunGpuBench,
}: PerfMonitorPanelProps) {
  const [copied, setCopied] = useState(false);
  // Shown when automatic copying is blocked (e.g. some browsers): select-and-copy by hand
  const [manualText, setManualText] = useState<string | null>(null);
  const [modalCopied, setModalCopied] = useState(false);
  const [benchMsg, setBenchMsg] = useState<string | null>(null); // non-null while the GPU bench runs

  const fpsValRef = useRef<HTMLDivElement>(null);
  const minFpsValRef = useRef<HTMLDivElement>(null);
  const budgetValRef = useRef<HTMLDivElement>(null);
  const totalMsSpanRef = useRef<HTMLSpanElement>(null);
  const barSgp4Ref = useRef<HTMLDivElement>(null);
  const barReadRef = useRef<HTMLDivElement>(null);
  const barBufRef = useRef<HTMLDivElement>(null);
  const barGlRef = useRef<HTMLDivElement>(null);
  const sgp4MsRef = useRef<HTMLSpanElement>(null);
  const readMsRef = useRef<HTMLSpanElement>(null);
  const bufMsRef = useRef<HTMLSpanElement>(null);
  const glMsRef = useRef<HTMLSpanElement>(null);
  const chartRef = useRef<HTMLCanvasElement>(null);
  const drawCallsRef = useRef<HTMLDivElement>(null);
  const ptsTrisRef = useRef<HTMLDivElement>(null);
  const wasmMemRef = useRef<HTMLDivElement>(null);
  const jsHeapRef = useRef<HTMLDivElement>(null);

  const w = 280;
  const h = 48;
  const maxMs = 18.0;

  useEffect(() => {
    const histTotal = new Float32Array(60);
    const histWasm = new Float32Array(60);
    // The history chart is drawn on a canvas with preallocated state: building
    // SVG `points` strings every update was the largest steady-state JS allocation.
    const xCoords = new Float32Array(60);
    for (let i = 0; i < 60; i++) {
      xCoords[i] = (i / 59) * w;
    }
    const dashed: number[] = [3, 3];
    const solid: number[] = [];
    const drawLine = (
      ctx: CanvasRenderingContext2D,
      hist: Float32Array,
      n: number,
      color: string,
    ) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const y = (h - Math.min(1, hist[i] / maxMs) * (h - 4) - 2) | 0;
        if (i === 0) ctx.moveTo(xCoords[i], y);
        else ctx.lineTo(xCoords[i], y);
      }
      ctx.stroke();
    };
    let count = 0;
    let prevHeapMb: number | null = null;
    let prevTimeMs = performance.now();
    let smoothedAllocKbPerSec = 0;
    let gcSweepCount = 0;

    const applyPerf = (perf: FullPerfSnapshot) => {
      const nowMs = performance.now();
      const dtSec = Math.max(0.05, (nowMs - prevTimeMs) / 1000);
      prevTimeMs = nowMs;

      if (perf.jsHeapMb !== null) {
        if (prevHeapMb !== null) {
          const deltaMb = perf.jsHeapMb - prevHeapMb;
          if (deltaMb < -0.15) {
            gcSweepCount++;
          } else if (deltaMb >= 0) {
            const instKbPerSec = (deltaMb * 1024) / dtSec;
            smoothedAllocKbPerSec =
              smoothedAllocKbPerSec * 0.75 + instKbPerSec * 0.25;
          }
        }
        prevHeapMb = perf.jsHeapMb;
      }

      const totalCpuWorkMs =
        perf.wasmPureSgp4Ms +
        perf.wasmReadoutMs +
        perf.threeBufferSyncMs +
        perf.webglRenderMs;
      const budgetMs = 16.667;
      const budgetUsagePct = Math.min(100, (totalCpuWorkMs / budgetMs) * 100);

      if (fpsValRef.current) fpsValRef.current.textContent = perf.fps.toFixed(1);
      if (minFpsValRef.current) minFpsValRef.current.textContent = perf.minFps.toFixed(1);
      if (budgetValRef.current) {
        budgetValRef.current.textContent = `${budgetUsagePct.toFixed(0)}%`;
        budgetValRef.current.style.color = budgetUsagePct < 75 ? '#34d399' : '#fb923c';
      }
      if (totalMsSpanRef.current) {
        totalMsSpanRef.current.textContent = `${totalCpuWorkMs.toFixed(2)} / 16.67 ms`;
      }
      if (barSgp4Ref.current) {
        barSgp4Ref.current.style.width = `${Math.min(100, (perf.wasmPureSgp4Ms / budgetMs) * 100)}%`;
      }
      if (barReadRef.current) {
        barReadRef.current.style.width = `${Math.min(100, (perf.wasmReadoutMs / budgetMs) * 100)}%`;
      }
      if (barBufRef.current) {
        barBufRef.current.style.width = `${Math.min(100, (perf.threeBufferSyncMs / budgetMs) * 100)}%`;
      }
      if (barGlRef.current) {
        barGlRef.current.style.width = `${Math.min(100, (perf.webglRenderMs / budgetMs) * 100)}%`;
      }
      if (sgp4MsRef.current) sgp4MsRef.current.textContent = `${perf.wasmPureSgp4Ms.toFixed(2)} ms${perf.wasmSlices > 1 ? ` (1/${perf.wasmSlices} sats)` : ''}`;
      if (readMsRef.current) readMsRef.current.textContent = `${perf.wasmReadoutMs.toFixed(2)} ms`;
      if (bufMsRef.current) bufMsRef.current.textContent = `${perf.threeBufferSyncMs.toFixed(2)} ms`;
      if (glMsRef.current) glMsRef.current.textContent = `${perf.webglRenderMs.toFixed(2)} ms`;

      if (count < 60) {
        histTotal[count] = totalCpuWorkMs;
        histWasm[count] = perf.wasmPureSgp4Ms;
        count++;
      } else {
        histTotal.copyWithin(0, 1);
        histWasm.copyWithin(0, 1);
        histTotal[59] = totalCpuWorkMs;
        histWasm[59] = perf.wasmPureSgp4Ms;
      }

      const canvas = chartRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx && count > 1) {
        ctx.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(248, 113, 113, 0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash(dashed);
        ctx.beginPath();
        ctx.moveTo(0, 4);
        ctx.lineTo(w, 4);
        ctx.stroke();
        ctx.setLineDash(solid);
        ctx.lineWidth = 1.5;
        drawLine(ctx, histTotal, count, '#34d399');
        drawLine(ctx, histWasm, count, '#38bdf8');
      }

      if (drawCallsRef.current) drawCallsRef.current.textContent = `${perf.drawCalls} calls`;
      if (ptsTrisRef.current) {
        ptsTrisRef.current.textContent = `${perf.points} pts · ${((perf.triangles / 100) | 0) / 10}k tris`;
      }
      if (wasmMemRef.current) {
        wasmMemRef.current.textContent = `${(perf.wasmMemoryBytes / (1024 * 1024)).toFixed(2)} MB`;
      }
      if (jsHeapRef.current) {
        jsHeapRef.current.textContent = perf.jsHeapMb
          ? `${perf.jsHeapMb.toFixed(1)} MB (+${smoothedAllocKbPerSec.toFixed(0)} KB/s · GC:${gcSweepCount})`
          : `N/A · ${perf.programs} progs`;
      }
    };

    applyPerf(latestPerfRef.current);
    return subscribePerf(applyPerf);
  }, [subscribePerf, latestPerfRef]);

  const handleGpuBench = async () => {
    if (!onRunGpuBench || benchMsg !== null) return;
    setBenchMsg('準備中…');
    try {
      const report = await onRunGpuBench((m) => setBenchMsg(m));
      setModalCopied(false);
      setManualText(JSON.stringify(report, null, 2));
    } catch (e: any) {
      setManualText(`GPU bench failed: ${e?.message ?? e}`);
    } finally {
      setBenchMsg(null);
    }
  };

  const handleCopyReport = async () => {
    const perf = latestPerfRef.current;
    const totalCpuWorkMs =
      perf.wasmPureSgp4Ms +
      perf.wasmReadoutMs +
      perf.threeBufferSyncMs +
      perf.webglRenderMs;
    const budgetUsagePct = Math.min(100, (totalCpuWorkMs / 16.667) * 100);
    const report = {
      timestamp: new Date().toISOString(),
      device: collectDeviceInfo(),
      satellitesTracked: satCount,
      fps: Number(perf.fps.toFixed(1)),
      minFps: Number(perf.minFps.toFixed(1)),
      frameIntervalMs: Number(perf.frameTimeMs.toFixed(2)),
      // frames that ended a >28 ms interval (newest last): what ran in them and in the frame before
      recentHitches: (perf.hitches ?? []).slice(),
      cpuWorkBreakdownMs: {
        totalActiveMs: Number(totalCpuWorkMs.toFixed(2)),
        moonbitWasmSgp4PureMs: Number(perf.wasmPureSgp4Ms.toFixed(2)),
        gpuPositionPath: perf.gpuPath,
        startupFullPassCalibrationMs: Number(perf.calibrationMs.toFixed(1)),
        wasmSlicesPerFrame: perf.wasmSlices,
        wasmFullPassEstimateMs: Number(perf.wasmFullPassMs.toFixed(2)),
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
    const text = JSON.stringify(report, null, 2);
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } else {
      setManualText(text);
    }
  };

  return (
    <div
      className="hud-panel perf-lite"
      style={{
        width: '100%',
        flexShrink: 0,
        padding: '13px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div className="section-header">
        <span>📊 Render & Wasm SGP4 Profiler</span>
        <div style={{ display: 'flex', gap: '5px' }}>
          {onRunGpuBench && (
            <button className="chip" onClick={handleGpuBench} disabled={benchMsg !== null}>
              🧪 GPU Bench
            </button>
          )}
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
          <div ref={fpsValRef} className="telemetry-val" style={{ color: '#34d399' }}>
            60.0
          </div>
        </div>
        <div className="telemetry-box">
          <span className="field-label">1% LOW FPS</span>
          <div ref={minFpsValRef} className="telemetry-val" style={{ color: '#38bdf8' }}>
            60.0
          </div>
        </div>
        <div className="telemetry-box">
          <span className="field-label">60Hz BUDGET</span>
          <div ref={budgetValRef} className="telemetry-val" style={{ color: '#34d399' }}>
            25%
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
          <span ref={totalMsSpanRef} style={{ fontFamily: 'monospace', color: '#f8fafc' }}>
            0.00 / 16.67 ms
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
            ref={barSgp4Ref}
            style={{ width: '0%', background: '#38bdf8' }}
            title="MoonBit SGP4 Pure Compute"
          />
          <div
            ref={barReadRef}
            style={{ width: '0%', background: '#a78bfa' }}
            title="Wasm to JS Readout"
          />
          <div
            ref={barBufRef}
            style={{ width: '0%', background: '#10b981' }}
            title="Three.js Vertex Buffer Sync"
          />
          <div
            ref={barGlRef}
            style={{ width: '0%', background: '#fb923c' }}
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
          <span ref={sgp4MsRef} style={{ fontFamily: 'monospace', fontWeight: 600 }}>
            0.00 ms
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#a78bfa' }}>● Wasm → JS FFI Readout</span>
          <span ref={readMsRef} style={{ fontFamily: 'monospace', fontWeight: 600 }}>
            0.00 ms
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#10b981' }}>
            ● Three.js Float32Buffer Sync
          </span>
          <span ref={bufMsRef} style={{ fontFamily: 'monospace', fontWeight: 600 }}>
            0.00 ms
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#fb923c' }}>● WebGL Draw Call Submit</span>
          <span ref={glMsRef} style={{ fontFamily: 'monospace', fontWeight: 600 }}>
            0.00 ms
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
        <canvas
          ref={chartRef}
          width={w * 2}
          height={h * 2}
          style={{ width: '100%', height: `${h}px`, display: 'block' }}
        />
      </div>

      {/* WebGL GPU & Memory Telemetry */}
      <div className="telemetry-grid">
        <div className="telemetry-box">
          <span className="field-label">DRAW CALLS / FRAME</span>
          <div ref={drawCallsRef} className="telemetry-val">0 calls</div>
        </div>
        <div className="telemetry-box">
          <span className="field-label">GPU POINTS / TRIS</span>
          <div ref={ptsTrisRef} className="telemetry-val" style={{ fontSize: '11px' }}>
            0 pts · 0.0k tris
          </div>
        </div>
        <div className="telemetry-box">
          <span className="field-label">WASM LINEAR MEM</span>
          <div ref={wasmMemRef} className="telemetry-val">0.00 MB</div>
        </div>
        <div className="telemetry-box">
          <span className="field-label">JS HEAP / SHADERS</span>
          <div ref={jsHeapRef} className="telemetry-val" style={{ fontSize: '11px' }}>
            N/A · 0 progs
          </div>
        </div>
      </div>
      {benchMsg !== null && (
        <div className="modal-backdrop perf-flat">
          <div className="hud-panel modal-card perf-flat">
            <div className="section-header">
              <span>GPU ベンチ実行中 (約 40 秒)</span>
            </div>
            <div style={{ fontSize: '13px', color: '#7dd3fc' }}>{benchMsg}</div>
            <div style={{ fontSize: '11px', color: '#94a3b8' }}>
              画面に触れず、このままお待ちください。
            </div>
          </div>
        </div>
      )}
      {manualText !== null && (
        <div className="modal-backdrop perf-flat" onClick={() => setManualText(null)}>
          <div
            className="hud-panel modal-card perf-flat"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="section-header">
              <span>結果 (Copy を押すか、テキストを選択してコピー)</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  className="btn active"
                  onClick={async () => setModalCopied(await copyText(manualText))}
                >
                  {modalCopied ? '✓ Copied' : '📋 Copy'}
                </button>
                <button className="btn" onClick={() => setManualText(null)}>
                  ✕
                </button>
              </div>
            </div>
            <textarea
              className="tle-textarea"
              readOnly
              value={manualText}
              onFocus={(e) => (e.target as HTMLTextAreaElement).select()}
              style={{ height: '260px' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
