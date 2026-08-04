/**
 * Лого UTS — червона плашка з білим «UTS» (макет 04.08.2026, рішення власника).
 *
 * Було: рукописна гліф-конструкція u/T/s червоним по прозорому. У темному
 * сайдбарі вона читалась як три окремі штрихи, а не як знак. Плашка дає єдиний
 * силует і той самий вигляд на будь-якому фоні — саме тому в макеті вона.
 *
 * ⚠️ `size` — це ВИСОТА; ширина рахується від неї (плашка ширша за квадрат).
 * Усі місця виклику (сайдбар 28, логін 40) масштабуються без правок.
 *
 * 🔴 Фавікон `public/favicon.svg` — ОКРЕМИЙ файл і тут НЕ зачіпається:
 * у вкладці браузера 16×16 слово «UTS» нечитне, тож там свій знак.
 */
export function Logo({ size = 32 }: { size?: number }) {
  const w = Math.round(size * 2.05);
  return (
    <svg
      width={w}
      height={size}
      viewBox="0 0 82 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="UTS"
    >
      <rect width="82" height="40" rx="9" fill="#c8102e" />
      <text
        x="41"
        y="27.5"
        textAnchor="middle"
        fill="#fff"
        fontFamily="system-ui, 'Segoe UI', Roboto, sans-serif"
        fontSize="20"
        fontWeight="800"
        letterSpacing="1.5"
      >
        UTS
      </text>
    </svg>
  );
}
