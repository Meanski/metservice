/**
 * Normalizers that turn wire shapes into compact structures for tool output.
 * Flattens the grouped `locations[]` envelope; drops nulls; keeps faithful field names.
 */

import type { PredictionEnvelope, StationSummary } from './client/types.js';

export interface NormalizedPredictions {
  source: { station_id?: string; model_id?: string };
  datum: string;
  data_year?: string;
  units: Record<string, string>;
  locations: Array<{
    latitude: number;
    longitude: number;
    count: number;
    points: Array<{ time: string; sea_surface_elevation: number; tidal_stage?: string }>;
  }>;
}

export function normalizeEnvelope(env: PredictionEnvelope): NormalizedPredictions {
  const md = env.metadata ?? ({} as PredictionEnvelope['metadata']);
  return {
    source: {
      ...(md.station_id ? { station_id: md.station_id } : {}),
      ...(md.model_id ? { model_id: md.model_id } : {}),
    },
    datum: md.datum,
    ...(md.data_year ? { data_year: md.data_year } : {}),
    units: md.units ?? {},
    locations: (env.locations ?? []).map((loc) => ({
      latitude: loc.coordinates?.latitude,
      longitude: loc.coordinates?.longitude,
      count: loc.predictions?.length ?? 0,
      points: (loc.predictions ?? []).map((p) => ({
        time: p.time,
        sea_surface_elevation: p.sea_surface_elevation,
        ...(p.tidal_stage ? { tidal_stage: p.tidal_stage } : {}),
      })),
    })),
  };
}

export function normalizeStations(stations: StationSummary[]) {
  return stations.map((s) => ({
    station_id: s.station_id,
    name: s.name,
    latitude: s.coordinates?.latitude,
    longitude: s.coordinates?.longitude,
  }));
}
