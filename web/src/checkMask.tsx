// Before a check photo leaves the phone, the line of numbers along the bottom (the
// routing and account numbers) is covered with a black bar. The owner sees where the bar
// is, moves it if the check isn't where expected, and only the covered photo is sent:
// the full numbers reach neither the server nor Anthropic.
import { useEffect, useRef, useState } from 'react';
import { EyeOff } from 'lucide-react';
import { Button } from './ui';

// Fractions of the photo's height.
export interface Mask {
  top: number;
  height: number;
}

// Where the bottom line sits on a check that fills the photo.
const START: Mask = { top: 0.84, height: 0.12 };
const PREVIEW_SIDE = 1200;

export function CheckMasker({ file, onDone }: { file: File; onDone: (mask: Mask | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [error, setError] = useState('');
  const [mask, setMask] = useState<Mask>(START);

  useEffect(() => {
    let alive = true;
    let made: ImageBitmap | null = null;
    createImageBitmap(file)
      .then((b) => {
        made = b;
        if (alive) setBitmap(b);
        else b.close();
      })
      .catch(() => setError(`${file.name} can't be opened in this browser.`));
    return () => {
      alive = false;
      made?.close();
    };
  }, [file]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !bitmap) return;
    const scale = Math.min(1, PREVIEW_SIDE / Math.max(bitmap.width, bitmap.height));
    c.width = Math.round(bitmap.width * scale);
    c.height = Math.round(bitmap.height * scale);
    const context = c.getContext('2d');
    if (!context) return;
    context.drawImage(bitmap, 0, 0, c.width, c.height);
    context.fillStyle = '#000';
    context.fillRect(0, mask.top * c.height, c.width, mask.height * c.height);
  }, [bitmap, mask]);

  const clamp = (m: Mask): Mask => {
    const height = Math.min(0.5, Math.max(0.03, m.height));
    return { height, top: Math.min(1 - height, Math.max(0, m.top)) };
  };
  // A tap on the photo puts the bar's middle there.
  const place = (clientY: number) => {
    const c = canvas.current;
    if (!c) return;
    const box = c.getBoundingClientRect();
    setMask((m) => clamp({ ...m, top: (clientY - box.top) / box.height - m.height / 2 }));
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950/90 p-3 sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-label="Hide the account number">
      <div className="mx-auto flex max-h-full w-full max-w-2xl flex-col overflow-y-auto rounded-lg bg-white p-4 shadow-xl dark:bg-slate-900">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <EyeOff className="size-5" aria-hidden /> Hide the account number
        </h2>
        <p className="mt-1 mb-3 text-sm text-slate-600 dark:text-slate-300">
          Make sure the black bar covers the line of numbers along the bottom of the check. Tap the photo to move it there. Only the covered photo is sent.
        </p>
        {error ? (
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        ) : (
          <canvas
            ref={canvas}
            className="mx-auto max-h-[55vh] w-auto max-w-full cursor-crosshair touch-none rounded border border-slate-200 dark:border-slate-700"
            onPointerDown={(e) => place(e.clientY)}
            onPointerMove={(e) => e.buttons === 1 && place(e.clientY)}
            aria-label="The check, with the bar shown in black"
          />
        )}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-slate-600 dark:text-slate-300">Bar position</span>
            <input type="range" min={0} max={0.97} step={0.005} value={mask.top} onChange={(e) => setMask((m) => clamp({ ...m, top: Number(e.target.value) }))} className="w-full" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-600 dark:text-slate-300">Bar height</span>
            <input type="range" min={0.03} max={0.5} step={0.005} value={mask.height} onChange={(e) => setMask((m) => clamp({ ...m, height: Number(e.target.value) }))} className="w-full" />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" className="min-h-11 sm:min-h-9" disabled={!bitmap} onClick={() => onDone(mask)}>
            Covered: send it
          </Button>
          <Button className="min-h-11 sm:min-h-9" onClick={() => onDone(null)}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
