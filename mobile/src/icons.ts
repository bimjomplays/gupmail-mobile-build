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
  unsub: ['M4 5h16v14H4z', 'M4 7l8 6 8-6', 'M3 3l18 18'],
  code: ['M21 2l-2 2', 'M11.4 12.6a5.5 5.5 0 1 1-2.8-2.8z', 'M15.5 8.5L19 5', 'M17 7l3 3'],
  phone: ['M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z', 'M11 18h2'],
  sparkle: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z'],
  mail: ['M4 5h16v14H4z', 'M4 7l8 6 8-6'],
  reply: ['M9 14L4 9l5-5', 'M4 9h10a6 6 0 0 1 6 6v3'],
  check: ['M5 12l5 5 9-10'],
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
