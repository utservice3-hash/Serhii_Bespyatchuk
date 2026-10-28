// Тести пакета `tests/bankIdent.test.ts` ДОСЛІВНО; змінено лише імпорти й вигаданий IBAN (репозиторій публічний).
import { describe, expect, it } from '../../cargo/testkit/shim.js';
import {
  RIGHTS, baseStatus, buildState, checkComment, checkInvoiceNo, checkNotClient, checkReason, conflictMsg, defaultCan, inScope, isOwnTransfer,
  normNo, type IdentRow, type IdentRules, type IdentState, type TxLite,
} from '../bankIdent.js';
import { kyiv } from '../identDeadline.js';
// [дашборд] клієнтські модулі — з ДЖЕРЕЛА ФРОНТУ (frontMods транспілює frontend/src/bankIdent/client/bankIdent/*)
import { format, identFilterMount, identLineMount, outCommentsMount } from './frontMods.js';
const { identLineHtml, newIdentUi, histLineHtml } = identLineMount;
const { identAccent, identFilterHtml } = identFilterMount;
const { outCommentsHtml, newOutUi } = outCommentsMount;
const { fDue, fDueAt, fLeft } = format;

const K = (d: number, hh = 0, mm = 0) => kyiv(2026, 10, d, hh, mm);
const R: IdentRules = { accountIds: [3, 4, 11], identFrom: K(19), hours: 48, holidays: new Set(), ownIbans: new Set(['UA000000000000000000000000099']), ownNames: ['беспятчук'] };
const tx = (o: Partial<TxLite> = {}): TxLite => ({ id: 1, accountId: 3, incoming: true, bookedAt: K(27, 12, 13), seenAt: null, counterpartyName: 'Литвиненко Ярослав', counterpartyIban: null, purpose: 'вантажне перевезення', ...o });
const NOW = K(27, 13, 30);
const all = { tag: true, fix: true, nc: true };
const none = { tag: false, fix: false, nc: false };

describe('права за замовчуванням (коди ролей дашборда)', () => {
  it('менеджер і тімлід вписують №; фінансист змінює; бухгалтер — «не оплата» і коментарі; адмін — усе', () => {
    expect(defaultCan('manager', 'tag_bank_invoice')).toBe(true);
    expect(defaultCan('team_lead', 'tag_bank_invoice')).toBe(true);
    expect(defaultCan('manager', 'fix_bank_invoice')).toBe(false);
    expect(defaultCan('finance', 'fix_bank_invoice')).toBe(true);
    expect(defaultCan('finance', 'bank_out_comments')).toBe(false);
    expect(defaultCan('accounting', 'mark_bank_not_client')).toBe(true);
    expect(defaultCan('accounting', 'bank_out_comments')).toBe(true);
    expect(defaultCan('accounting', 'tag_bank_invoice')).toBe(false);
    for (const k of Object.keys(RIGHTS) as Array<keyof typeof RIGHTS>) expect(defaultCan('admin', k)).toBe(true);
    for (const r of ['ceo', 'kvp', 'hr', 'candidate', '', null, undefined]) expect(defaultCan(r, 'bank_out_comments')).toBe(false);
  });
});

describe('статуси', () => {
  it('під правилом — лише вхідні на 3 рахунках після запуску', () => {
    expect(inScope(tx(), R)).toBe(true);
    expect(inScope(tx({ accountId: 1 }), R)).toBe(false);                 // ТОВ ЮТС
    expect(inScope(tx({ incoming: false }), R)).toBe(false);              // вихідний
    expect(inScope(tx({ bookedAt: K(18, 23, 59) }), R)).toBe(false);      // до запуску
    expect(baseStatus(tx({ accountId: 1 }), null, NOW, R)).toBeNull();
  });
  it('чекає → строк минув → «неідентифікований» (треба зафіксувати)', () => {
    expect(baseStatus(tx(), null, NOW, R)).toMatchObject({ status: 'wait', deadline: K(29, 12, 13) });
    expect(baseStatus(tx({ bookedAt: K(23, 10, 5) }), null, NOW, R)).toMatchObject({ status: 'unidentified', expiredNow: true, deadline: K(27, 10, 5) });
  });
  it('свої перекази: наш IBAN, власник ФОП, «між власними рахунками»', () => {
    expect(isOwnTransfer(tx({ counterpartyIban: 'UA00 0000 0000 0000 0000 0000 0009 9' }), R)).toBe(true);
    expect(isOwnTransfer(tx({ counterpartyName: 'Беспятчук Сергій Степанович' }), R)).toBe(true);
    expect(isOwnTransfer(tx({ purpose: 'Переказ між власними рахунками' }), R)).toBe(true);
    expect(isOwnTransfer(tx({ purpose: 'Поповнення рахунку в іншому банку' }), R)).toBe(false); // може бути й клієнт — не вгадуємо
    expect(baseStatus(tx({ counterpartyName: 'Беспятчук Сергій', bookedAt: K(20, 9) }), null, NOW, R)).toMatchObject({ status: 'own' });
  });
  it('збережений рядок важить більше за обчислення', () => {
    const row: IdentRow = { txId: 1, accountId: 3, bookedAt: new Date(K(23, 10, 5)).toISOString(), status: 'identified', invoiceNo: '8568', firstBy: null, firstAt: null,
      by: { id: 'u1', name: 'Марина К.', role: 'manager' }, at: new Date(K(23, 11)).toISOString(), reason: null, note: null, unidKind: null, deadlineAt: new Date(K(27, 10, 5)).toISOString(), changed: false };
    expect(baseStatus(tx({ bookedAt: K(23, 10, 5) }), row, NOW, R)).toMatchObject({ status: 'identified' });
  });
  it('права в стані: вписати — лише поки чекає; змінити — лише з номером', () => {
    const w = buildState(tx(), null, baseStatus(tx(), null, NOW, R)!, all, 0);
    expect(w.can).toEqual({ set: true, fix: false, nc: true });
    expect(buildState(tx(), null, baseStatus(tx(), null, NOW, R)!, none, 0).can).toEqual({ set: false, fix: false, nc: false });
    const exp = buildState(tx({ bookedAt: K(23, 10, 5) }), null, baseStatus(tx({ bookedAt: K(23, 10, 5) }), null, NOW, R)!, all, 0);
    expect(exp).toMatchObject({ status: 'unidentified', unidKind: 'expired', can: { set: false, fix: false, nc: false } });
  });
});

describe('перевірки вводу', () => {
  it('№ — вільний текст, але з цифрою', () => {
    expect(checkInvoiceNo('')).toMatch(/Впишіть/);
    expect(checkInvoiceNo('  ок ')).toMatch(/цифра/);
    expect(checkInvoiceNo('62788831')).toBe('');
    expect(checkInvoiceNo('8707, 8710')).toBe('');
    expect(checkInvoiceNo('1'.repeat(121))).toMatch(/120/);
    expect(normNo('  № 8707   від 20.10 ')).toBe('№ 8707 від 20.10');
  });
  it('причина, «не оплата клієнта», коментар', () => {
    expect(checkReason(' ')).toMatch(/причину/);
    expect(checkNotClient('Інше', '')).toMatch(/Інше/);
    expect(checkNotClient('Повернення коштів', '')).toBe('');
    expect(checkNotClient('Щось', 'x')).toMatch(/Оберіть/);
    expect(checkComment('')).toMatch(/порожній/);
    expect(checkComment('x'.repeat(1001))).toMatch(/1000/);
  });
  it('тексти конфліктів — за актуальним станом', () => {
    const base = buildState(tx(), null, baseStatus(tx(), null, NOW, R)!, all, 1);
    expect(conflictMsg({ ...base, status: 'identified', invoiceNo: '62788831', firstBy: { id: 'u', name: 'Марина К.', role: 'manager' } })).toBe('Номер уже зафіксовано: № 62788831 — Марина К.');
    expect(conflictMsg({ ...base, status: 'identified', invoiceNo: '8568', firstBy: { id: 'u', name: 'Олена Шевчук', role: 'finance' } })).toBe('Номер уже зафіксовано: № 8568 — Олена Шевчук.');
    expect(conflictMsg({ ...base, status: 'unidentified', unidKind: 'expired' })).toMatch(/Строк минув/);
    expect(conflictMsg({ ...base, status: 'own' })).toMatch(/свій переказ/);
  });
});

describe('інтерфейс рядка (html)', () => {
  const st = (o: Partial<IdentState> = {}): IdentState => ({ ...buildState(tx(), null, baseStatus(tx(), null, NOW, R)!, all, 0), ...o });
  it('строк: «до чт 29.10, 12:13 · ще 46 год»; вихідні — «до кінця вт»', () => {
    expect(fDue(K(29, 12, 13))).toBe('чт 29.10, 12:13');
    expect(fDue(K(28))).toBe('кінця вт 27.10');
    expect(fDueAt(K(28))).toBe('кінець вт 27.10');
    expect(fLeft(90 * 60_000)).toBe('ще 1 год 30 хв');
    expect(fLeft(46 * 3_600_000 + 43 * 60_000)).toBe('ще 46 год');
    expect(fLeft(25 * 60_000)).toBe('ще 25 хв');
    const h = identLineHtml(st(), newIdentUi(), NOW);
    expect(h).toContain('data-bf="no"');
    expect(h).toContain('до <b>чт 29.10, 12:13</b> · ще 46 год');
    expect(h).toContain('Не оплата клієнта');
  });
  it('без права — «чекає № від менеджера», без поля', () => {
    const h = identLineHtml(st({ can: { set: false, fix: false, nc: false } }), newIdentUi(), NOW);
    expect(h).not.toContain('data-bf="no"');
    expect(h).toContain('чекає № рахунку від менеджера');
  });
  it('з номером: фінансисту — «Змінити» і «Визнати неідентифікованим»; менеджеру — нічого', () => {
    const ok = st({ status: 'identified', invoiceNo: '62803117', by: { id: 'u', name: 'Андрій П.', role: 'manager' }, at: new Date(K(27, 11, 10)).toISOString(), events: 1 });
    const fin = identLineHtml({ ...ok, can: { set: false, fix: true, nc: false } }, newIdentUi(), NOW);
    expect(fin).toContain('✓ № <span class="bi-no">62803117</span>');
    expect(fin).toContain('Андрій П., 27.10, 11:10');
    expect(fin).toContain('data-bi="fix"');
    expect(fin).toContain('data-bi="unid"');
    const man = identLineHtml({ ...ok, can: { set: false, fix: false, nc: false } }, newIdentUi(), NOW);
    expect(man).not.toContain('data-bi="fix"');
    expect(man).toContain('Історія');
  });
  it('неідентифікований: за строком і визнаний фінансистом', () => {
    const e = identLineHtml(st({ status: 'unidentified', unidKind: 'expired', deadlineAt: new Date(K(27, 10, 5)).toISOString(), can: { set: false, fix: false, nc: false } }), newIdentUi(), NOW);
    expect(e).toContain('строк минув — вт 27.10, 10:05 · номер уже не вписати');
    const f = identLineHtml(st({ status: 'unidentified', unidKind: 'finance', by: { id: 'u', name: 'Олена Шевчук', role: 'finance' }, at: new Date(K(22, 10)).toISOString(), reason: 'номер вигаданий' }), newIdentUi(), NOW);
    expect(f).toContain('визнано: Олена Шевчук, 22.10, 10:00 · «номер вигаданий»');
  });
  it('екранування: ввід користувача не стає розміткою', () => {
    const h = identLineHtml(st({ status: 'identified', invoiceNo: '<img src=x onerror=alert(1)>1', by: { id: 'u', name: '<b>x</b>', role: 'manager' }, at: new Date(NOW).toISOString() }), newIdentUi(), NOW);
    expect(h).not.toContain('<img');
    expect(h).toContain('&lt;img');
    expect(histLineHtml({ id: 1, at: new Date(NOW).toISOString(), by: { id: 'u', name: '<i>x</i>', role: 'finance' }, act: 'change', fromNo: '1', toNo: '<2>', reason: '"', note: null })).not.toContain('<i>');
    expect(outCommentsHtml({ count: 1, last: { id: 1, at: new Date(NOW).toISOString(), by: { id: 'u', name: 'Людмила', role: 'accounting' }, body: '<script>x</script>' } }, newOutUi())).not.toContain('<script>');
  });
  it('ліва смуга: бурштинова лише коли «горить» і користувач може вписати', () => {
    const soon = st({ deadlineAt: new Date(K(27, 15)).toISOString() });
    expect(identAccent(soon, NOW)).toMatch(/--warn/);
    expect(identAccent({ ...soon, can: { set: false, fix: false, nc: true } }, NOW)).toBe('transparent');
    expect(identAccent(st(), NOW)).toBe('transparent');
    expect(identAccent(null, NOW)).toBe('transparent');
  });
  it('фільтр — з лічильниками', () => {
    const h = identFilterHtml({ wait: 7, unidentified: 3, identified: 4, not_client: 1, badge: 7 }, 'wait');
    expect(h).toContain('Чекають № <span class="bi-n bi-n-warn">7</span>');
    expect(h).toContain('aria-pressed="true"');
  });
});
