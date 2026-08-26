import { Component, type ReactNode } from "react";

/**
 * 🛡 ОДИН ЗЛАМАНИЙ РЯДОК НЕ МАЄ КОШТУВАТИ ВСЬОГО ЕКРАНА.
 *
 * 🔴 ПРИВІД — АВАРІЯ 26.08.2026. Одна нерозбірна дата в одного клієнта кинула
 * виняток усередині `.map`, і розділ дебіторки не відкривався ВЗАГАЛІ: замість
 * 76 рядків користувач бачив «Не вдалося показати цей розділ». 75 справних
 * рядків загинули разом із одним.
 *
 * 🔴 ЦЕ ДРУГИЙ РУБІЖ, А НЕ ЗАМІНА ПЕРШОМУ. Сторожі на датах лишаються: межа
 * ловить те, чого ми не передбачили, і НЕ має ховати дефект — вона показує
 * рядок як зламаний, поіменно. Тихо проковтнути помилку було б гірше за падіння:
 * тоді клієнт зникав би з таблиці, а Σ по екрану мовчки розійшлася б із плиткою.
 *
 * ⚠️ React ловить помилки рендеру лише класовим компонентом — функціональних
 * error boundary не існує. Це не «старий стиль», це єдиний доступний механізм.
 */
export class RowBoundary extends Component<
  { label: string; cols: number; children: ReactNode },
  { err: Error | null }
> {
  state: { err: Error | null } = { err: null };

  static getDerivedStateFromError(err: Error) { return { err }; }

  componentDidCatch(err: Error) {
    // У консоль — з іменем клієнта: інакше «щось зламалось» не веде до причини.
    console.error(`Рядок дебіторки «${this.props.label}» не відрендерився:`, err);
  }

  render() {
    if (!this.state.err) return this.props.children;
    return (
      <tr>
        <td colSpan={this.props.cols}
          style={{ color: "var(--danger, #b91c1c)", fontSize: "var(--fs-sm)", padding: "8px 10px" }}>
          ⚠️ Рядок «{this.props.label}» не вдалося показати: {this.state.err.message}.
          {" "}Решта таблиці нижче — ціла; повідомте розробникам саме цього клієнта.
        </td>
      </tr>
    );
  }
}
