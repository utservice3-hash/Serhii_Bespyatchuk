/**
 * 🗒 Слід рахунку в стрічці угоди. За макетом, який погодив Сергій, PDF стоїть у стрічці окремим записом з файлом
 * (клік відкриває рахунок). Запис з файлом — примітка `attachment` на файл, уже завантажений у сховище Kommo.
 *
 * Запасний шлях: вкладення не вдалося (файл не завантажився або Kommo відмовив) → звичайний текстовий запис, як
 * у прохід 1. Рахунок у 1С на той момент уже існує, тож угода без сліду лишитись не може. Чиста оркестрація —
 * запити передаються ззовні, щоб гейт перевірив обидва шляхи без мережі.
 */

export interface InvoiceNoteInput {
  testMode: boolean;
  numberPrint: string;
  /** Дата рахунку з 1С (`invoice_date_iso`, `YYYY-MM-DDTHH:mm:ss`). */
  date: string;
  /** Коротка назва організації з вікна (ЮТС, АвтоМув…): повна назва з 1С у назву файлу задовга. */
  orgShort: string;
  total: number;
  currency: string;
  /** «Змінити» (`updateInvoice`): той самий номер, новий PDF — позначаємо, щоб у стрічці було видно, що це не новий рахунок. */
  edited?: boolean;
}

const dmy = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso.slice(0, 10);
};

/** Підпис рахунку — і назва файлу в стрічці, і текст запасного запису. */
export function invoiceCaption(n: InvoiceNoteInput): string {
  return `${n.testMode ? "[ТЕСТ] " : ""}Рахунок 1С №${n.numberPrint} від ${dmy(n.date)} · ${n.orgShort} · ${n.total} ${n.currency}${n.edited ? " · змінено" : ""}`;
}

export type NoteResult = { kind: "file" } | { kind: "text"; why: string } | { kind: "none"; why: string };

export async function noteInvoice(n: InvoiceNoteInput, file: { uuid: string; versionUuid: string } | null, deps: {
  fileNote: (f: { uuid: string; versionUuid: string; name: string }) => Promise<void>;
  textNote: (text: string) => Promise<void>;
}): Promise<NoteResult> {
  const caption = invoiceCaption(n);
  let why = "PDF не прикріпився";
  if (file) {
    try {
      await deps.fileNote({ ...file, name: `${caption}.pdf` });
      return { kind: "file" };
    } catch (e) {
      why = `запис з файлом: ${(e as Error).message.slice(0, 200)}`;
    }
  }
  try {
    await deps.textNote(`${caption}${file ? "" : " · PDF не прикріпився, завантажте з вкладки"}`);
    return { kind: "text", why };
  } catch (e) {
    return { kind: "none", why: `примітка: ${(e as Error).message.slice(0, 200)}` };
  }
}
