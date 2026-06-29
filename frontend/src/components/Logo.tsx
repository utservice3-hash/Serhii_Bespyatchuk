export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="UTS"
    >
      <g fill="#c8102e">
        {/* u: left arm + rounded bottom + right arm */}
        <path d="M22 26h9v30a3 3 0 0 0 6 0V41h9v15a12 12 0 0 1-24 0z" />
        {/* top bar (T crossbar) */}
        <rect x="31" y="34" width="47" height="9" />
        {/* T stem with descender */}
        <rect x="50" y="34" width="9" height="44" />
        {/* s */}
        <path d="M78 35c-9 0-13 4-13 9 0 4 3 7 9 8 4 .7 5 1.5 5 3 0 1.7-2 2.6-5 2.6-3 0-5-1-6-2l-4 6c2 2 6 3.4 10 3.4 9 0 13-4 13-9 0-5-4-7-9-8-4-.8-5-1.4-5-2.8 0-1.4 2-2.4 5-2.4 2.5 0 4 .7 5 1.7l4-6c-2-1.6-5-3-13-3z" />
      </g>
    </svg>
  );
}
