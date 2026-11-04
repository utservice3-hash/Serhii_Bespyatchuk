/**
 * Обхідний лист у кабінеті працівника (макет `c02-home.js`, `clearBlock` / `leaveBlock`): «що зробити вам» + підписи
 * відповідальних за бланком компанії. Скріншоти повідомлень клієнтам — `sendShots` (файл → data URL, PNG/JPG до 2 МБ).
 */
import { useRef, useState } from "react";
import { errText, payrollApi, type Obj } from "../api";
import { Pill, readDataUrl } from "../ui";
import { useToast } from "../../components/Toasts";
import { Block } from "./Block";
import { dd, ddy, dt, plural } from "./format";

const MAX = 2 * 1024 * 1024;

export function ClearanceList({ c, onSent }: { c: Obj; onSent: () => Promise<void> | void }) {
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const items = (c.items ?? []) as Obj[];
  const sig = (k: string) => items.find((x) => x.key === k)?.signature as Obj | null | undefined;
  const nClients = ((c.clients ?? []) as string[]).length;
  const shots = c.shots as Obj | null;

  async function send(files: FileList | null) {
    if (!files?.length) return;
    const list = [...files];
    if (list.some((f) => !/^image\/(png|jpe?g|webp)$/.test(f.type) || f.size > MAX)) { toast("Скріншоти — зображення PNG / JPG до 2 МБ кожне.", { error: true }); return; }
    setBusy(true);
    try {
      const urls = await Promise.all(list.map(readDataUrl));
      const r = await payrollApi.sendShots(urls);
      toast(`Скріншоти надіслано тім-ліду (усього ${r?.n ?? urls.length}).`);
      await onSent();
    } catch (e) { toast(errText(e), { error: true }); }
    finally { setBusy(false); if (file.current) file.current.value = ""; }
  }

  return (
    <div className="zc-clr">
      <div className="zc-clr__head">
        <b>Обхідний лист</b>
        <Pill tone={c.final ? "ok" : c.ok ? "ok" : "warn"}>{c.final ? `закрито ${dd((c.items as Obj[]).find((x) => x.final)?.signature?.at)}` : `підписано ${c.done} з ${c.total}`}</Pill>
      </div>
      {!c.ok && (
        <>
          <div className="zp-k">Що зробити вам</div>
          <ul className="zc-clr__list">
            <li className={shots ? "is-ok" : ""}>
              <b>Повідомити клієнтів письмово (месенджер) і надіслати скріншоти тім-ліду</b>
              <span>{shots ? `надіслано ${dt(shots.at)}: ${shots.n} з ${nClients} ${plural(nClients, "клієнта", "клієнтів", "клієнтів")}` : `клієнтів: ${nClients}`}</span>
              <em>
                <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => void send(e.target.files)} />
                {shots && shots.n >= nClients ? "готово" : <button type="button" className="zp-btn zp-btn--sm" disabled={busy} onClick={() => file.current?.click()}>{busy ? "Надсилаємо…" : shots ? "Додати скріншоти" : "Надіслати скріншоти"}</button>}
              </em>
            </li>
            <li className={sig("trucks") ? "is-ok" : ""}>
              <b>Допомогти новому відповідальному поставити машини по кожному клієнту</b>
              <span>до дня звільнення — {dd(c.leave?.date)}</span>
              <em>{sig("trucks") ? "готово" : ""}</em>
            </li>
            <li className={sig("tech") ? "is-ok" : ""}>
              <b>Повернути техніку бізнес-асистенту за актом ТМЦ</b>
              <span>ноутбук / комп’ютер, навушники, телефон</span>
              <em>{sig("tech") ? "готово" : ""}</em>
            </li>
          </ul>
        </>
      )}
      <div className="zp-k">Підписи відповідальних</div>
      <ul className="zc-clr__list">
        {items.map((x) => {
          const s = x.signature as Obj | null;
          const lock = x.final && !c.ok;
          return (
            <li key={x.key} className={s ? "is-ok" : ""}>
              <b>{x.n}. {x.title}</b>
              <span>{x.roleLabel} · {x.responsible?.name ?? "відповідального не призначено"}</span>
              <em>{s ? `підписано ${dt(s.at)}` : lock ? "після всіх підписів" : "чекає підпису"}</em>
            </li>
          );
        })}
      </ul>
      <p className="zp-hint">
        {c.final ? "Розрахунок погоджено ОД — фінансист виплачує за вашою формою."
          : c.ok ? "Усі пункти підписано — подайте форму на виплату; виплата після погодження ОД (п. 9)."
            : "Форма на виплату — після всіх підписів; розрахунок погоджує ОД (п. 9)."}
      </p>
    </div>
  );
}

/** Блок «Звільнення …» на «Огляді» (лише в місяці звільнення). */
export function LeaveBlock({ me, onChanged }: { me: Obj; onChanged: () => Promise<void> | void }) {
  const L = me.employee?.leave as Obj | null;
  const c = me.clearance as Obj | null;
  if (!L) return null;
  const label = c?.leave?.label ?? "звільнення";
  const rule = c?.leave?.rule as string | undefined;
  return (
    <Block id="leave" tone="warn" title={`Звільнення ${ddy(L.date)}`} aside={<Pill tone="warn">{label}</Pill>}>
      {rule && <p className="zc-p">{rule[0].toUpperCase() + rule.slice(1)}.</p>}
      {c ? <ClearanceList c={c} onSent={onChanged} /> : <p className="zp-hint">Обхідний лист зʼявиться, щойно фінансист його створить.</p>}
    </Block>
  );
}
