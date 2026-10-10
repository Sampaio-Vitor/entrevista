import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { nativeImage, screen } from 'electron';

export interface Screenshot {
  base64: string;
  mediaType: 'image/png';
  width: number;
  height: number;
  /** Small PNG data URL for the UI. */
  thumbDataUrl: string;
  file: string;
  ms: number;
  /** Which monitor was captured: the one under the mouse cursor. */
  display: { id: number; label: string; index: number; bounds: Electron.Rectangle };
}

function runScreencapture(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile('/usr/sbin/screencapture', args, (err, _stdout, stderr) => {
      if (err) reject(new Error(`screencapture failed: ${stderr || err.message}. Grant Screen Recording to this app in System Settings > Privacy & Security.`));
      else resolve();
    });
  });
}

/** The display under the mouse cursor, so you point at the problem and press the hotkey. */
function displayUnderCursor(): Screenshot['display'] {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const all = screen.getAllDisplays();
  const index = Math.max(0, all.findIndex((d) => d.id === display.id)) + 1;
  const label = (display as any).label || (display.internal ? 'Tela do MacBook' : `Monitor ${index}`);
  return { id: display.id, label, index, bounds: display.bounds };
}

/**
 * Screenshot of the display under the cursor via /usr/sbin/screencapture
 * (140-190 ms on a Retina display), downscaled so the long edge stays at or
 * under `maxWidth`. Claude downsizes anything larger anyway; sending less
 * saves upload time. Needs Screen Recording permission the first time.
 *
 * `-R x,y,w,h` with the display's global bounds captures exactly that monitor
 * in any arrangement; `-D <n>` would depend on matching index orders.
 */
export async function captureScreen(dir: string, maxWidth: number): Promise<Screenshot> {
  const t0 = Date.now();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `shot-${stamp}.png`);

  const display = displayUnderCursor();
  const { x, y, width, height } = display.bounds;
  try {
    await runScreencapture(['-x', '-t', 'png', '-R', `${x},${y},${width},${height}`, file]);
  } catch (err) {
    // Fall back to the main display rather than failing the whole request.
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    await runScreencapture(['-x', '-t', 'png', file]);
  }
  if (!fs.existsSync(file)) {
    throw new Error('screencapture produced no file. Check Screen Recording permission.');
  }

  let img = nativeImage.createFromPath(file);
  if (img.isEmpty()) throw new Error('screenshot is empty (permission denied?)');
  const size = img.getSize();
  if (size.width > maxWidth) {
    img = img.resize({ width: maxWidth, quality: 'good' });
  }
  const png = img.toPNG();
  const final = img.getSize();
  const thumb = img.resize({ width: 320, quality: 'good' });

  return {
    base64: png.toString('base64'),
    mediaType: 'image/png',
    width: final.width,
    height: final.height,
    thumbDataUrl: thumb.toDataURL(),
    file,
    ms: Date.now() - t0,
    display,
  };
}
