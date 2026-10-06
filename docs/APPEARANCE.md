# Appearance customization

Settings → Appearance offers five interface surface presets: Current, Ocean, Forest, Plum, and High contrast. Accent color is independent (Copper, Blue, Teal, Violet). Chart controls select the shared eight-series palette and line width (1.5, 2, or 3). Viewport controls select the background and grid palette.

Expand Custom colors to override the accent, primary chart trace, viewport background, or grid color. Turn an override off to return to its selected preset. Custom accent button text chooses black or white for readable contrast; custom trace and grid colors remain the user's choice, so choose colors that remain visible on the background. These controls affect the shared display tokens, not geometry, materials, simulation inputs, or exported model data.

Choices persist locally, including across light/dark theme changes. Stored or imported settings accept only supported enum values and six-digit hexadecimal colors. Invalid stored appearance fields independently recover to their default without discarding valid general settings.

The Header and Settings theme controls stay synchronized: changing a chart or viewport option does not restore an older theme after restart. The Accessible and Muted chart palettes offer stronger trace contrast in light mode. The original default light palette is intentionally retained, including its lower-contrast third, fourth, and fifth trace colors.

Each preset row has an individual reset. Custom colors reset individually by turning their override off. Reset appearance also restores theme and fonts. The default Current/Copper settings, current chart/viewport palettes, width 2, disabled custom colors, and Plex fonts leave the original styling tokens unchanged.

Validation: `node --experimental-strip-types scripts/check-appearance-presets.mjs`, existing general-settings/i18n/type checks, and browser scenario S13 in English and Turkish at the compact viewport.
