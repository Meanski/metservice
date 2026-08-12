/**
 * Tide API v4 client.
 *
 * The tool layer depends only on the `TideClient` interface below and never touches fetch,
 * URLs, headers, or the wire envelope, so beta schema changes are contained to this file.
 */

import { loadConfig, type TideClientConfig } from './config.js';
import { TtlCache, TTL } from './cache.js';
import { parseProblem, TideApiError } from './errors.js';
import type {
  Datum,
  HealthStatus,
  ModelMetadata,
  ModelSummary,
  PredictionEnvelope,
  StationMetadata,
  StationSummary,
} from './types.js';

/** Common time options for prediction queries. */
export interface PredictionOptions {
  datum?: Datum;
  /** ISO 8601 interval, e.g. "2026-01-01T00:00:00Z/2026-01-08T00:00:00Z". Default: now→+7d. */
  timeRange?: string;
  /** Step size, e.g. "15min", "1h". Timeseries only in practice. */
  timeInterval?: string;
}

export interface StationFilter {
  latitude?: number;
  longitude?: number;
  /** Search radius in metres. Required by the API when using latitude/longitude. */
  radius?: number;
  /** Bounding box as [west, south, east, north]. */
  boundingBox?: [number, number, number, number];
  year?: number;
}

export interface PointQuery extends PredictionOptions {
  latitude: number;
  longitude: number;
  /** Radius in metres used for model discovery. */
  discoveryRadius?: number;
  /** Force a specific model instead of auto-selecting one. */
  modelId?: string;
}

export interface PointResult {
  /** The model actually used to compute the result. */
  modelId: string;
  envelope: PredictionEnvelope;
}

/** The thin interface the tool layer programs against. */
export interface TideClient {
  checkHealth(): Promise<HealthStatus>;
  listStations(filter?: StationFilter): Promise<StationSummary[]>;
  getStation(stationId: string, year?: number): Promise<StationMetadata>;
  getStationTideEvents(stationId: string, opts?: PredictionOptions): Promise<PredictionEnvelope>;
  getStationTimeseries(stationId: string, opts?: PredictionOptions): Promise<PredictionEnvelope>;
  listModels(filter?: { latitude?: number; longitude?: number; radius?: number }): Promise<ModelSummary[]>;
  getModel(modelId: string): Promise<ModelMetadata>;
  getTideEventsAtPoint(query: PointQuery): Promise<PointResult>;
  getTimeseriesAtPoint(query: PointQuery): Promise<PointResult>;
}

/** Fallback global model that covers the whole planet. */
const GLOBAL_MODEL_ID = 'tpxo9_glob_v9.4';

export class HttpTideClient implements TideClient {
  private readonly config: TideClientConfig;
  private readonly cache = new TtlCache();

  constructor(config: TideClientConfig = loadConfig()) {
    this.config = config;
  }

  // --- System ---

  checkHealth(): Promise<HealthStatus> {
    return this.get<HealthStatus>('/health', {}, TTL.health);
  }

  // --- Stations ---

  async listStations(filter: StationFilter = {}): Promise<StationSummary[]> {
    const query: Record<string, string> = {};
    // NOTE: the working param is `bounding_box`; the spec's `bbox` is silently ignored.
    if (filter.boundingBox) query.bounding_box = filter.boundingBox.join(',');
    if (filter.latitude !== undefined) query.latitude = String(filter.latitude);
    if (filter.longitude !== undefined) query.longitude = String(filter.longitude);
    if (filter.radius !== undefined) query.radius = String(filter.radius);
    if (filter.year !== undefined) query.year = String(filter.year);
    const res = await this.get<{ stations: StationSummary[] }>('/stations', query, TTL.discovery);
    return res.stations ?? [];
  }

  getStation(stationId: string, year?: number): Promise<StationMetadata> {
    const query: Record<string, string> = {};
    if (year !== undefined) query.year = String(year);
    return this.get<StationMetadata>(`/stations/${encodeURIComponent(stationId)}`, query, TTL.discovery);
  }

  getStationTideEvents(stationId: string, opts: PredictionOptions = {}): Promise<PredictionEnvelope> {
    return this.get<PredictionEnvelope>(
      `/stations/${encodeURIComponent(stationId)}/tidetimes`,
      predictionQuery(opts),
      TTL.prediction,
    );
  }

  getStationTimeseries(stationId: string, opts: PredictionOptions = {}): Promise<PredictionEnvelope> {
    return this.get<PredictionEnvelope>(
      `/stations/${encodeURIComponent(stationId)}/timeseries`,
      predictionQuery(opts),
      TTL.prediction,
    );
  }

  // --- Models ---

  async listModels(
    filter: { latitude?: number; longitude?: number; radius?: number } = {},
  ): Promise<ModelSummary[]> {
    const query: Record<string, string> = {};
    if (filter.latitude !== undefined) query.latitude = String(filter.latitude);
    if (filter.longitude !== undefined) query.longitude = String(filter.longitude);
    // The API rejects lat/lon filtering without a radius, so supply a default.
    if (filter.latitude !== undefined || filter.longitude !== undefined) {
      query.radius = String(filter.radius ?? 10000);
    }
    const res = await this.get<{ models: ModelSummary[] }>('/models', query, TTL.discovery);
    return res.models ?? [];
  }

  getModel(modelId: string): Promise<ModelMetadata> {
    return this.get<ModelMetadata>(`/models/${encodeURIComponent(modelId)}`, {}, TTL.discovery);
  }

  // --- Point predictions (with model discovery) ---

  getTideEventsAtPoint(query: PointQuery): Promise<PointResult> {
    return this.pointPredict('tidetimes', query);
  }

  getTimeseriesAtPoint(query: PointQuery): Promise<PointResult> {
    return this.pointPredict('timeseries', query);
  }

  /**
   * Resolve candidate models covering a point, finest grid first, with the global model as a
   * guaranteed fallback. Answering "tide at this lat/lon" otherwise needs two calls by hand.
   */
  private async resolveModels(query: PointQuery): Promise<string[]> {
    if (query.modelId) return [query.modelId];
    const covering = await this.listModels({
      latitude: query.latitude,
      longitude: query.longitude,
      radius: query.discoveryRadius ?? 10000,
    });
    const ordered = [...covering]
      .sort((a, b) => a.resolution - b.resolution) // smaller resolution = finer grid
      .map((m) => m.model_id)
      .filter((id) => id !== GLOBAL_MODEL_ID);
    ordered.push(GLOBAL_MODEL_ID); // always attempt global last
    return [...new Set(ordered)];
  }

  private async pointPredict(kind: 'tidetimes' | 'timeseries', query: PointQuery): Promise<PointResult> {
    const models = await this.resolveModels(query);
    const params = {
      ...predictionQuery(query),
      latitudes: String(query.latitude),
      longitudes: String(query.longitude),
    };

    let lastError: unknown;
    for (const modelId of models) {
      try {
        const envelope = await this.get<PredictionEnvelope>(
          `/models/${encodeURIComponent(modelId)}/${kind}/points`,
          params,
          TTL.prediction,
        );
        return { modelId, envelope };
      } catch (err) {
        // A regional model may not actually contain the point (e.g. "over land"); fall through
        // to the next candidate. Anything that isn't a 400 is a real failure — stop.
        if (err instanceof TideApiError && err.status === 400) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new TideApiError(404, { status: 404, title: 'No model' }, 'No model covers this point.');
  }

  // --- HTTP core ---

  private buildUrl(path: string, query: Record<string, string>): string {
    const url = new URL(this.config.baseUrl + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url.toString();
  }

  private async get<T>(path: string, query: Record<string, string>, ttlMs: number): Promise<T> {
    const url = this.buildUrl(path, query);
    return this.cache.wrap<T>(url, ttlMs, () => this.fetchJson<T>(url));
  }

  private async fetchJson<T>(url: string): Promise<T> {
    if (!this.config.apiKey) {
      throw new TideApiError(
        401,
        { status: 401, title: 'Missing API key', detail: 'Set METSERVICE_TIDE_KEY in the environment.' },
        'Missing API key.',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `ApiKey ${this.config.apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'AbortError'
        ? `timed out after ${this.config.timeoutMs}ms`
        : err instanceof Error ? err.message : String(err);
      throw new TideApiError(0, { status: 0, title: 'Network error', detail: reason }, reason);
    } finally {
      clearTimeout(timer);
    }

    const body = await response.text();
    if (!response.ok) {
      const problem = parseProblem(response.status, response.headers.get('content-type') ?? '', body);
      throw new TideApiError(response.status, problem, problem.title ?? `HTTP ${response.status}`);
    }
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new TideApiError(
        response.status,
        { status: response.status, title: 'Malformed response', detail: 'Response was not valid JSON.' },
        'Malformed response.',
      );
    }
  }
}

/** Map shared prediction options to query params. */
function predictionQuery(opts: PredictionOptions): Record<string, string> {
  const query: Record<string, string> = {};
  if (opts.datum) query.datum = opts.datum;
  if (opts.timeRange) query.time_range = opts.timeRange;
  if (opts.timeInterval) query.time_interval = opts.timeInterval;
  return query;
}
