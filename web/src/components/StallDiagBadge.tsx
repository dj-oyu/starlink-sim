import { useEffect, useState } from 'preact/hooks';
import { copyText } from '../util/clipboard';
import {
  stallDiagClear,
  stallDiagJson,
  stallDiagStalls,
  stallDiagSubscribe,
} from '../util/stallDiag';

/** Shows up only when an auto-rotate stall has been recorded (see util/stallDiag.ts). */
export function StallDiagBadge() {
  const [count, setCount] = useState(stallDiagStalls());
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => stallDiagSubscribe(() => setCount(stallDiagStalls())), []);
  if (count === 0) return null;

  const copy = async () => setMsg((await copyText(stallDiagJson())) ? 'コピーしました' : 'コピーできませんでした');
  const save = () => {
    const url = URL.createObjectURL(new Blob([stallDiagJson()], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stall-diag.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div class="stall-diag">
      <button type="button" onClick={() => setOpen((v) => !v)}>
        ⚠ 自動回転停止の記録 ({count})
      </button>
      {open && (
        <div class="stall-diag-panel">
          <div class="stall-diag-actions">
            <button type="button" onClick={copy}>コピー</button>
            <button type="button" onClick={save}>保存</button>
            <button
              type="button"
              onClick={() => {
                stallDiagClear();
                setOpen(false);
              }}
            >
              消去
            </button>
            <span>{msg}</span>
          </div>
          <pre>{stallDiagJson()}</pre>
        </div>
      )}
    </div>
  );
}
