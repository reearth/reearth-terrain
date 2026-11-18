// <reearth-nav current="terrain"> — the navigation bar shared by the
// Re:Earth open-data sites. An identical copy of this file lives in
// reearth-terrain, reearth-buildings and reearth-papers; change all
// three together.
//
// The bar is fixed to the top of the viewport and overlays the page.
// It has no background of its own until the page scrolls, so on a map
// page (which never scrolls) it is just the logo and the links.
// It publishes its height as --reearth-nav-h on <html>, so a page moves
// its own top-anchored UI down with `top: calc(var(--reearth-nav-h) + …)`.
//
// Site-specific controls go in the "end" slot, at the right of the bar:
//   <reearth-nav current="terrain"><div slot="end">…</div></reearth-nav>
// They are styled by the page. On a phone, a bar with such controls
// shows only the Re:Earth icon, without the logotype, to fit.
//
// Attributes:
//   current  terrain | buildings | papers — marks this site's link
//   tone     dark (default) | light — white text (dark glass once
//            scrolled), or black text (light glass once scrolled)
//   solid    show the background from the start, not only once the
//            page scrolls — for a page whose layout starts below the
//            bar rather than under it
//
// A page restyles the bar by setting these on the reearth-nav element
// (a page's own rules win over the bar's defaults):
//   --fg      logo, hovered and current link
//   --fg-dim  other links
//   --bg      background (once scrolled, or with solid)
//   --line    bottom border, under the background
//   --mark    current link's underline (default: its text colour)
//   --font    font of the links
(() => {
  const HEIGHT = "56px";
  // Set before <body> is parsed (load this script in <head>, without
  // defer) so pages never lay out without the offset.
  document.documentElement.style.setProperty("--reearth-nav-h", HEIGHT);
  const SITES = [
    ["terrain", "Terrain", "https://terrain.reearth.land/"],
    ["buildings", "Buildings", "https://buildings.reearth.land/"],
    ["papers", "Papers", "https://papers.reearth.land/"],
  ];
  // Re:Earth logo, filled with currentColor. The icon sits at the left
  // of the wordmark, so cropping the viewBox to 270 wide leaves just it.
  const ICON = "M84.89,111.57c-.52,0-1.05-.07-1.58-.21-3.18-.87-5.06-4.16-4.18-7.34,4.73-17.26,23-71.21,44.12-91.94C132.61,2.87,145.51-1.56,156.9.5c13.88,2.52,24.36,15.55,22.89,28.47-1.05,9.2-7.51,17.61-18.19,23.68-3.28,1.86-6.65,3.41-9.91,4.9-4.4,2.01-8.55,3.91-12.2,6.44-4.7,3.26-9.86,9.24-8.91,15.38.62,4.02,4.07,7.92,8.79,9.93,4.29,1.83,9.61,2.42,16.75,1.85,5.53-.45,11.09-1.47,16.51-3.04,3.17-.92,6.49.91,7.4,4.08s-.91,6.49-4.08,7.4c-6.19,1.8-12.55,2.97-18.88,3.48-9.14.74-16.26-.14-22.4-2.77-8.56-3.66-14.66-10.98-15.91-19.11-1.78-11.58,6.02-21.56,13.92-27.03,4.51-3.13,9.35-5.34,14.03-7.48,3.17-1.45,6.16-2.82,8.98-4.42,3.39-1.93,11.37-7.22,12.22-14.64.83-7.27-6.26-14.1-13.15-15.35-7.63-1.38-16.51,1.81-23.15,8.34-9.79,9.61-28.96,42.82-40.96,86.57-.73,2.65-3.13,4.4-5.76,4.4ZM234.77,151.95c-17.36,0-34.45-6.75-47.04-18.89-2.38-2.29-2.45-6.07-.16-8.45,2.29-2.38,6.07-2.45,8.45-.16,11.97,11.53,29.64,17.29,46.11,15.04,2.91-.4,12.61-2.19,15.1-8.54.92-2.34.67-4.9-.76-7.59-2.28-4.3-7.12-7.93-12.04-9.04-7.52-1.69-15.59-.13-24.13,1.52-2.39.46-4.86.94-7.32,1.34-16.45,2.68-29.35-.21-37.31-8.36-3.51-3.59-5.9-8.19-7.1-13.22,0-.03-.02-.07-.03-.1-.08-.28-.14-.57-.18-.85-1.51-7.3-.56-15.45,3.04-22.8,5.57-11.38,13.4-20.02,23.26-25.69,5.29-3.04,13.6-5.56,21.08-3.52,4.29,1.17,7.64,3.72,9.71,7.38,3.8,6.72,1.63,15.17-5.96,23.17-10.33,10.9-23.18,19.26-37.45,24.42.6,1.03,1.32,1.99,2.18,2.87,6.47,6.63,18.16,6.33,26.83,4.92,2.29-.37,4.57-.81,6.98-1.28,9.37-1.81,19.06-3.68,29.01-1.44,8.39,1.88,16.04,7.67,19.99,15.1,3.05,5.75,3.52,11.99,1.33,17.57-3.34,8.49-12.31,14.32-24.61,16.01-2.99.41-5.99.61-8.99.61ZM210.02,53.86c-2.9,0-6.43.97-9.38,2.66-7.76,4.46-13.98,11.39-18.48,20.59-1.25,2.55-2.1,5.53-2.39,8.58,11.81-4.56,22.45-11.64,31.06-20.73,3.45-3.64,5.19-7.37,4.23-9.06-.3-.54-.89-1.3-2.46-1.73-.77-.21-1.64-.31-2.58-.31ZM199.2,245.5c-6.05,0-11.61-2.19-15.6-6.23-9.96-10.08-7.1-25.33-5.02-36.46,1.06-5.63,2.72-19.16-4.63-23.13-2.81-1.52-6.84-1.32-10.52.5-3.38,1.68-6.63,4.64-10.24,9.31-4.39,5.69-7.98,12.01-10.66,18.78-1.22,3.07-4.69,4.57-7.76,3.36-3.07-1.22-4.57-4.69-3.36-7.76,3.09-7.81,7.24-15.11,12.31-21.68,2.99-3.87,7.73-9.4,14.38-12.71,7.21-3.58,15.26-3.7,21.52-.32,10.2,5.51,14,18.25,10.7,35.85-1.69,9.01-3.79,20.22,1.77,25.85,2.85,2.88,6.82,2.84,8.93,2.56,5.02-.67,9.75-3.73,12.06-7.81,6.03-10.64.93-23.92-1.54-29.14-2.79-5.88-6.43-11.31-10.29-17.06-2.85-4.24-5.79-8.63-8.39-13.25-7.99-14.21-10.31-27.77-6.69-39.21.99-3.15,4.35-4.89,7.5-3.9,3.15,1,4.89,4.35,3.9,7.5-3.28,10.37,1.3,21.9,5.71,29.75,2.37,4.21,5.06,8.21,7.9,12.45,3.93,5.86,8,11.92,11.17,18.6,6.92,14.59,7.33,29.22,1.14,40.15-4.16,7.33-12.16,12.61-20.89,13.77-1.15.15-2.28.23-3.4.23ZM146.45,260c-.35,0-.7,0-1.05-.03-7.53-.45-14.5-5.81-17.77-13.65-2.93-7.04-2.5-14.6-1.92-19.68.43-3.77,1.1-7.52,2.02-11.22-5.4,2.97-10.22,7.24-15.29,11.73-1.24,1.1-2.47,2.19-3.72,3.27-8.77,7.58-20.67,16.34-35.03,16.82-8.39.26-17.24-3.31-23.12-9.37-4.86-5.01-7.32-11.29-6.91-17.67.47-7.28,4.29-13.75,11.06-18.72,5.33-3.92,12.27-6.69,19.53-7.81,4.08-.63,8.18-.91,12.14-1.18,7.76-.53,15.09-1.04,21.35-4,2.98-1.41,6.55-.14,7.96,2.84,1.41,2.98.14,6.55-2.84,7.96-8.3,3.93-17.12,4.54-25.65,5.12-3.89.27-7.56.52-11.14,1.07-9.78,1.51-19.95,7.31-20.47,15.48-.25,3.81,1.8,6.77,3.56,8.58,3.55,3.66,9.12,5.94,14.14,5.75,10.61-.36,20.33-7.62,27.61-13.92,1.21-1.04,2.41-2.11,3.61-3.17,6.04-5.35,12.28-10.88,20.02-14.57,13.99-6.66,26.14-3.58,32.84,1.52,7.63,5.82,11.72,16.01,11.21,27.96-.3,6.97-2.05,12.84-5.2,17.43-4.06,5.91-10.47,9.47-16.94,9.47ZM141.24,211.79c-1.8,5.28-3.03,10.71-3.66,16.2-.68,5.97-.34,10.33,1.08,13.73,1.48,3.54,4.54,6.14,7.45,6.32,2.57.16,5.56-1.56,7.42-4.27,1.86-2.71,2.91-6.47,3.11-11.18.34-7.87-2.1-14.58-6.51-17.94-2.59-1.97-5.71-2.79-8.89-2.86ZM80.68,200.51c-14.6,0-29.22-.47-43.71-1.42-7-.46-13.82-1.09-20.29-3.77-8.17-3.39-14.17-9.78-16.04-17.1-1.5-5.84-.34-12.09,3.25-17.6,4.34-6.64,11.87-11.57,19.66-12.85,13.1-2.16,25.69,3.53,35.19,8.73,7.4,4.05,14.84,7.38,19.1,4.38,2.82-1.99,4.56-8.95-.4-18.21-3.44-6.43-8.08-12.19-13.79-17.15-2.49-2.16-2.76-5.94-.6-8.43,2.16-2.49,5.94-2.76,8.43-.6,6.82,5.91,12.37,12.82,16.5,20.54,5.86,10.95,7.35,26.15-3.25,33.62-10.94,7.72-24.47.32-31.73-3.66-7.81-4.28-18-8.99-27.5-7.42-4.52.75-9.07,3.73-11.6,7.59-1.23,1.89-2.52,4.82-1.68,8.1.93,3.65,4.4,7.1,9.04,9.03,4.8,1.99,10.31,2.48,16.49,2.89,23.96,1.57,48.28,1.81,72.29.74,3.31-.14,6.09,2.41,6.24,5.7.15,3.3-2.41,6.09-5.7,6.24-9.93.44-19.91.67-29.89.67ZM37.54,139.64c-1.62,0-3.19-.07-4.68-.21-15.93-1.53-22.62-7.94-25.43-13.05-3.43-6.23-2.47-12.76-.42-16.8,4.55-9,16.28-11.9,25.25-10.79,10.9,1.35,21.65,5.37,31.1,11.55-.8-4.08-3.31-8.09-6-11.01-2.93-3.19-6.43-5.94-10.13-8.85-2.82-2.21-5.74-4.5-8.49-7.08-8.71-8.15-13.14-17.56-12.46-26.52.55-7.17,4.41-13.63,10.89-18.18,7.33-5.15,17-6.93,25.23-4.65,10.46,2.9,23.33,12.83,28.05,32,3.35,13.58,1.77,27.72.37,40.19-.37,3.28-3.32,5.64-6.6,5.28-3.28-.37-5.64-3.32-5.28-6.6,1.35-12.04,2.74-24.49-.1-36-2.88-11.68-10.59-20.84-19.64-23.35-4.88-1.35-10.69-.23-15.17,2.91-2.03,1.42-5.48,4.52-5.84,9.3-.54,7.1,5.22,13.62,8.7,16.88,2.38,2.22,4.97,4.25,7.71,6.41,3.92,3.08,7.97,6.26,11.56,10.17,8.1,8.83,11.23,19.52,8.36,28.6-.42,1.33-.96,2.61-1.63,3.84-.05.11-.11.21-.17.31-3.23,5.8-9.05,10.42-16.27,12.74-5.81,1.86-12.7,2.9-18.91,2.9ZM28.53,110.52c-4.47,0-9.37,1.51-10.86,4.46-.51,1.01-1.04,3.33.23,5.64,2.01,3.65,7.73,6.11,16.1,6.91,5.63.54,13.01-.31,18.8-2.17,2.42-.78,4.58-1.97,6.32-3.43-8.47-6.09-18.34-10.04-28.34-11.28-.73-.09-1.48-.13-2.25-.13Z";
  const TYPE = "M346.99,133.75c3.94-1.97,7-4.68,9.16-8.14,2.16-3.45,3.24-7.53,3.24-12.23s-1.08-8.57-3.24-12.06c-2.16-3.49-5.2-6.24-9.1-8.25-3.91-2.01-8.4-3.02-13.48-3.02h-31.4v79.99h15.47v-33.34h2.67l25.55,33.34h18.78l-26.68-33.64c3.31-.42,6.33-1.3,9.04-2.66ZM317.63,102.68h14.45c3.79,0,6.71,1.04,8.76,3.13,2.05,2.09,3.07,4.72,3.07,7.91s-1.02,5.97-3.07,7.91c-2.05,1.93-5.01,2.9-8.88,2.9h-14.34v-21.85ZM409.57,117.36c-4.1-2.35-8.72-3.53-13.88-3.53-5.46,0-10.39,1.25-14.79,3.75-4.4,2.5-7.87,5.92-10.41,10.24-2.54,4.32-3.81,9.22-3.81,14.68s1.29,10.47,3.87,14.79c2.58,4.32,6.12,7.74,10.64,10.24,4.51,2.5,9.65,3.75,15.42,3.75,4.48,0,8.61-.8,12.4-2.39,3.79-1.59,7.09-3.98,9.9-7.17l-8.88-8.87c-1.67,1.97-3.64,3.41-5.92,4.32-2.28.91-4.82,1.37-7.62,1.37-3.11,0-5.84-.64-8.19-1.93-2.35-1.29-4.15-3.17-5.41-5.63-.5-.98-.89-2.03-1.19-3.14l40.16-.1c.3-1.21.49-2.33.57-3.36.07-1.02.11-2.03.11-3.02,0-5.31-1.14-10.05-3.41-14.22-2.28-4.17-5.46-7.43-9.56-9.79ZM387.84,128.28c2.2-1.29,4.78-1.93,7.74-1.93s5.16.57,7.06,1.71c1.9,1.14,3.37,2.81,4.44,5.01.51,1.06.9,2.25,1.18,3.55l-26.52.08c.28-1.02.61-1.99,1.05-2.88,1.17-2.39,2.86-4.23,5.06-5.52ZM441.32,152.29c-2.73,0-4.99.89-6.77,2.67-1.78,1.78-2.67,4.04-2.67,6.77s.89,4.91,2.67,6.77c1.78,1.86,4.04,2.79,6.77,2.79s4.85-.93,6.6-2.79c1.74-1.86,2.62-4.11,2.62-6.77s-.87-4.99-2.62-6.77c-1.75-1.78-3.95-2.67-6.6-2.67ZM441.32,117.93c-2.73,0-4.99.89-6.77,2.67-1.78,1.78-2.67,4.04-2.67,6.77s.89,4.89,2.67,6.71c1.78,1.82,4.04,2.73,6.77,2.73s4.85-.91,6.6-2.73c1.74-1.82,2.62-4.06,2.62-6.71s-.87-4.99-2.62-6.77c-1.75-1.78-3.95-2.67-6.6-2.67ZM480.91,135.91L517.21,135.91L517.21,122.6L480.91,122.6L480.91,103.71L520.51,103.71L520.51,90.05L480.91,90.05L476.82,90.05L465.44,90.05L465.44,170.04L476.82,170.04L480.91,170.04L521.08,170.04L521.08,156.39L480.91,156.39L480.91,135.91ZM570.46,120.28c-1.52-1.58-3.3-2.89-5.35-3.94-3.11-1.59-6.6-2.39-10.47-2.39-5.08,0-9.61,1.25-13.6,3.76-3.98,2.5-7.11,5.92-9.39,10.24-2.28,4.32-3.41,9.22-3.41,14.68s1.14,10.24,3.41,14.57c2.28,4.32,5.4,7.74,9.39,10.24,3.98,2.5,8.48,3.76,13.48,3.76,3.94,0,7.49-.8,10.64-2.39,2.03-1.03,3.79-2.33,5.29-3.88v5.13h15.02v-54.96h-15.02v5.19ZM567.5,153.2c-2.58,2.81-5.95,4.21-10.13,4.21-2.66,0-5.04-.64-7.17-1.93-2.12-1.29-3.77-3.03-4.95-5.23-1.18-2.2-1.76-4.78-1.76-7.74s.59-5.42,1.76-7.62c1.18-2.2,2.81-3.94,4.89-5.23,2.09-1.29,4.49-1.93,7.22-1.93s5.23.63,7.28,1.88c2.05,1.25,3.68,3.02,4.89,5.29,1.21,2.28,1.82,4.85,1.82,7.74,0,4.25-1.29,7.78-3.87,10.58ZM634.81,115.26c-2.09-.87-4.49-1.31-7.23-1.31-6.14,0-10.85,1.95-14.11,5.86-.04.05-.07.1-.11.15v-4.87h-14.91v54.96h14.91v-30.27c0-4.17,1-7.24,3.02-9.22,2.01-1.97,4.61-2.96,7.79-2.96,1.52,0,2.86.21,4.04.63,1.18.42,2.18,1.12,3.02,2.1l9.33-10.81c-1.75-1.97-3.66-3.4-5.75-4.27ZM669.23,92.22L654.32,92.22L654.32,115.09L641.46,115.09L641.46,128.17L654.32,128.17L654.32,170.04L669.23,170.04L669.23,128.17L682.08,128.17L682.08,115.09L669.23,115.09L669.23,92.22ZM739.66,124.07c-1.82-3.19-4.32-5.67-7.51-7.45-3.19-1.78-6.87-2.67-11.04-2.67s-7.89.91-11.15,2.73c-1.72.96-3.23,2.12-4.55,3.47v-32.37h-14.91v82.27h14.91v-31.52c0-2.12.47-4.04,1.42-5.75.95-1.71,2.26-3.02,3.93-3.93,1.67-.91,3.56-1.37,5.69-1.37,3.19,0,5.8,1.02,7.85,3.07,2.05,2.05,3.07,4.7,3.07,7.96v31.52h15.02v-34.93c0-4.17-.91-7.85-2.73-11.04Z";
  const LOGO =
    `<svg class="wordmark" viewBox="0 0 742.39 260" aria-hidden="true"><path fill="currentColor" d="${ICON}${TYPE}"/></svg>` +
    `<svg class="mark" viewBox="0 0 270 260" aria-hidden="true"><path fill="currentColor" d="${ICON}"/></svg>`;

  const CSS = `
    :host {
      position: fixed;
      inset: 0 0 auto 0;
      z-index: 1000;
      display: block;
      height: ${HEIGHT};
      --fg: #fff;
      --fg-dim: rgba(255, 255, 255, 0.7);
      --bg: rgba(0, 0, 0, 0.4);
      --line: rgba(255, 255, 255, 0.1);
      --halo: 0 1px 8px rgba(0, 0, 0, 0.45);
      --mark: currentColor;
      --font: 500 14px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
      /* Until scrolled, only the logo and links take the pointer, so the
         map under the empty part of the bar can still be dragged. */
      pointer-events: none;
    }
    :host([scrolled]),
    :host([solid]) {
      pointer-events: auto;
    }
    :host([tone="light"]) {
      --fg: #14110f;
      --fg-dim: rgba(20, 17, 15, 0.62);
      --bg: rgba(255, 255, 255, 0.6);
      --line: rgba(20, 17, 15, 0.1);
      --halo: 0 1px 8px rgba(255, 255, 255, 0.6);
    }
    nav {
      box-sizing: border-box;
      height: 100%;
      display: flex;
      align-items: center;
      gap: 24px;
      padding: 0 16px;
      border-bottom: 1px solid transparent;
      text-shadow: var(--halo);
      transition:
        background 250ms ease,
        border-color 250ms ease,
        backdrop-filter 250ms ease,
        -webkit-backdrop-filter 250ms ease;
      font: var(--font);
      -webkit-font-smoothing: antialiased;
    }
    :host([scrolled]) nav,
    :host([solid]) nav {
      background: var(--bg);
      border-bottom-color: var(--line);
      text-shadow: none;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    a {
      pointer-events: auto;
      color: var(--fg-dim);
      text-decoration: none;
      transition: color 200ms ease;
      border-radius: 4px;
    }
    a:hover,
    a[aria-current="page"] {
      color: var(--fg);
    }
    a:focus-visible {
      outline: 2px solid var(--fg);
      outline-offset: 4px;
    }
    .logo {
      display: flex;
      color: var(--fg);
      filter: drop-shadow(var(--halo));
    }
    :host([scrolled]) .logo,
    :host([solid]) .logo {
      filter: none;
    }
    .logo svg {
      height: 30px;
      width: auto;
    }
    .mark {
      display: none;
    }
    .end {
      display: flex;
      align-items: center;
      margin-left: auto;
    }
    ::slotted(*) {
      pointer-events: auto;
    }
    ul {
      align-self: stretch;
      display: flex;
      gap: 20px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    /* Full bar height, so the current link's underline sits on the
       bar's bottom edge whatever --font is. The 2px top padding keeps
       the text centred against the 2px underline. */
    li a {
      box-sizing: border-box;
      height: 100%;
      display: flex;
      align-items: center;
      padding-top: 2px;
      border-bottom: 2px solid transparent;
    }
    li a[aria-current="page"] {
      border-bottom-color: var(--mark);
    }
    @media (max-width: 480px) {
      :host([has-end]) nav { gap: 16px; padding: 0 12px; }
      :host([has-end]) ul { gap: 14px; }
      :host([has-end]) .wordmark { display: none; }
      :host([has-end]) .mark { display: block; }
    }
    @media (max-width: 360px) {
      nav { gap: 16px; padding: 0 12px; }
      ul { gap: 14px; }
    }
  `;

  class ReearthNav extends HTMLElement {
    static observedAttributes = ["current"];

    connectedCallback() {
      this.render();
      this.onScroll = () => this.toggleAttribute("scrolled", window.scrollY > 0);
      window.addEventListener("scroll", this.onScroll, { passive: true });
      this.onScroll();
    }

    disconnectedCallback() {
      window.removeEventListener("scroll", this.onScroll);
    }

    attributeChangedCallback() {
      if (this.shadowRoot) this.render();
    }

    render() {
      const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      const current = this.getAttribute("current");
      const links = SITES.map(
        ([id, label, href]) =>
          `<li><a href="${href}"${id === current ? ' aria-current="page"' : ""}>${label}</a></li>`,
      ).join("");
      root.innerHTML = `<style>${CSS}</style><nav aria-label="Re:Earth"><a class="logo" href="https://reearth.io/" aria-label="Re:Earth">${LOGO}</a><ul>${links}</ul><div class="end"><slot name="end"></slot></div></nav>`;
      const slot = root.querySelector("slot");
      const onSlot = () =>
        this.toggleAttribute("has-end", slot.assignedElements().length > 0);
      slot.addEventListener("slotchange", onSlot);
      onSlot();
    }
  }

  if (!customElements.get("reearth-nav")) {
    customElements.define("reearth-nav", ReearthNav);
  }
})();
