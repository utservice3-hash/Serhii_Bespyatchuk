// ЄДИНЕ джерело правди структури форм 1×1 (типи A/Б/В) + дефолтний сид версії 1.
// Питання живуть у БД (`one_on_one_forms.questions` JSONB); цей файл — лише ПОЧАТКОВИЙ
// набір, який seedOneOnOneForms() заливає РАЗ (version 1), далі редактор у Налаштуваннях
// створює нові версії. Історія відповідей привʼязана до (type, form_version, qKey), тож
// qKey МАЄ бути стабільним і не залежати від тексту.
import type { Pool } from "pg";

export type OneOnOneType = "A" | "B" | "V";
export const ONE_ON_ONE_TYPES: OneOnOneType[] = ["A", "B", "V"];
export const TYPE_LABEL: Record<OneOnOneType, string> = {
  A: "Тімлід → Менеджер",
  B: "Керівник продажу → Тімлід",
  V: "HR → Всі",
};

// score = пікер 1-10; text = вільний текст; score_text = пікер 1-10 + текст під ним.
export type FieldType = "score" | "text" | "score_text";
export interface FormQuestion {
  qKey: string;          // СТАБІЛЬНИЙ ідентифікатор (історія тримається за ним)
  label: string;
  field: FieldType;
  quarterly?: boolean;   // питання ставиться 1 раз/квартал
}
export interface FormSection {
  key: string;
  title: string;
  note?: string;         // інформаційний блок секції (напр. «Завершення») без поля
  questions: FormQuestion[];
}
export interface FormDef {
  sections: FormSection[];
  enps?: boolean;        // тип В: блок eNPS (0-10 + причина) — структурний, не звичайне питання
  notes?: boolean;       // тип В: панель «Нотатки HR» — структурна
  /** Типи A/Б: блок «Задоволеність компанією» (1-10). СТРУКТУРНИЙ — свідомо НЕ в `sections`,
   *  тому НЕ потрапляє у scoreKeys() і НЕ впливає на overall ЗА ПОБУДОВОЮ (а не за домовленістю):
   *  інакше нові зустрічі стали б непорівнянні з історичними. Для типу В роль цього
   *  показника грає eNPS-бал. */
  satisfaction?: boolean;
}
/** Текст питання задоволеності — один на всі типи (блок структурний, не редагується як питання). */
export const SATISFACTION_LABEL = "Наскільки ти задоволений роботою в компанії? (1-10)";

// eNPS-класифікація (шкала 0-10).
export const ENPS = {
  isDetractor: (s: number) => s >= 0 && s <= 6,
  isPassive: (s: number) => s === 7 || s === 8,
  isPromoter: (s: number) => s === 9 || s === 10,
} as const;

/** score-питання типу (для overall = середнє пікерів). score_text теж має score. */
export function scoreKeys(form: FormDef): string[] {
  return form.sections.flatMap((s) => s.questions)
    .filter((q) => q.field === "score" || q.field === "score_text")
    .map((q) => q.qKey);
}

/** overall запису: A/Б = середнє наявних score-пікерів; В = eNPS-бал запису (окреме поле). */
export function computeOverall(
  type: OneOnOneType,
  form: FormDef,
  answers: Record<string, { score?: number; text?: string }>,
  enpsScore: number | null
): number | null {
  if (type === "V") return typeof enpsScore === "number" ? enpsScore : null;
  const keys = scoreKeys(form);
  const vals = keys.map((k) => answers?.[k]?.score).filter((x): x is number => typeof x === "number" && x > 0);
  return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
}

// ── Дефолтні набори (version 1) ──────────────────────────────────────────────

const FORM_A: FormDef = {
  satisfaction: true,
  sections: [
    { key: "overview", title: "Огляд", questions: [
      { qKey: "a_prev", label: "Короткий огляд обговореного на попередній зустрічі.", field: "text" },
    ] },
    { key: "productivity", title: "Оцінка продуктивності", questions: [
      { qKey: "a_prod", label: "Оціни свою продуктивність за минулий місяць (виконання плану). Які фактори допомогли/заважали і що можна вдосконалити?", field: "score_text" },
      { qKey: "a_comm_carriers", label: "Як оцінюєш свою здатність підтримувати ефективну комунікацію з перевізниками та клієнтами (1-10)? Що покращити?", field: "score_text" },
    ] },
    { key: "communication", title: "Комунікація та взаємодія", questions: [
      { qKey: "a_emotion", label: "Оціни свій емоційний стан на роботі останнім часом. Є щось, що радує чи турбує?", field: "score_text" },
      { qKey: "a_cross_team", label: "Як би оцінив комунікації з колегами між відділами/командами? Наскільки комфортна взаємодія?", field: "score_text" },
      { qKey: "a_us", label: "Як оцінюєш нашу з тобою взаємодію? Є питання чи проблеми? Як покращити?", field: "score_text" },
      { qKey: "a_improve_next", label: "Що може сприяти покращенню твого результату наступного місяця?", field: "text" },
      { qKey: "a_resources", label: "Чи бракує ресурсів або підтримки для роботи?", field: "text" },
      { qKey: "a_difficulties", label: "Труднощі/проблеми, з якими стикаєшся? Як я можу допомогти вирішити?", field: "text" },
      { qKey: "a_process", label: "Які аспекти робочого процесу можна покращити? Що б ти змінив?", field: "text" },
    ] },
    { key: "future", title: "Плани на майбутнє", questions: [
      { qKey: "a_motivation", label: "Що найбільше мотивує у твоїй ролі?", field: "text", quarterly: true },
      { qKey: "a_goals", label: "Які цілі на найближчий місяць? Як допомогти їх досягти?", field: "text" },
      { qKey: "a_overall_feel", label: "Як би оцінив загальні відчуття щодо роботи (1-10)?", field: "score" },
    ] },
    { key: "conclusions", title: "Загальні висновки та плани дій", questions: [
      { qKey: "a_summary", label: "Головні висновки, підсумок досягнень і наступні кроки.", field: "text" },
    ] },
    { key: "closing", title: "Завершення", note: "Подякуйте за зустріч і залученість.", questions: [] },
  ],
};

const FORM_B: FormDef = {
  satisfaction: true,
  sections: [
    { key: "overview", title: "Огляд", questions: [
      { qKey: "b_prev", label: "Короткий огляд обговореного на попередній зустрічі.", field: "text" },
    ] },
    { key: "productivity", title: "Оцінка продуктивності", questions: [
      { qKey: "b_team_prod", label: "Оціни продуктивність твоєї команди за минулий місяць. Які фактори? Що вдосконалити?", field: "score_text" },
      { qKey: "b_kpi", label: "Оціни виконання KPI за останній місяць. Що вдосконалити?", field: "score_text" },
    ] },
    { key: "communication", title: "Комунікація та взаємодія", questions: [
      { qKey: "b_emotion", label: "Оціни свій емоційний стан на роботі останнім часом. Є щось, що радує чи турбує?", field: "score_text" },
      { qKey: "b_team_challenges", label: "Які виклики/проблеми в управлінні командою? Як допомогти вирішити?", field: "text" },
      { qKey: "b_process", label: "Які аспекти робочого процесу можна покращити? Що б ти змінив?", field: "text" },
      { qKey: "b_resources", label: "Яких ресурсів/підтримки бракує для ефективного управління командою?", field: "text" },
      { qKey: "b_cross_leads", label: "Як би оцінив комунікації з іншими тімлідами та відділами?", field: "score_text" },
      { qKey: "b_us", label: "Як оцінюєш нашу з тобою взаємодію? Є питання чи проблеми? Як покращити?", field: "score_text" },
      { qKey: "b_support", label: "Наскільки відчуваєш підтримку та визнання за зусилля й досягнення?", field: "score_text" },
    ] },
    { key: "future", title: "Плани на майбутнє", questions: [
      { qKey: "b_leadership", label: "Як оцінюєш свої навички лідерства та здатність мотивувати команду (1-10)?", field: "score", quarterly: true },
      { qKey: "b_goals", label: "Які цілі на місяць як керівника команди? Як допомогти?", field: "text" },
      { qKey: "b_motivation", label: "Що найбільше мотивує у ролі тімліда?", field: "text", quarterly: true },
      { qKey: "b_development", label: "Як оцінюєш свій професійний розвиток за місяць? Напрямки для розвитку?", field: "text" },
      { qKey: "b_overall_feel", label: "Як би оцінив загальні відчуття щодо роботи (1-10)?", field: "score" },
    ] },
    { key: "conclusions", title: "Загальні висновки та плани дій", questions: [
      { qKey: "b_summary", label: "Головні висновки, підсумок досягнень і наступні кроки.", field: "text" },
    ] },
    { key: "closing", title: "Завершення", note: "Подякуйте за зустріч і залученість.", questions: [] },
  ],
};

const FORM_V: FormDef = {
  enps: true,
  notes: true,
  sections: [
    { key: "intro", title: "Знайомство", questions: [
      { qKey: "v_about", label: "Розкажи трохи про себе.", field: "text" },
      { qKey: "v_tenure", label: "Як давно працюєш у компанії?", field: "text" },
      { qKey: "v_likes", label: "Що найбільше подобається у роботі?", field: "text" },
    ] },
    { key: "work", title: "Робота", questions: [
      { qKey: "v_works_well", label: "Що працює особливо добре?", field: "text" },
      { qKey: "v_improve", label: "Що можна покращити?", field: "text" },
      { qKey: "v_blockers", label: "Що заважає працювати ефективніше?", field: "text" },
      { qKey: "v_resources", label: "Чи вистачає інформації та ресурсів?", field: "text" },
    ] },
    { key: "team", title: "Команда та менеджмент", questions: [
      { qKey: "v_team", label: "Як взаємодія в команді?", field: "text" },
      { qKey: "v_other_depts", label: "Наскільки комфортно з іншими відділами?", field: "text" },
      { qKey: "v_manager_support", label: "Чи достатньо підтримки від керівника?", field: "text" },
      { qKey: "v_expectations", label: "Чи зрозумілі очікування?", field: "text" },
      { qKey: "v_feedback", label: "Чи достатньо зворотного звʼязку?", field: "text" },
    ] },
    { key: "development", title: "Розвиток", questions: [
      { qKey: "v_learn", label: "Чи є чого хотілося б навчитися?", field: "text" },
    ] },
    { key: "closing", title: "Завершення", questions: [
      { qKey: "v_change_one", label: "Якби змінив одну річ у компанії завтра — що б це було?", field: "text" },
      { qKey: "v_hr_help", label: "Чим я як HR можу бути корисною?", field: "text" },
      { qKey: "v_anything_else", label: "Чи є щось, про що я не запитала, але важливе?", field: "text" },
    ] },
  ],
};

export const DEFAULT_FORMS: Record<OneOnOneType, FormDef> = { A: FORM_A, B: FORM_B, V: FORM_V };

/**
 * РАЗОВЕ доливання блоку «Задоволеність» у типи A/Б для БД, посіяних ДО його появи.
 * Створює НОВУ версію = поточні активні питання + прапорець (питання адміна зберігаються,
 * стара версія лишається для історії).
 *
 * 🔴 Умова — «чи БУВ КОЛИСЬ прапорець у якійсь версії», а не «чи є він у активній». Інакше
 * міграція воювала б з адміном: він свідомо вимикає блок у редакторі — а найближчий рестарт
 * мовчки вмикає назад. Разова міграція має спрацювати РАЗ і більше ніколи.
 */
export async function ensureSatisfactionBlock(pool: Pool): Promise<number> {
  let upgraded = 0;
  for (const type of ["A", "B"] as OneOnOneType[]) {
    const ever = await pool.query(
      "SELECT 1 FROM one_on_one_forms WHERE type=$1 AND (questions->>'satisfaction') = 'true' LIMIT 1", [type]);
    if (ever.rowCount) continue;                     // уже мігровано (або адмін керує сам)
    const cur = await pool.query<{ version: number; questions: FormDef }>(
      "SELECT version, questions FROM one_on_one_forms WHERE type=$1 AND is_active ORDER BY version DESC LIMIT 1", [type]);
    if (!cur.rows[0]) continue;                      // форми ще нема — її посіє seed із прапорцем
    const next: FormDef = { ...cur.rows[0].questions, satisfaction: true };
    const nv = await pool.query<{ v: number }>(
      "SELECT COALESCE(MAX(version),0)+1 AS v FROM one_on_one_forms WHERE type=$1", [type]);
    await pool.query("UPDATE one_on_one_forms SET is_active=false WHERE type=$1 AND is_active", [type]);
    await pool.query(
      `INSERT INTO one_on_one_forms (type, version, questions, is_active, created_by)
       VALUES ($1,$2,$3,true,NULL) ON CONFLICT (type, version) DO NOTHING`,
      [type, nv.rows[0].v, JSON.stringify(next)]);
    upgraded++;
  }
  return upgraded;
}

/** Сид версії 1 для кожного типу, якщо ще нема (ідемпотентно) + доливання структурних блоків. */
export async function seedOneOnOneForms(pool: Pool): Promise<void> {
  for (const type of ONE_ON_ONE_TYPES) {
    const has = await pool.query("SELECT 1 FROM one_on_one_forms WHERE type=$1 LIMIT 1", [type]);
    if (has.rowCount) continue;
    await pool.query(
      `INSERT INTO one_on_one_forms (type, version, questions, is_active, created_by)
       VALUES ($1, 1, $2, true, NULL) ON CONFLICT (type, version) DO NOTHING`,
      [type, JSON.stringify(DEFAULT_FORMS[type])]
    );
  }
  await ensureSatisfactionBlock(pool);
}
