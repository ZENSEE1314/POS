// Customer app themes. A company picks a preset and may override its brand colour; both the customer app and the
// staff "App design" preview apply them by overriding the tokens.css custom properties. Keep the preset names in sync
// with THEME_PRESETS in src/guest/theme.ts.

const SANS = 'var(--font-body)';
const SERIF = '"Palatino Linotype", "Book Antiqua", Palatino, "Songti SC", "Noto Serif CJK SC", "Noto Serif SC", SimSun, Georgia, serif';

export const PRESETS = {
  night: {
    scheme: 'dark', accent: '#f7d774', display: SERIF,
    vars: {},
  },
  midnight: {
    scheme: 'dark', accent: '#38bdf8', display: SANS,
    vars: {
      '--color-bg': '#0b1220', '--color-bg-raised': '#111a2e', '--color-bg-glow-a': 'rgba(56, 189, 248, 0.16)', '--color-bg-glow-b': 'rgba(99, 102, 241, 0.14)',
      '--color-surface': 'rgba(17, 26, 46, 0.78)', '--color-surface-solid': '#111a2e', '--color-surface-hi': 'rgba(148, 163, 184, 0.08)',
      '--color-surface-input': 'rgba(11, 18, 32, 0.8)', '--color-fg': '#dbe4f0', '--color-fg-strong': '#ffffff', '--color-muted': '#93a3bd',
      '--color-border': 'rgba(148, 163, 184, 0.18)', '--color-scrim': 'rgba(3, 7, 18, 0.72)',
    },
  },
  noir: {
    scheme: 'dark', accent: '#ffffff', display: SANS,
    vars: {
      '--color-bg': '#0a0a0a', '--color-bg-raised': '#121212', '--color-bg-glow-a': 'rgba(255, 255, 255, 0.04)', '--color-bg-glow-b': 'rgba(255, 255, 255, 0.03)',
      '--color-surface': 'rgba(24, 24, 24, 0.86)', '--color-surface-solid': '#181818', '--color-surface-hi': 'rgba(255, 255, 255, 0.06)',
      '--color-surface-input': 'rgba(10, 10, 10, 0.9)', '--color-fg': '#e5e5e5', '--color-fg-strong': '#ffffff', '--color-muted': '#a3a3a3',
      '--color-border': 'rgba(255, 255, 255, 0.12)', '--color-scrim': 'rgba(0, 0, 0, 0.75)',
    },
  },
  daylight: {
    scheme: 'light', accent: '#2563eb', display: SANS,
    vars: {
      '--color-bg': '#f5f6f8', '--color-bg-raised': '#ffffff', '--color-bg-glow-a': 'rgba(37, 99, 235, 0.06)', '--color-bg-glow-b': 'rgba(14, 165, 233, 0.05)',
      '--color-surface': 'rgba(255, 255, 255, 0.94)', '--color-surface-solid': '#ffffff', '--color-surface-hi': 'rgba(15, 23, 42, 0.04)',
      '--color-surface-input': '#ffffff', '--color-fg': '#1f2937', '--color-fg-strong': '#0f172a', '--color-muted': '#64748b',
      '--color-border': 'rgba(15, 23, 42, 0.1)', '--color-scrim': 'rgba(15, 23, 42, 0.45)',
      '--shadow-sm': '0 1px 2px rgba(15, 23, 42, 0.06)', '--shadow-md': '0 4px 14px rgba(15, 23, 42, 0.07)', '--shadow-inner': 'none',
    },
  },
  blush: {
    scheme: 'light', accent: '#d9467a', display: SERIF,
    vars: {
      '--color-bg': '#fbf4f2', '--color-bg-raised': '#ffffff', '--color-bg-glow-a': 'rgba(217, 70, 122, 0.08)', '--color-bg-glow-b': 'rgba(251, 146, 60, 0.07)',
      '--color-surface': 'rgba(255, 255, 255, 0.92)', '--color-surface-solid': '#ffffff', '--color-surface-hi': 'rgba(120, 50, 70, 0.05)',
      '--color-surface-input': '#ffffff', '--color-fg': '#3b2a2f', '--color-fg-strong': '#24161a', '--color-muted': '#8a6d74',
      '--color-border': 'rgba(160, 80, 100, 0.16)', '--color-scrim': 'rgba(60, 30, 40, 0.45)',
      '--shadow-sm': '0 1px 2px rgba(80, 30, 45, 0.06)', '--shadow-md': '0 4px 14px rgba(80, 30, 45, 0.08)', '--shadow-inner': 'none',
    },
  },
};

export const PRESET_IDS = Object.keys(PRESETS);

const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;
const mix = (hex, target, amount) => toHex(toRgb(hex).map((c, i) => c + (target[i] - c) * amount));
/** WCAG relative luminance. */
function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const MIN_TEXT_CONTRAST = 4.5;
const CONTRAST_STEP = 0.08;

/** Moves a colour towards black or white until it reads as text on `bg` (WCAG AA). */
function readableOn(hex, bg) {
  const towards = luminance(bg) > 0.5 ? BLACK : WHITE;
  let c = hex;
  for (let amount = CONTRAST_STEP; contrast(c, bg) < MIN_TEXT_CONTRAST && amount <= 1; amount += CONTRAST_STEP) c = mix(hex, towards, amount);
  return c;
}

/** All custom properties for a theme: the preset's surfaces plus a brand colour family built from the accent. */
export function themeVars(theme) {
  const preset = PRESETS[theme?.preset] ?? PRESETS.night;
  const accent = /^#[0-9a-f]{6}$/i.test(theme?.accent ?? '') ? theme.accent : preset.accent;
  if (preset === PRESETS.night && accent === PRESETS.night.accent) return { scheme: 'dark', vars: {} };
  const bg = preset.vars['--color-bg'] ?? '#120e24';
  const [r, g, b] = toRgb(accent);
  return {
    scheme: preset.scheme,
    vars: {
      ...preset.vars,
      '--font-display': preset.display,
      '--color-primary': accent,
      '--color-primary-strong': mix(accent, BLACK, 0.14),
      '--color-primary-light': mix(accent, WHITE, 0.22),
      '--color-primary-dark': mix(accent, BLACK, 0.4),
      '--color-primary-fg': contrast(accent, '#ffffff') >= contrast(accent, '#000000') ? '#ffffff' : '#111111',
      '--color-accent-text': readableOn(accent, bg),
      '--color-focus': readableOn(accent, bg),
      '--color-border-strong': `rgba(${r}, ${g}, ${b}, 0.55)`,
      '--shadow-glow': `0 0 0 1px rgba(${r}, ${g}, ${b}, 0.35), 0 8px 28px rgba(${r}, ${g}, ${b}, 0.22)`,
      '--color-star': accent,
    },
  };
}

let applied = [];

/** Applies a theme to the page (or to one element, for previews). Calling it again first clears the previous one. */
export function applyTheme(theme, el = document.documentElement) {
  const { scheme, vars } = themeVars(theme);
  if (el === document.documentElement) {
    for (const k of applied) el.style.removeProperty(k);
    applied = Object.keys(vars);
    if (scheme === 'light') el.dataset.theme = 'light'; else delete el.dataset.theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', vars['--color-bg'] ?? '#120e24');
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', scheme);
  }
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  return scheme;
}
