// Small inline icons (24-unit grid, currentColor) in the weight of OpenChamber's remix set.
const PATHS = {
  in_progress: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="currentColor"/>',
  completed: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  pending: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5.5l3.5 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  cancelled: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 9l6 6M15 9l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  tasks: '<path d="M11 6h10M11 12h10M11 18h10M3 6.5l1.8 1.8L8 5M3 12.5l1.8 1.8L8 11M3 18.5l1.8 1.8L8 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  goal: '<path d="M5 21V4M5 4h12l-2.5 4 2.5 4H5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  context: '<path d="M12 3a9 9 0 1 0 9 9h-9z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, className: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = PATHS[name];
  return svg;
}
