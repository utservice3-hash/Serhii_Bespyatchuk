/**
 * PNG для перевізника — лише вид зверху (рішення 10.10): шапка «авто · розміри», дата, рядок точок і розшифровка номерів.
 * Ширина 1600 px, світлі кольори незалежно від теми екрана.
 */
export interface SchemeHeader { title: string; date: string; stops: string; nums: string }
export const PNG_WIDTH = 1600, PNG_PAD = 36;

export async function renderSchemePng(svg: string, head: SchemeHeader): Promise<Blob> {
  const W = PNG_WIDTH, pad = PNG_PAD;
  const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
  const top = 74 + (head.stops ? 26 : 0) + (head.nums ? 26 : 0);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = top + img.height + pad;
  const c = cv.getContext('2d') as CanvasRenderingContext2D, F = (w: number, s: number) => `${w} ${s}px "Golos Text", Arial, sans-serif`;
  c.fillStyle = '#fff'; c.fillRect(0, 0, W, cv.height);
  c.fillStyle = '#1c1e26'; c.font = F(700, 22);
  c.fillText(head.title, pad, 46);
  c.font = F(400, 15); c.fillStyle = '#7c8090';
  c.fillText(head.date, W - pad - c.measureText(head.date).width, 46);
  let ly = 76;
  if (head.stops) { c.font = F(600, 16); c.fillStyle = '#1c1e26'; c.fillText('Точки вивантаження:  ' + head.stops, pad, ly); ly += 26; }
  if (head.nums) { c.font = F(400, 15); c.fillStyle = '#464b58'; c.fillText(head.nums, pad, ly); }
  c.drawImage(img, pad, top);
  const blob = await new Promise<Blob | null>(res => cv.toBlob(res, 'image/png'));
  if (!blob) throw new Error('PNG');
  return blob;
}

/** Звичайне завантаження файлу браузером (у дашборді). */
export async function downloadBlob(blob: Blob, filename: string): Promise<'saved'> {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return 'saved';
}
