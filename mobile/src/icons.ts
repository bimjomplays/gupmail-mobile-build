// Stroke icons (24x24, Lucide-style paths drawn here). Built with createElementNS, no markup strings.
const PATHS = {
  today: ['M12 3v2', 'M12 19v2', 'M3 12h2', 'M19 12h2', 'M5.6 5.6l1.4 1.4', 'M17 17l1.4 1.4', 'M5.6 18.4L7 17', 'M17 7l1.4-1.4', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
  inbox: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z'],
  drafts: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M21 21l-4.3-4.3'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  back: ['M15 18l-6-6 6-6'],
  chevron: ['M9 18l6-6-6-6'],
  retry: ['M21 12a9 9 0 1 1-3-6.7', 'M21 4v5h-5'],
  offline: ['M2 8.8a15 15 0 0 1 4.2-2.6', 'M10.7 5.1A15 15 0 0 1 22 8.8', 'M5 12.9a10 10 0 0 1 5-2.7', 'M14.1 10.3a10 10 0 0 1 4.9 2.6', 'M8.5 16.4a5 5 0 0 1 7 0', 'M12 20h.01', 'M2 2l20 20'],
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.9 1.9 0 0 0 3.4 0'],
  unsub: ['M4 5h16v14H4z', 'M4 7l8 6 8-6', 'M3 3l18 18'],
  code: ['M21 2l-2 2', 'M11.4 12.6a5.5 5.5 0 1 1-2.8-2.8z', 'M15.5 8.5L19 5', 'M17 7l3 3'],
  phone: ['M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z', 'M11 18h2'],
  sparkle: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z'],
  mail: ['M4 5h16v14H4z', 'M4 7l8 6 8-6'],
  reply: ['M9 14L4 9l5-5', 'M4 9h10a6 6 0 0 1 6 6v3'],
  check: ['M5 12l5 5 9-10'],
  qr: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h2v2h-2z', 'M18 14h2', 'M14 19h2', 'M18 18h2v2h-2z'],
  archive: ['M3 4h18v4H3z', 'M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8', 'M10 12h4'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
  clip: ['M21 11l-8.6 8.6a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9'],
  star: ['M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z'],
  image: ['M4 4h16v16H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15 8.5h.01'],
  alert: ['M12 3l10 18H2z', 'M12 10v4', 'M12 17.5h.01'],
  user: ['M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M4 21a8 8 0 0 1 16 0'],
  send: ['M22 2L11 13', 'M22 2l-7 20-4-9-9-4z'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'],
  link: ['M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7', 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'],
} as const;
export type IconName = keyof typeof PATHS;

const NS = 'http://www.w3.org/2000/svg';
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of PATHS[name]) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}
