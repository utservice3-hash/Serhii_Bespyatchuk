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
      <path
        d="M18 28v32a14 14 0 0 0 14 14 14 14 0 0 0 14-14V46h40"
        stroke="#c5141c"
        strokeWidth="9"
        strokeLinecap="square"
        fill="none"
      />
      <path d="M50 46v36" stroke="#c5141c" strokeWidth="9" />
      <path
        d="M64 80c5 0 18 0 18-12s-18-10-18-18 13-12 18-12"
        stroke="#c5141c"
        strokeWidth="9"
        strokeLinecap="square"
        fill="none"
      />
    </svg>
  );
}
