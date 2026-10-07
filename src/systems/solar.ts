/**
 * Posição aproximada do sol (algoritmo simplificado do Astronomical
 * Almanac, erro < 1°). Suficiente para luz/sombra do jogo.
 */
export function sunPosition(date: Date, lat: number, lon: number): { altitude: number; azimuth: number } {
  const rad = Math.PI / 180;
  const d = (date.getTime() - 946_728_000_000) / 86_400_000; // dias desde J2000.0
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  const lst = (gmst * 15 + lon) * rad;
  const H = lst - ra;
  const phi = lat * rad;
  const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  // azimute a partir do norte, sentido horário (leste = +90°)
  const azimuth = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
  return { altitude, azimuth };
}

/** Vetor unitário (x leste, y cima, z sul) a partir de altitude/azimute. */
export function directionFrom(altitude: number, azimuth: number, out: { x: number; y: number; z: number }) {
  const c = Math.cos(altitude);
  out.x = Math.sin(azimuth) * c;
  out.y = Math.sin(altitude);
  out.z = -Math.cos(azimuth) * c;
  return out;
}
