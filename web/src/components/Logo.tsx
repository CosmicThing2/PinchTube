import { useId } from 'react';

/**
 * The PinchTube mark: a "P" with a play triangle cut out of its bowl. Drawn in
 * currentColor, so CSS decides its colour. The geometry matches the README
 * logo and the app icons.
 */
export function LogoMark({ className }: { className?: string }) {
  // useId returns values like ":r1:", which are awkward inside url(#…).
  const cut = `logo-cut-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg className={className} viewBox="14 8 92 104" aria-hidden="true" focusable="false">
      <mask id={cut}>
        <rect width="120" height="120" fill="#fff" />
        <polygon
          points="56 34 80 48 56 62"
          fill="#000"
          stroke="#000"
          strokeWidth="5"
          strokeLinejoin="round"
        />
      </mask>
      <g mask={`url(#${cut})`} fill="currentColor">
        <rect x="22" y="14" width="26" height="92" rx="13" />
        <circle cx="64" cy="48" r="34" />
        <rect x="35" y="14" width="29" height="68" />
      </g>
    </svg>
  );
}
