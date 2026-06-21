import { create } from 'storybook/theming/create';

/*
 * Nightcore-branded Storybook theme — mirrors the app's "cosmic + dark" palette
 * (src/styles.css :root). The app's tokens are oklch; Storybook's theme API
 * (emotion) takes plain color strings, so each value below is the sRGB-hex
 * equivalent of its oklch source (noted inline). Shared by the manager chrome
 * (manager.ts) and the Docs pages (preview.ts → parameters.docs.theme) so the
 * whole tool reads as Nightcore.
 */

// Brand accent — the canonical purple primary (≈ oklch(78% .22 290)) and its
// deeper hover (≈ --nc-brand-600, oklch(68% .22 290)).
const purple = '#a26bff';
const purpleDeep = '#8a4ef0';

// Cosmic-dark surfaces / ink (oklch hue ~280–290). The app :root is very dark
// (oklch L 0.07–0.13); these sRGB equivalents read as deep cosmic violet.
const bg = '#0a0712'; // window background ≈ oklch(9% .035 280)
const surface = '#100b1c'; // cards & chrome bars ≈ oklch(13% .04 280)
const popover = '#070510'; // popover/sidebar ≈ oklch(7% .035 280)
const ink = '#f2f0fa'; // primary text ≈ oklch(97% .015 290)
const inkMuted = '#a6a2b8'; // secondary text ≈ oklch(73% .03 285)
const line = 'rgba(255,255,255,0.07)'; // borders — white/7% (≈ --nc-border)

export const nightcoreTheme = create({
  base: 'dark',

  brandTitle: 'nightcore.',
  brandTarget: '_self',

  colorPrimary: purple,
  colorSecondary: purple,

  appBg: popover,
  appContentBg: bg,
  appPreviewBg: bg,
  appBorderColor: line,
  appBorderRadius: 10,

  textColor: ink,
  textInverseColor: bg,
  textMutedColor: inkMuted,

  barBg: surface,
  barTextColor: inkMuted,
  barSelectedColor: purple,
  barHoverColor: purpleDeep,

  inputBg: bg,
  inputBorder: line,
  inputTextColor: ink,
  inputBorderRadius: 8,

  fontBase: "'DM Sans', system-ui, -apple-system, sans-serif",
  fontCode: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
});
