import { useEffect, useState } from "react";
import type { AuthPayload } from "../../../auth";
import { fetchLoyaltyOverrides, removeLoyaltyOverride, type LoyaltyOverride } from "../../../api";
import { ClientPlansSection } from "./ClientPlansSection";
import { ReactivationSection } from "./ReactivationSection";

export function LoyaltySection({ auth }: { auth: AuthPayload | null }) {
  // Адмін: ручні правки постійних (прибрати/передати) + список менеджерів для передачі.
  const isAdmin = auth?.role === "admin";
  const [overrides, setOverrides] = useState<LoyaltyOverride[]>([]);
  const reloadOverrides = () => { fetchLoyaltyOverrides().then(setOverrides).catch(() => setOverrides([])); };
  useEffect(() => {
    if (!isAdmin) return;
    reloadOverrides();
  }, [isAdmin]);
  return (
    <>
      {/* ФАЗА A/B · новий екран за макетом.
          🪦 ПРИБРАНО 04.08.2026 (рішення власника) ТРИ БЛОКИ СТАРОГО ПОКОЛІННЯ:
            (а) «🔄 Реактивація — клієнти в роботі» (ручна таблиця 1-й/2-й контакт) —
                заміна: «Реактивація · сплячі та втрачені» з задачами й причиною закриття;
            (б) «Усі постійні клієнти (усі команди)» — заміна: «Постійні клієнти · план
                місяця» з ієрархією команда → менеджер → клієнти;
            (в) «Динаміка повторних оплат (12 міс.)» — заміна: гістограма 12 міс. У КАРТЦІ
                КЛІЄНТА (по канонічному ключу), а не однією цифрою по всьому зрізу.
          🔴 РАЗОМ ІЗ (а) прибрано кнопки «➕ в реактивацію» в картках менеджерів нижче:
          вони писали в `reactivation_clients` — таблицю, якої більше НІХТО не показує.
          Лишити їх означало б робити дані, які нікуди не потрапляють; це гірше за
          відсутність кнопки. Роути в DEAD_ROUTE_CANDIDATES, дані не чіпаємо. */}
      {auth && <ClientPlansSection auth={auth} />}
      {auth && <div style={{ height: 22 }} />}
      {auth && <ReactivationSection auth={auth} />}
      {auth && <div style={{ height: 22 }} />}

      {/* Фільтр команд прибрано разом із картками: він керував ЛИШЕ ними
          (`GET /dashboard/loyalty`). Обидва нові блоки скоупляться роллю на
          сервері, тож селект був би тумблером, який нічого не вмикає. */}

      {isAdmin && overrides.length > 0 && (
        <div className="chart-card" style={{ marginBottom: 16, borderLeft: "3px solid #d97706" }}>
          <h2 className="chart-title" style={{ marginBottom: 6 }}>🔧 Ручні правки постійних ({overrides.length})</h2>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px" }}>
            Ручні зміни поверх авто-логіки. «Скасувати» повертає авто-визначення.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table compact" style={{ fontSize: 12 }}>
              <thead><tr><th style={{ textAlign: "left" }}>Клієнт</th><th>Дія</th><th style={{ textAlign: "left" }}>Деталі</th><th /></tr></thead>
              <tbody>
                {overrides.map((o) => (
                  <tr key={o.clientKey}>
                    <td style={{ textAlign: "left" }}>{o.clientName ?? o.clientKey}</td>
                    <td>{o.hidden ? "🗑 прибрано" : o.pinnedManagerId ? "↪ передано" : o.forceRegular ? "➕ додано" : "—"}</td>
                    <td style={{ textAlign: "left", color: "var(--text-muted)" }}>{o.pinnedManagerName ? `→ ${o.pinnedManagerName}` : ""}</td>
                    <td>
                      <button onClick={() => removeLoyaltyOverride(o.clientKey).then(reloadOverrides)}
                        style={{ border: "1px solid var(--border)", background: "var(--card-bg)", color: "var(--text)", borderRadius: 6, padding: "2px 10px", cursor: "pointer", fontSize: 12 }}>
                        Скасувати
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 🪦 RepeatPlanGrid прибрано 03.08.2026 (рішення власника). Він рахував факт
          ВЛАСНИМ SQL і додавав НЕДАТОВАНИЙ знімок етапу 9 — тобто метрику ②, якої на
          екрані клієнтів бути не повинно, і знімок, що мутує минулі місяці. Заміна —
          ClientPlansSection вище (факт ① з ядра). Роут /repeat-plans-grid лишається
          живим ще один спринт і стоїть у DEAD_ROUTE_CANDIDATES з датою перегляду:
          зникнення має бути рішенням, а не наслідком. */}

      {/* 🪦 ПРИБРАНО 04.08.2026 (рішення власника): картки по кожному менеджеру
          (Постійні / Разові / Сплячі / Втрачені + три списки). Дубль без дій:
          сегменти читаються в «Постійні клієнти · план місяця» (ієрархія команда →
          менеджер → клієнти) і в «Реактивація · сплячі та втрачені», де ще й є що
          зробити — задача, виконавець, причина закриття.
          Разом із ними зник ЄДИНИЙ вхід до дії «🗑 прибрати з постійних»
          (`POST /dashboard/loyalty-override`, hidden=true). Роут ЖИВИЙ і навмисно
          НЕ оголошений мертвим: це втрачений вхід до потрібної функції, а не мертвий
          код — куди її повернути, вирішує власник. Скасувати вже наявні правки
          можна тут же, у блоці «🔧 Ручні правки постійних». */}
    </>
  );
}
