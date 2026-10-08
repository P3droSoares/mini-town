/** Mini helper de DOM (sem framework: UI é pequena e o loop 3D é quem manda). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string | boolean | number | EventListener>> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function svgIcon(path: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

export const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  walk: '<circle cx="13" cy="4" r="2"/><path d="m9 20 2-6 3 3v4M7 11l3-4 4 1 2 4 3 1"/>',
  city: '<path d="M3 21h18M5 21V9l5-4 5 4v12M15 21V12h4v9"/><path d="M9 13h2M9 17h2"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  run: '<path d="M13 4a2 2 0 1 0 0-.1M6 20l3-6 3 2 1 4M9 14l1-5 4 1 2 3h3M10 9 7 10l-1 3"/>',
  bag: '<path d="M4 9h16v11H4z"/><path d="M4 13h16"/><path d="M9 9V6h6v3"/>',
  bike: '<circle cx="5.5" cy="16" r="3.5"/><circle cx="18.5" cy="16" r="3.5"/><path d="M5.5 16 9 9h6l3.5 7M9 9l3.5 7L15 9M7.5 6H10M14 6h2.5l-1.5 3"/>',
  moto: '<circle cx="5" cy="16" r="3"/><circle cx="19" cy="16" r="3"/><path d="M5 16h7l3-5h3l1 5M8 11h5M15 7h2.5l1 4"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  store: '<path d="M4 10 5.5 5h13L20 10M5 10v9h14v-9M4 10h16M10 19v-5h4v5"/>',
  home: '<path d="M4 11 12 5l8 6M6 10v9h12v-9M10 19v-5h4v5"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 14h2"/>',
};
