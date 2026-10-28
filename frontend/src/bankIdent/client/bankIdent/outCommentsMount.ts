/**
 * Коментарі до вихідних ФОП Беспятчук (Моно, Приват) — бачать і пишуть лише бухгалтер і адмін (рішення Сергія 27.10).
 *   const h = mountOutComments(el, { txId, summary, api: bankIdentApi, onChange });
 * Монтуйте ЛИШЕ коли є summary з POST /comments/summary: сервер віддає його тільки тим, у кого є право,
 * іншим — 403, і тоді під вихідними нічого не зʼявляється (навіть позначки, що коментарі є).
 */
import { checkComment, normText, roleLabel, type CommentSummary, type OutComment } from '../../shared/bankIdent';
import { clip, esc, fDT, plural } from './format';
import type { BankIdentApi } from './types';

export interface OutCommentsUi { open: boolean; list: OutComment[] | null; loadErr: string; draft: string; err: string; busy: boolean }
export const newOutUi = (): OutCommentsUi => ({ open: false, list: null, loadErr: '', draft: '', err: '', busy: false });

export const DEFAULT_PRIVACY = '🔒 адмін і бухгалтер';

export function outCommentsHtml(sum: CommentSummary, ui: OutCommentsUi, privacy = DEFAULT_PRIVACY): string {
  const n = sum.count;
  if (!ui.open) {
    const last = sum.last;
    return `<div class="bi-line"><button type="button" class="bi-lnk" data-bc="open" aria-expanded="false">💬 ${n ? `${n} ${plural(n, 'коментар', 'коментарі', 'коментарів')}` : 'Додати коментар'}</button>`
      + (last ? `<span class="bi-by"><b>${esc(last.by.name)}</b>, ${fDT(last.at)}: «${esc(clip(last.body, 72))}»</span>` : '')
      + `<span class="bi-priv">${esc(privacy)}</span></div>`;
  }
  const list = ui.loadErr ? `<span class="bi-err" role="alert">${esc(ui.loadErr)}</span>`
    : !ui.list ? '<span class="bi-by">Завантаження…</span>'
    : ui.list.length ? `<ul class="bi-cms">${ui.list.map(c => `<li><div class="bi-who"><b>${esc(c.by.name)}</b>${c.by.role ? ' · ' + esc(roleLabel(c.by.role)) : ''} · ${fDT(c.at)}</div><div class="bi-tx">${esc(c.body)}</div></li>`).join('')}</ul>`
    : '';
  return `<div class="bi-box"><div class="bi-fh">Коментарі <span class="bi-by">— бачать лише ${esc(privacy.replace(/^🔒\s*/, ''))}</span></div>${list}`
    + `<div class="bi-frow"><label class="bi-grow">Новий коментар<textarea class="bi-inp bi-ta${ui.err ? ' bi-bad-b' : ''}" data-bf="draft" rows="2" maxlength="1000" placeholder="Що важливо знати про цей платіж">${esc(ui.draft)}</textarea></label></div>`
    + (ui.err ? `<span class="bi-err" role="alert">${esc(ui.err)}</span>` : '')
    + `<div class="bi-frow"><button type="button" class="bi-btn bi-pri" data-bc="add"${ui.busy ? ' disabled' : ''}>${ui.busy ? 'Додаю…' : 'Додати коментар'}</button>`
    + `<button type="button" class="bi-btn bi-ghost" data-bc="close"${ui.busy ? ' disabled' : ''}>Згорнути</button></div></div>`;
}

export interface OutCommentsOptions {
  txId: number;
  summary: CommentSummary;
  api: Pick<BankIdentApi, 'comments' | 'addComment'>;
  onChange?: (s: CommentSummary) => void;
  /** Підпис приватності (якщо в «Ролі та доступи» право дали ще комусь). */
  privacy?: string;
}
export interface OutCommentsHandle { update(p: { summary?: CommentSummary }): void; destroy(): void }

export function mountOutComments(el: HTMLElement, o: OutCommentsOptions): OutCommentsHandle {
  let sum = o.summary, alive = true;
  const ui = newOutUi();
  function render(focus = false) {
    if (!alive) return;
    el.innerHTML = `<div class="bi" data-bi-tx="${o.txId}">${outCommentsHtml(sum, ui, o.privacy)}</div>`;
    if (focus) el.querySelector<HTMLTextAreaElement>('[data-bf="draft"]')?.focus();
  }
  async function open() {
    ui.open = true; ui.list = null; ui.loadErr = ''; render(true);
    try { ui.list = await o.api.comments(o.txId); } catch (e) { ui.loadErr = e instanceof Error ? e.message : 'Не вдалося завантажити коментарі.'; }
    if (alive && ui.open) render(true);
  }
  async function add() {
    const e = checkComment(ui.draft);
    if (e) { ui.err = e; render(true); return; }
    ui.busy = true; ui.err = ''; render();
    try {
      const r = await o.api.addComment(o.txId, normText(ui.draft));
      if (!alive) return;
      ui.busy = false; ui.draft = '';
      ui.list = [...(ui.list || []), r.comment];
      sum = r.summary;
      render(true);
      o.onChange?.(sum);
    } catch (err) {
      if (!alive) return;
      ui.busy = false; ui.err = err instanceof Error ? err.message : 'Не вдалося додати коментар.'; render(true);
    }
  }
  const onClick = (e: Event) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-bc]');
    if (!b || !el.contains(b) || (b as HTMLButtonElement).disabled) return;
    const k = b.dataset.bc;
    if (k === 'open') void open();
    else if (k === 'close') { ui.open = false; ui.err = ''; render(); el.querySelector<HTMLElement>('[data-bc="open"]')?.focus(); }
    else if (k === 'add') void add();
  };
  const onInput = (e: Event) => {
    const f = e.target as HTMLTextAreaElement;
    if (f.dataset?.bf !== 'draft') return;
    ui.draft = f.value;
    if (ui.err) { ui.err = ''; el.querySelectorAll('.bi-err').forEach(x => x.remove()); f.classList.remove('bi-bad-b'); }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (e.target as HTMLElement).dataset?.bf === 'draft') { e.preventDefault(); void add(); }
  };
  el.addEventListener('click', onClick);
  el.addEventListener('input', onInput);
  el.addEventListener('keydown', onKey);
  render();
  return {
    update(p) { if (p.summary) { sum = p.summary; if (!ui.open) render(); } },
    destroy() {
      alive = false;
      el.removeEventListener('click', onClick);
      el.removeEventListener('input', onInput);
      el.removeEventListener('keydown', onKey);
      el.innerHTML = '';
    },
  };
}
