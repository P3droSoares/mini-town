import type { CityData } from './types';

/**
 * Origem dos dados do mundo. Hoje: JSON estático gerado por `npm run fetch-osm`.
 * Amanhã: um `ServerWorldSource` que baixa o mesmo `CityData` do backend.
 */
export interface WorldSource {
  load(onProgress?: (loaded: number, total: number) => void): Promise<CityData>;
}

export class StaticJsonWorldSource implements WorldSource {
  constructor(private readonly url: string) {}

  async load(onProgress?: (loaded: number, total: number) => void): Promise<CityData> {
    const res = await fetch(this.url);
    if (!res.ok) {
      throw new Error(
        `Não foi possível carregar ${this.url} (HTTP ${res.status}). Rode "npm run fetch-osm" para gerar os dados da cidade.`,
      );
    }
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body || !onProgress) return (await res.json()) as CityData;

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total);
    }
    const buf = new Uint8Array(loaded);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.length;
    }
    const data = JSON.parse(new TextDecoder().decode(buf)) as CityData;
    if (data.version !== 1) throw new Error(`Versão de dados não suportada: ${data.version}`);
    return data;
  }
}
