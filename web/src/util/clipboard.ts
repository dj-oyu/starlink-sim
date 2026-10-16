/**
 * Copy text to the clipboard, including on plain-HTTP origins (e.g. a dev server
 * opened from a phone over the LAN) where `navigator.clipboard` does not exist.
 * Must be called from a user gesture (tap/click). Resolves to whether it worked.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  // Off-screen but still selectable; font-size >= 16px stops iOS from zooming.
  ta.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;';
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS Safari ignores select() alone
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}

/** Facts about the device/browser that matter when diagnosing rendering speed. */
export function collectDeviceInfo(): Record<string, unknown> {
  const info: Record<string, unknown> = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    devicePixelRatio: window.devicePixelRatio,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    screen: `${screen.width}x${screen.height}`,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGB: (navigator as any).deviceMemory ?? null,
    secureContext: window.isSecureContext,
  };
  try {
    const canvas = document.querySelector<HTMLCanvasElement>('.canvas-wrapper canvas');
    if (canvas) {
      info.drawingBuffer = `${canvas.width}x${canvas.height}`;
      const gl = (canvas.getContext('webgl2') ||
        canvas.getContext('webgl')) as WebGLRenderingContext | null;
      if (gl) {
        info.webglVersion = gl.getParameter(gl.VERSION);
        info.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        info.gpu = ext
          ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER);
      }
    }
  } catch {
    // diagnostics only; never fail the report
  }
  return info;
}
