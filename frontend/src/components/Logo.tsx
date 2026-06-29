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
      <g stroke="#c8102e" strokeWidth="9" fill="none" strokeLinecap="square">
        <path d="M20 28v30a13 13 0 0 0 13 13 13 13 0 0 0 13-13V44h38" />
        <path d="M50 44v38" />
        <path d="M62 80c6 0 18 0 18-11s-18-9-18-17 12-12 18-12" />
      </g>
    </svg>
  );
}
