---
name: Warmth & Connection
colors:
  surface: '#fbf9f8'
  surface-dim: '#dcd9d9'
  surface-bright: '#fbf9f8'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f5f3f2'
  surface-container: '#f0eded'
  surface-container-high: '#eae8e7'
  surface-container-highest: '#e4e2e1'
  on-surface: '#1b1c1c'
  on-surface-variant: '#57423e'
  inverse-surface: '#303030'
  inverse-on-surface: '#f3f0f0'
  outline: '#8b716d'
  outline-variant: '#dec0ba'
  surface-tint: '#a53b29'
  primary: '#a53b29'
  on-primary: '#ffffff'
  primary-container: '#ff7e67'
  on-primary-container: '#731709'
  inverse-primary: '#ffb4a6'
  secondary: '#765848'
  on-secondary: '#ffffff'
  secondary-container: '#fdd4c0'
  on-secondary-container: '#795a4a'
  tertiary: '#615e5b'
  on-tertiary: '#ffffff'
  tertiary-container: '#a8a3a0'
  on-tertiary-container: '#3c3a37'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ffdad4'
  primary-fixed-dim: '#ffb4a6'
  on-primary-fixed: '#3f0300'
  on-primary-fixed-variant: '#842415'
  secondary-fixed: '#ffdbca'
  secondary-fixed-dim: '#e6beab'
  on-secondary-fixed: '#2b160a'
  on-secondary-fixed-variant: '#5c4132'
  tertiary-fixed: '#e7e1de'
  tertiary-fixed-dim: '#cbc5c2'
  on-tertiary-fixed: '#1d1b19'
  on-tertiary-fixed-variant: '#494644'
  background: '#fbf9f8'
  on-background: '#1b1c1c'
  surface-variant: '#e4e2e1'
typography:
  headline-xl:
    fontFamily: Plus Jakarta Sans
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.01em
  headline-lg-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 28px
    fontWeight: '700'
    lineHeight: 36px
  body-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  label-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.05em
rounded:
  sm: 0.5rem
  DEFAULT: 1rem
  md: 1.5rem
  lg: 2rem
  xl: 3rem
  full: 9999px
spacing:
  unit: 8px
  container-max: 1200px
  gutter: 24px
  margin-desktop: 64px
  margin-mobile: 20px
---

## Brand & Style

This design system is built for a modern dating webapp that prioritizes human connection over transactional swiping. The brand personality is optimistic, inclusive, and radiant—evoking the feeling of a golden hour sunset. 

The aesthetic blends **Modern Minimalism** with **Glassmorphism** to create a premium, tactile experience. We utilize soft-focus photography, airy white space, and translucent overlays to ensure the UI feels breathable. The emotional goal is to make the user feel safe, inspired, and excited about the possibilities of new relationships. Key visual drivers include lush lifestyle imagery and a sophisticated use of depth through soft shadows and blurred background layers.

## Colors

The palette is anchored in warmth, moving away from harsh high-contrast blacks and whites toward more organic tones.

- **Primary (Coral):** Used for primary actions, active states, and brand highlights. It provides energy and a "vibrant" pulse to the UI.
- **Secondary (Peach):** Utilized for soft backgrounds, gradients, and secondary button states. It bridges the gap between the bold primary and the neutral background.
- **Tertiary (Cream):** The foundation of the layout. This off-white/cream shade replaces pure white to create a softer, more premium reading environment.
- **Gradients:** Use linear gradients from Primary (#FF7E67) to a lighter Peach (#FFAC99) at 135 degrees for hero elements and CTA buttons to add depth and movement.

## Typography

We use **Plus Jakarta Sans** across all levels to maintain a friendly, contemporary, and approachable feel. The font's soft curves mirror our rounded UI elements.

Headlines should be bold and impactful, often using tighter letter-spacing to feel "contained." Body text remains spacious to ensure readability during long browsing sessions. Labels and small metadata should use a semi-bold weight to maintain legibility against colored or photographic backgrounds.

## Layout & Spacing

The layout follows a **Fluid Grid** model with a maximum container width to ensure the experience feels intimate on large monitors. 

- **Desktop:** 12-column grid with 24px gutters. Content is centered.
- **Mobile:** 4-column grid with 16px gutters and 20px side margins.
- **Rhythm:** We use an 8px base unit. Component padding should scale in increments of 8 (e.g., 16px, 24px, 40px) to maintain vertical rhythm. Larger gaps (64px+) should be used between major sections to emphasize the minimalist, "airy" aesthetic.

## Elevation & Depth

Hierarchy is established through a combination of **Tonal Layers** and **Glassmorphism**.

- **Surfaces:** Main cards and containers use a Tertiary (Cream) background. Floating elements (like navigation bars or action sheets) use a semi-transparent white (80% opacity) with a 20px backdrop blur.
- **Shadows:** Avoid harsh, dark shadows. Use "Ambient Shadows": extremely diffused, low-opacity (8-12%), with a slight tint of the Primary color (#FF7E67) to make elements feel like they are glowing rather than casting a shadow.
- **Outlines:** Use soft, low-contrast borders (1px, 10% Primary color) on input fields and secondary cards to define shape without adding visual weight.

## Shapes

The shape language is defined by extreme softness. Sharp corners are avoided to reinforce the "friendly" and "approachable" brand personality.

- **Primary Elements:** Profile cards, buttons, and input fields use a **Pill-shaped (3)** radius (min 16px to fully rounded).
- **Images:** Photography should always be masked with rounded corners (minimum 24px) to ensure consistency with the UI.
- **Icons:** Use "Rounded" icon sets with thick strokes (2px) and circular end-caps.

## Components

- **Buttons:** Primary buttons use the Primary-to-Peach gradient with white text. Secondary buttons use a Peach background with Primary text. All buttons should have a generous height (min 48px) and pill-shaped corners.
- **Cards:** Profile cards are the core component. They should feature full-bleed imagery with a text overlay at the bottom. Use a subtle dark-to-transparent gradient behind text to ensure legibility over photos.
- **Input Fields:** Fields should be tall (56px) with a soft Cream or light Peach background. Focus states are indicated by a 2px Primary border.
- **Chips:** Used for interests or tags. These should be semi-transparent Peach with Primary text, using a 100px border radius.
- **Lists:** User lists should feature large circular avatars (64px+) and significant vertical padding (24px) between items to keep the UI from feeling cluttered.
- **Progressive Disclosure:** Use bottom sheets for mobile filters and settings to maintain a thumb-friendly experience that feels native.