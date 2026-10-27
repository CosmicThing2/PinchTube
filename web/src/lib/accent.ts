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

const ACCENT_KEY = 'ytm-accent';
const SPONSOR_KEY = 'ytm-sponsor';

export function isCustomColour(value: string | undefined): boolean {
  return /^#[0-9a-f]{6}$/i.test(value ?? '');
}

export function colourOf(presets: ColourPreset[], value: string | undefined, fallback: string): string {
  if (isCustomColour(value)) return value!.toLowerCase();
  return presets.find((preset) => preset.id === value)?.color ?? presets.find((p) => p.id === fallback)!.color;
}

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
