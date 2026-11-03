/*
 * accent.ts — the user's accent and SponsorBlock colours.
 *
 * The colours are applied by setting CSS variables (--accent,
 * --accent-contrast, --sponsor) on the page, which styles/app.css uses
 * everywhere. Also works out whether text on the accent colour should be
 * white or dark, and keeps a copy in the browser so main.tsx can paint the
 * right colours before sign-in finishes. Chosen in pages/Settings.tsx;
 * applied from lib/app-context.tsx whenever settings load or change.
 */

/**
 * The user's colours: the accent (buttons, switches, progress bars and
 * highlights) and the tint for SponsorBlock segments. Each preset is a
 * mid-tone that reads on both the light and the dark theme; the server stores
 * either a preset's id or a custom colour as #rrggbb.
 */
export interface ColourPreset {
  id: string;
  label: string;
  color: string;
}

/** The accent choices on the Settings page. */
export const ACCENT_PRESETS: ColourPreset[] = [
  { id: 'red', label: 'Red', color: '#ff0033' },
  { id: 'orange', label: 'Orange', color: '#ea580c' },
  { id: 'amber', label: 'Amber', color: '#f59e0b' },
  { id: 'green', label: 'Green', color: '#16a34a' },
  { id: 'teal', label: 'Teal', color: '#0d9488' },
  { id: 'blue', label: 'Blue', color: '#2563eb' },
  { id: 'purple', label: 'Purple', color: '#7c3aed' },
  { id: 'pink', label: 'Pink', color: '#db2777' },
];

/** The same choices, with SponsorBlock's own lighter green as the default. */
export const SPONSOR_PRESETS: ColourPreset[] = ACCENT_PRESETS.map((preset) =>
  preset.id === 'green' ? { ...preset, color: '#69c054' } : preset,
);

// Where the browser copy is kept (localStorage).
const ACCENT_KEY = 'ytm-accent';
const SPONSOR_KEY = 'ytm-sponsor';

/** Whether a setting is a custom #rrggbb colour rather than a preset name. */
export function isCustomColour(value: string | undefined): boolean {
  return /^#[0-9a-f]{6}$/i.test(value ?? '');
}

/** The actual colour for a setting: the custom colour, the preset's, or the fallback preset's. */
export function colourOf(presets: ColourPreset[], value: string | undefined, fallback: string): string {
  if (isCustomColour(value)) return value!.toLowerCase();
  return presets.find((preset) => preset.id === value)?.color ?? presets.find((p) => p.id === fallback)!.color;
}

/** How bright a colour looks (WCAG relative luminance, 0 to 1). */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * White text unless the colour is too light for it. The 3:1 bar is the WCAG
 * one for bold UI text, and keeps white on the default red as before.
 */
export function accentText(color: string): string {
  return 1.05 / (luminance(color) + 0.05) >= 3 ? '#ffffff' : '#111114';
}

export interface Colours {
  accent?: string;
  sponsor?: string;
}

/** Sets the CSS colour variables on the page. */
export function applyColours({ accent, sponsor }: Colours): void {
  const root = document.documentElement.style;
  const accentHex = colourOf(ACCENT_PRESETS, accent, 'red');
  root.setProperty('--accent', accentHex);
  root.setProperty('--accent-contrast', accentText(accentHex));
  root.setProperty('--sponsor', colourOf(SPONSOR_PRESETS, sponsor, 'green'));
}

/** Remembered in the browser so the right colours are painted before sign-in finishes. */
export function rememberColours({ accent, sponsor }: Colours): void {
  try {
    localStorage.setItem(ACCENT_KEY, accent ?? '');
    localStorage.setItem(SPONSOR_KEY, sponsor ?? '');
  } catch {
    /* private browsing */
  }
}

/** The colours remembered in the browser, if any. */
export function readCachedColours(): Colours {
  try {
    return {
      accent: localStorage.getItem(ACCENT_KEY) || undefined,
      sponsor: localStorage.getItem(SPONSOR_KEY) || undefined,
    };
  } catch {
    return {};
  }
}
