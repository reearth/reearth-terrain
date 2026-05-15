# Design System

This document is the source of truth for the visual language of the
Re:Earth Terrain landing page and viewer. Use it before adding new UI:
match an existing pattern, or extend the system intentionally. Tokens
and rationale live together so changes can be made by reading, not by
guessing.

> **For Claude Code (and other AI assistants):** before touching the LP
> or viewer UI, invoke the `ui-ux-pro-max` skill first. It supplies
> general UI/UX guardrails (touch targets, contrast, hover/focus,
> light-mode legibility, anti-emoji-icon rules, etc.) that this
> document deliberately does not duplicate. This file covers the
> *project-specific* aesthetic on top of those baselines.

Format loosely follows the [`design.md` spec by
google-labs-code](https://github.com/google-labs-code/design.md):
Overview → Colors → Typography → Layout → Elevation → Shapes →
Components → Do's & Don'ts.

---

## Overview

Re:Earth Terrain is an open terrain-tile service for developers. The
landing page exists to (a) show a live globe so the product is felt in
five seconds, and (b) hand off copy-pasteable code without making the
reader wade through SaaS marketing.

**Personality**: editorial, confident, quietly opinionated. Closer to a
print atlas or a Penguin Modern Classics spine than a dev-tool dashboard.
The product is technical, but the page is *literary* about it.

**Audience**: developers building 3D mapping (Cesium, three.js,
MapLibre globes). We assume they know quantized-mesh and raster-DEM
as wire formats — but we don't assume they've thought about *why* a
3D globe needs ellipsoidal heights instead of plain elevation. The
features section earns its space by closing exactly that gap, and
nothing else: it's the one place we let the page teach.

**Differentiation**: most terrain / mapping services lean into the same
dark-mode dev-tool aesthetic (monospace, neon green, terminal kicker).
We deliberately don't. The page reads as a magazine that happens to be
about elevation tiles.

### Design principles

1. **One bold direction, executed precisely.** Generic AI-flavored
   "modern SaaS" is the failure mode — we'd rather be wrong-and-strange
   than safe-and-forgettable.
2. **Hot UI, cool globe.** The live Cesium globe is naturally cool
   (blues, greens, browns of satellite imagery). Page UI is warm
   (akafuji red + cream). The two never compete; they alternate.
3. **Editorial over technical.** Italic display kickers, large numerals,
   prose paragraphs. Avoid mono + tracked-uppercase eyebrow labels —
   they're cliché and read as "AI default."
4. **Trust the reader.** Don't decorate. Don't pad. If a paragraph isn't
   carrying weight, cut it; if a label isn't telling the truth, rewrite
   it.

---

## Colors

The page ships two palettes that swap via `data-palette` on `<html>`.
**Alpha (Akafuji Atlas) is the default and canonical**; gamma (Sumi
Akafuji) exists as an alternate that we may promote later. Every
component must work in both without per-palette overrides.

The signature color is *akafuji* — the deep vermillion red of Hokusai's
*Fine Wind, Clear Morning* (凱風快晴), where Mt. Fuji catches the dawn.
Earthier and more grounded than orange, but unmistakably hot against
the cool globe.

### Roles

| Token | Role | Notes |
|---|---|---|
| `--red` | Base 60% — hero bands, statement sections, primary CTA | The signature. Used at full strength as a *field*, not as an accent. |
| `--paper` | Assort 30% — content surfaces, body backgrounds, cards | Where prose and code blocks live. Always slightly warm — never pure `#fff`. |
| `--ink` | Text on `--paper` | Slightly off-black with a warm undertone. Never `#000`. |
| `--accent` | 10% — links, secondary CTAs, kicker color, section numerals | The color that does the editorial pointing. |
| `--hero-fg` | Foreground on `--red` | Cream tone, not pure white. Used for hero title, code-block-on-red text. |

### Alpha — Akafuji Atlas (default)

```css
--red:      #C8372D;  /* akafuji — Hokusai red Fuji vermillion, earthy and grounded */
--paper:    #FAF4E8;  /* warm cream, has yellow undertone */
--ink:      #14110F;  /* warm near-black */
--accent:   #14110F;  /* ink doubles as accent — restraint */
--hero-fg:  #FAF4E8;
```

Why these values: the red carries the woodblock-print weight of
*akafuji* — saturated enough to read as a field, oxidized enough not to
shout. Pure orange (`#E94E1B`) skewed toward dev-tool warmth; this red
sits closer to lacquer or kiln-fired ceramic. Ink rather than pure
black keeps the page from feeling clinical against the cream. Accent
collapses to ink because a third color would weaken the duotone.

### Gamma — Sumi Akafuji (alt)

```css
--red:      #D94436;  /* slightly hotter, since assort is dark */
--paper:    #2B1810;  /* dark warm brown — sumi-leaning */
--ink:      #F4EFE7;  /* light cream on dark */
--accent:   #D4A04A;  /* aged-gold — pairs with akafuji like temple lacquer */
--hero-fg:  #F4EFE7;
```

This palette inverts the assort/ink relationship — paper becomes a deep
warm brown, ink becomes cream. The accent shifts from electric yellow
to an aged gold that reads as gilt against the red, rather than
fighting it. The globe (cool) is the only non-warm element on the page
in this palette.

### Don't introduce a third palette without
- writing it as a peer (same 5 token roles, same usage rules), and
- verifying every existing component reads correctly in it.

---

## Typography

Three families, with strict role separation. No font is allowed to drift
out of its role.

| Family | Role | When to use |
|---|---|---|
| **Bricolage Grotesque** (variable, italic available) | `--display` | Headings, italic kickers, section numerals, source/license labels. Anything that wants editorial voice. |
| **Hanken Grotesk** | `--body` | All paragraph prose, CTA labels, footer text, UI buttons. |
| **JetBrains Mono** | `--mono` | **Only inside `<code>` and `<pre>`.** No exceptions — no monospace eyebrows, no monospace metadata labels. |

### Scale

| Use | Family / style | Size | Tracking | Line height |
|---|---|---|---|---|
| Hero title | display medium 500 | `clamp(4rem, 14vw, 14rem)` | `-0.045em` | `0.88` |
| Section heading | display medium 500 | `clamp(2rem, 5vw, 4rem)` | `-0.035em` | `0.95` |
| Statement heading (quickstart, sources) | display medium 500 | `clamp(2.5rem, 7vw, 6rem)` | `-0.035em` | `0.92` |
| Subhead / column heading | display medium 500 | 22–24 px | `-0.02em` | `1.2` |
| Kicker / eyebrow | display italic 400 | 14–17 px | `0` | inherit |
| Large numeral (feature index) | display italic 400 | 32 px | `-0.02em` | `1` |
| Small numeral / step kicker | display italic 400 | 18 px | `0` | inherit |
| Card heading (`about-card h3`) | display italic 400 | 18 px | `-0.01em` | `1.2` |
| Source license label | display italic 400 | 15 px | `0` | inherit |
| Prose lede | body regular 400 | 17–18 px | `0` | `1.55–1.65` |
| Body paragraph | body regular 400 | 15–17 px | `0` | `1.55–1.65` |
| Inline code in prose | mono 400 | `0.88–0.92em` | `0` | inherit |
| Code block | mono 400 | 14 px | `0` | `1.7` |
| CTA / button | body medium 500 | 12–14 px | `0` | — |
| Footer | body regular 400 | 14 px | `0` | — |

### Italic usage

Italic is the editorial signature. Use it on:
- Kicker / eyebrow labels (`Quick start`, `CesiumJS`, `MapLibre · Terrarium`)
- Large numerals (`01`, `02`, `03`, `04`)
- Card headings inside dense sections (Operating model, Attribution, …)
- License labels (`CC BY 4.0`, `Public domain`, `ODbL · © OSM`)
- A single accent word in a heading, in `--red` (e.g. *Earth* inside `Re:Earth Terrain`)

Don't use italic on body prose. Don't use italic for emphasis — use weight
or color instead.

### Casing

Sentence case everywhere. No `UPPERCASE` text. No `Title Case Headings`.
Headings read as sentences: `Built for open mapping.`, `One URL. Your
renderer picks up the rest.`.

---

## Layout

The page is a vertical column. There is no nav, no sidebar, no
multi-column reading flow. Sections alternate between `--paper` and
`--red` to create rhythm; each section is full-bleed horizontally and
self-contained.

### Container

- Section padding: `120–160px` vertical, `64px` horizontal (`28px` on mobile)
- Content max-widths:
  - Body prose: `64ch`
  - Section heading: `18–22ch`
  - Grid (features, sources): `1100–1200px`
  - Code grid: `1500px`

### Section rhythm

`hero (globe) → quickstart (red) → features (paper) → sources (red) → about (paper) → footer (paper)`

The features section opens with the page's central thesis — *3D Earth
needs ellipsoidal heights* — and a two-paragraph proof, then drops
into the three URL-anatomy cards (wire format / vertical datum /
standalone geoid). There is deliberately no separate
"how it works" pass: the thesis IS the page's job, and fragmenting it
across multiple sections dilutes the conclusion.

The hero is the only section without a colored field — the globe is the
field. Every alternation between paper and red resets the reader's
eye.

### Grid

- Feature cards: `auto-fit, minmax(260px, 1fr)`, gap `48px`
- Code grid: explicit 3 columns ≥1200px, 2 columns ≥760px, 1 column below
- Source list: 3-column table-like grid (name / role / license), collapses to single column at 720px

### Spacing scale

There is no enforced 4px/8px scale. Values are chosen for typographic
fit, not grid hygiene. **However**, if you introduce a new
section-internal vertical rhythm, prefer multiples of 8 (8, 16, 24, 32,
48, 64) so it feels consistent.

---

## Elevation & Depth

The page is intentionally flat. There is essentially no shadow language.

- **No drop shadows on cards.** Sections use color-band alternation to
  separate themselves, not elevation.
- **Code blocks** sit on the red band and inherit a paper card
  background with `border-radius: 16px` — no shadow.
- **Borders are hairlines**: `1px` in `color-mix(--ink 12%, transparent)`
  on paper, or `rgba(255,255,255,0.25)` on red.
- **The hero shade** is the one approved gradient: a soft radial wash at
  `rgba(0,0,0,0.45)` over the bottom of the globe so the title remains
  legible. No other gradient is allowed on the page.
- **The cover overlay** (briefly hides the iframe before the viewer
  signals `ready`) is solid `#000` fading to transparent — also not
  treated as elevation.

If you're tempted to add a shadow, you probably need a color-band
alternation instead.

---

## Shapes

- **Sections**: no rounded corners — they span edge to edge.
- **Code blocks**: `border-radius: 16px`.
- **Cards** (feature cards have no border-radius — hairline-top only): n/a.
- **Buttons and pills**: `border-radius: 999px` (fully round).
- **Palette toggle**: `border-radius: 999px` around the whole group.
- **Inline code**: `border-radius: 4px`.

The "pill vs. rounded-rect vs. hairline-only" decision encodes meaning:
pills are interactive, rounded rects are content surfaces, hairlines
separate but don't enclose.

---

## Components

### Hero CTA buttons

Two visual variants:
- `.btn-primary` — solid red background, cream text. The single
  highest-affordance action on the page.
- `.btn-ghost` — transparent with `1px` cream outline, backdrop-blur
  for legibility over the globe. Secondary actions (viewer, GitHub).

Both: pill radius (`999px`), `14px / 22px` padding, `14px` body medium,
`translateY(-1px)` on hover. No icon-only buttons.

### Copy button (`.copy-btn`)

Floats top-right inside the code block. Pill, body medium 12px, label
in `--red` on cream pill *or* in cream on red pill (depends on
host surface). Toggles to `Copied` for `1200ms` after click.

### Code block (`.code-block`)

- Background: `--paper` (cream); text: `--ink`
- Padding: `28px 32px`, radius `16px`
- `<pre>` wraps long lines (`white-space: pre-wrap; overflow-wrap: anywhere`)
- Syntax accents via inline spans:
  - `.kw` — `--accent`, font-weight 500
  - `.str` — `--red`
  - `.cm` — `--ink` at 50% opacity
- The Copy button sits absolutely top-right (`16px / 16px` inset).

### Section eyebrow (kicker)

Display italic 14–17px, `opacity: 0.85`. Sentence case. One short phrase
— `Quick start`, `CesiumJS`, `MapLibre · Terrarium`. Never numbered
(`// 01 —`), never tracked-uppercase mono.

### Feature card

- Hairline border on top, content below.
- Numeral first (italic display, 32px), in `--red`.
- Title in display medium 500, 22–24px.
- Description in body regular 400, 14px, `opacity 0.75`.
- API tokens (URL parameters, data type names) inside the description
  use `<code class="inline-code">`: mono, `0.92em`, tinted background
  (`color-mix(--accent 14%, transparent)`). They're the
  copy-paste-able strings, so they need to look like code.
- Optional URL sample (`.feature-sample`): mono 13px block with a
  `2px` `--red` left rule and a faint accent-tint background. Use
  sparingly — only when a card describes something with no code
  example elsewhere on the page (currently: standalone geoid).

### Features prose block

Sits between the section heading and the feature grid. Body regular
17px, line-height 1.65, max-width 64ch. **Two short paragraphs only**
— this is a thesis, not a tutorial.

Structure is fixed:
1. **Lead with the failure**, not the term. One concrete example of
   what goes wrong if you use plain elevation on a 3D globe (Mt. Fuji
   misplaced ~37 m). Introduce `geoid` only at the end of the
   paragraph, as the name for the thing being described.
2. **Bridge + product**, in one paragraph. EGM2008 closes the gap;
   Re:Earth Terrain does the math; here are the three URL knobs.

Inline `<strong>` is the only emphasis tool and renders in `--red` at
weight 500 — used on the two terms the reader is being taught
(`geoid`, `ellipsoidal height`). No italic emphasis; italic is
reserved for editorial voice in headings and kickers.

Do not expand into a third paragraph. If a third paragraph wants to
exist, the page has already lost the punchline.

A single named real-world example (e.g. PLATEAU, the open Japanese
3D city-model platform) may live *inside* paragraph 2 as one
illustrative sentence — never as a separate block. Links inside the
prose use `--red` with an underline at 40% color-mix to keep them
visible without competing with `<strong>` highlights.

### Source row

3-column grid: name (display 22px) / role (body 16px) / license (italic
display 15px). Hairline separator on top + bottom of each row. Collapses
to single column at mobile.

### About cards

Side-by-side prose + cards in a 2-column grid. Each card has an italic
display 18px heading in `--accent`, and a 15px body paragraph at 85%
opacity.

### Footer

Single horizontal row, body regular 14px, 70% opacity. Left: copyright
(`© Re:Earth and contributors`) + license. Right: viewer / GitHub /
parent link. No underlines until hover; hover swaps to `--red`.
Keep it ambient — operator credit (Eukarya, Inc.) lives in the About
section, not here.

### Theme toggle

Fixed top-right, glass pill (`backdrop-filter: blur(12px)`,
`rgba(0,0,0,0.4)` bg). Two `36×36` icon buttons — sun (Alpha / light)
and moon (Gamma / dark) — using 18px Lucide-style stroke SVGs. Active
state fills the button with `--red`. Preference persists in
`localStorage` under `reearth-terrain:theme`; default on first visit is
light.

The two palettes are still named (Akafuji Atlas, Sumi Akafuji) in CSS
comments and copy, but the UI surfaces them as a plain light/dark
switch — most visitors don't need the palette vocabulary.

### Hero globe (`<iframe>`)

- Loads `/viewer?demo` (chrome-less orbit mode), lazy.
- Sits absolutely behind the hero content.
- Black cover overlay (`#cover`) hides it until the viewer posts
  `{ type: "reearth-terrain:ready" }`, then fades out over `700ms`.
- Pointer events pass through to the iframe so attribution and globe
  interactions work.

---

## Do's & Don'ts

### Do
- **Commit to one bold aesthetic decision and execute it precisely.**
- **Use Bricolage italic for kickers, numerals, and small accent labels.**
  Italic is the page's editorial signature.
- **Use sentence case** for every heading, label, eyebrow, button, and
  footer link.
- **Let red and paper alternate** to create vertical section rhythm.
- **Render numerals (`01`, `02`, …) at editorial size** (18–32px italic
  display), not as mono captions.
- **Trust the prose** to do the explaining. A clear paragraph beats four
  bullet points.
- **Use `--accent` for links and secondary CTAs only.** Primary CTAs are
  always `--red`.

### Don't
- **Don't use monospace outside of literal code (`<code>` / `<pre>`).**
  No monospace eyebrows, no monospace metadata, no monospace footer.
- **Don't use `text-transform: uppercase` with tracked letter-spacing.**
  This is the single most generic "AI-default dev tool" pattern; we
  explicitly reject it.
- **Don't use pure `#000` or `#fff`.** Ink has warmth; paper has yellow
  undertone.
- **Don't add purple, blue, or teal accents.** The page has one color
  story; introducing cool accents kills the hot-UI / cool-globe contrast.
- **Don't add drop shadows** to create depth. Use color bands instead.
- **Don't introduce a third typeface** without retiring one of the
  existing three. The page has room for three roles, no more.
- **Don't add icons inside CTA buttons** unless the page already has an
  established icon language (it currently doesn't — text-only is the
  rule).
- **Don't decorate with `//`, `>`, `$`, or other code-flavored
  ornaments** in headings or labels. The page is editorial, not a
  terminal.
- **Don't add "Loading…" text or a spinner** to the hero cover. The
  black wash + fade is enough.

---

## References

- [google-labs-code/design.md spec](https://github.com/google-labs-code/design.md/blob/main/docs/spec.md) — structural reference for this file
- [UXPin: Design System Documentation Best Practices](https://www.uxpin.com/studio/blog/7-best-practices-for-design-system-documentation/)
- [Banani: What Is Design.md and How to Use It](https://www.banani.co/blog/design-md-guide)
