#!/usr/bin/env node
/**
 * MetService Tide API v4 (beta) — local MCP server.
 *
 * stdio transport. Exposes eight tools over the isolated TideClient. The API key is read from
 * the environment by the client and is never accepted as a tool argument or logged.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Load the project's .env so the key doesn't have to be exported by hand or pasted into a client
// config. Resolved relative to this module (project root, one level above dist/), so it works no
// matter what directory the launcher (Claude Desktop, etc.) starts us from. Only fills gaps — env
// already injected by a client wins — and is a silent no-op if there's no .env. Still "key from env
// only": the value lands in process.env, and .env is gitignored.
if (!process.env.METSERVICE_TIDE_KEY && typeof process.loadEnvFile === 'function') {
  for (const candidate of [join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), '.env']) {
    try {
      process.loadEnvFile(candidate);
      break;
    } catch {
      /* not found here — try the next candidate */
    }
  }
}

import { HttpTideClient, type TideClient } from './client/tideClient.js';
import { loadConfig } from './client/config.js';
import { toReadableError } from './client/errors.js';
import { normalizeEnvelope, normalizeStations } from './format.js';

const client: TideClient = new HttpTideClient();

/** Wrap a handler so any client error becomes a readable, non-raw tool error. */
function tool(run: () => Promise<unknown>) {
  return async () => {
    try {
      const data = await run();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: toReadableError(err) }], isError: true };
    }
  };
}

const server = new McpServer({ name: 'metservice-tide', version: '0.1.0' });

const datum = z
  .enum(['LAT', 'MSL', 'CD'])
  .optional()
  .describe('Reference datum. LAT (default), MSL, or CD (Chart Datum, stations only).');
const timeRange = z
  .string()
  .optional()
  .describe('ISO 8601 interval, e.g. "2026-01-01T00:00:00Z/2026-01-08T00:00:00Z". Defaults to now → +7 days.');
const timeInterval = z
  .string()
  .optional()
  .describe('Step size for timeseries, e.g. "15min", "30min", "1h", "3h". Default 15min.');

server.registerTool(
  'check_health',
  {
    title: 'Check API health',
    description: 'Check the Tide API is reachable and operational. Returns { status: "ok" } when healthy.',
    inputSchema: {},
  },
  tool(() => client.checkHealth()),
);

server.registerTool(
  'list_stations',
  {
    title: 'List tidal stations',
    description:
      'List LINZ tidal observation stations. Optionally filter by a bounding box, or by a ' +
      'point + radius. Use this to find a station_id for the tide tools. There are ~318 stations, ' +
      'so filter or set a limit for large results.',
    inputSchema: {
      bounding_box: z
        .array(z.number())
        .length(4)
        .optional()
        .describe('Bounding box as [west, south, east, north] (lon/lat degrees).'),
      latitude: z.number().optional().describe('Centre latitude for a radius search.'),
      longitude: z.number().optional().describe('Centre longitude for a radius search.'),
      radius: z.number().optional().describe('Search radius in metres (used with latitude/longitude).'),
      year: z.number().int().optional().describe('LINZ almanac dataset year (2022–2025).'),
      name_contains: z.string().optional().describe('Case-insensitive substring filter on station name.'),
      limit: z.number().int().positive().optional().describe('Max stations to return (default 50).'),
    },
  },
  async (args) => {
    return tool(async () => {
      let stations = await client.listStations({
        boundingBox: args.bounding_box as [number, number, number, number] | undefined,
        latitude: args.latitude,
        longitude: args.longitude,
        radius: args.radius,
        year: args.year,
      });
      if (args.name_contains) {
        const needle = args.name_contains.toLowerCase();
        stations = stations.filter((s) => s.name?.toLowerCase().includes(needle));
      }
      const total = stations.length;
      const limit = args.limit ?? 50;
      const shown = stations.slice(0, limit);
      return {
        total,
        returned: shown.length,
        truncated: total > shown.length,
        stations: normalizeStations(shown),
      };
    })();
  },
);

server.registerTool(
  'get_station',
  {
    title: 'Get station metadata',
    description:
      'Get metadata for a specific tidal station: harmonic constituents, coordinates, verification ' +
      'status, and classification. Find a station_id with list_stations.',
    inputSchema: {
      station_id: z.string().describe('Station id, e.g. "linz6400".'),
      year: z.number().int().optional().describe('LINZ almanac dataset year (2022–2025).'),
    },
  },
  async (args) => tool(() => client.getStation(args.station_id, args.year))(),
);

server.registerTool(
  'get_tide_events',
  {
    title: 'Get high/low tide events (station)',
    description:
      'Get discrete high and low tide events (turning points) for a specific station. Each point ' +
      'includes the time, height, and tidal_stage (high/low). Use get_tide_at_point for arbitrary coordinates.',
    inputSchema: {
      station_id: z.string().describe('Station id, e.g. "linz6400". Find one with list_stations.'),
      datum,
      time_range: timeRange,
    },
  },
  async (args) => {
    return tool(async () => {
      const env = await client.getStationTideEvents(args.station_id, {
        datum: args.datum,
        timeRange: args.time_range,
      });
      return normalizeEnvelope(env);
    })();
  },
);

server.registerTool(
  'get_tide_timeseries',
  {
    title: 'Get continuous tide timeseries (station)',
    description:
      'Get a continuous elevation timeseries for a specific station, sampled at a fixed interval ' +
      '(no tidal_stage). For tide curves. Use get_tide_at_point for arbitrary coordinates.',
    inputSchema: {
      station_id: z.string().describe('Station id, e.g. "linz6400". Find one with list_stations.'),
      datum,
      time_range: timeRange,
      time_interval: timeInterval,
    },
  },
  async (args) => {
    return tool(async () => {
      const env = await client.getStationTimeseries(args.station_id, {
        datum: args.datum,
        timeRange: args.time_range,
        timeInterval: args.time_interval,
      });
      return normalizeEnvelope(env);
    })();
  },
);

server.registerTool(
  'list_models',
  {
    title: 'List tidal models',
    description:
      'List available tidal models and their coverage boundaries. Optionally filter to models ' +
      'covering a point (latitude, longitude, radius in metres).',
    inputSchema: {
      latitude: z.number().optional().describe('Latitude to filter models covering the point.'),
      longitude: z.number().optional().describe('Longitude to filter models covering the point.'),
      radius: z.number().optional().describe('Search radius in metres (used with latitude/longitude).'),
    },
  },
  async (args) =>
    tool(async () => {
      const models = await client.listModels({
        latitude: args.latitude,
        longitude: args.longitude,
        radius: args.radius,
      });
      return { total: models.length, models };
    })(),
);

server.registerTool(
  'get_model',
  {
    title: 'Get model metadata',
    description:
      'Get metadata for a specific tidal model: grid resolution, source, coverage boundary, and ' +
      'harmonic constituents. Find a model_id with list_models.',
    inputSchema: {
      model_id: z.string().describe('Model id, e.g. "tpxo9_glob_v9.4".'),
    },
  },
  async (args) => tool(() => client.getModel(args.model_id))(),
);

server.registerTool(
  'get_tide_at_point',
  {
    title: 'Get tide at an arbitrary coordinate',
    description:
      'Get tide predictions at any latitude/longitude (no station needed). Automatically selects the ' +
      'best tidal model covering the point (finest grid, falling back to the global model). Choose ' +
      'kind="events" for high/low turning points or kind="timeseries" for a continuous curve. The ' +
      'response reports which model was used.',
    inputSchema: {
      latitude: z.number().describe('Latitude in degrees.'),
      longitude: z.number().describe('Longitude in degrees.'),
      kind: z
        .enum(['events', 'timeseries'])
        .default('events')
        .describe('"events" for high/low turning points, "timeseries" for a continuous curve.'),
      datum,
      time_range: timeRange,
      time_interval: timeInterval,
      model_id: z.string().optional().describe('Force a specific model instead of auto-selecting.'),
      discovery_radius: z
        .number()
        .optional()
        .describe('Radius in metres for model discovery (default 10000).'),
    },
  },
  async (args) => {
    return tool(async () => {
      const query = {
        latitude: args.latitude,
        longitude: args.longitude,
        datum: args.datum,
        timeRange: args.time_range,
        timeInterval: args.time_interval,
        modelId: args.model_id,
        discoveryRadius: args.discovery_radius,
      };
      const result =
        args.kind === 'timeseries'
          ? await client.getTimeseriesAtPoint(query)
          : await client.getTideEventsAtPoint(query);
      return { model_used: result.modelId, ...normalizeEnvelope(result.envelope) };
    })();
  },
);

async function main(): Promise<void> {
  // Warn (to stderr, never stdout — stdout is the MCP channel) if the key is absent.
  if (!loadConfig().apiKey) {
    console.error('[metservice-tide] WARNING: METSERVICE_TIDE_KEY is not set; all API calls will fail.');
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[metservice-tide] MCP server running on stdio.');
}

main().catch((err) => {
  console.error('[metservice-tide] Fatal:', err);
  process.exit(1);
});
