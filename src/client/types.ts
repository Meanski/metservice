/**
 * Wire types for the MetService Tide API v4 (beta).
 *
 * These mirror the *live-verified* JSON shapes (2026-08-12), which differ from both
 * published specs. See NOTES.md. The beta will break these — keep this file and the
 * client the only things that know the wire format.
 */

/** A tidal observation station (LINZ gauge) as returned by GET /stations. */
export interface StationSummary {
  station_id: string;
  name: string;
  coordinates: { latitude: number; longitude: number };
}

/** Detailed station metadata from GET /stations/{station_id}. */
export interface StationMetadata extends StationSummary {
  constituents: string[];
  verified: boolean;
  internal_type: string;
  quantities: string[];
  /** Correction offsets; observed empty ({}) for primary stations. */
  offsets: Record<string, number>;
}

/** A tidal model summary from GET /models. */
export interface ModelSummary {
  model_id: string;
  name: string;
  /** Grid resolution in degrees. Smaller = finer. */
  resolution: number;
  /** Coverage polygon as [[lon, lat], ...]. */
  boundary: number[][];
}

/** Detailed model metadata from GET /models/{model_id}. */
export interface ModelMetadata extends ModelSummary {
  source: string;
  modified: string;
  constituents: string[];
}

/** Metadata block echoed on every prediction response. */
export interface ResponseMetadata {
  model_id: string | null;
  station_id: string | null;
  datum: string;
  data_year: string | null;
  units: Record<string, string>;
}

/** A single prediction point. `tidal_stage` is present only for tide-times responses. */
export interface Prediction {
  time: string;
  sea_surface_elevation: number;
  tidal_stage?: 'high' | 'low';
}

/** Predictions grouped under the coordinate they belong to. */
export interface LocationPredictions {
  coordinates: { latitude: number; longitude: number };
  predictions: Prediction[];
}

/**
 * The single envelope shape returned by ALL prediction endpoints — station and model,
 * tide-times and timeseries, single and multi point. (The docs' flat shape is wrong.)
 */
export interface PredictionEnvelope {
  metadata: ResponseMetadata;
  locations: LocationPredictions[];
}

export interface HealthStatus {
  status: string;
}

/** Reference datum. `CD` works on stations despite being absent from the spec enum. */
export type Datum = 'LAT' | 'MSL' | 'CD';
