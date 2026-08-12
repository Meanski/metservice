# MetService Tide MCP Server

A local [Model Context Protocol](https://modelcontextprotocol.io) server for the MetService
Tide API v4. TypeScript, stdio transport, native `fetch`. Eight tools for tidal predictions
around New Zealand and globally.

## Tools

| Tool | Description |
|---|---|
| `check_health` | Ping the API. Returns `{ status: "ok" }`. |
| `list_stations` | List LINZ tidal stations; filter by bounding box, point + radius, or name. |
| `get_station` | Metadata for a station: harmonic constituents, coordinates, classification. |
| `get_tide_events` | High/low turning points for a station (time, height, high/low). |
| `get_tide_timeseries` | Continuous elevation series for a station at a fixed interval. |
| `list_models` | List tidal models and coverage; optionally filter to those covering a point. |
| `get_model` | Metadata for a model: resolution, source, coverage boundary, constituents. |
| `get_tide_at_point` | Tide at any lat/lon. `kind` is `events` or `timeseries`. |

`get_tide_at_point` handles model selection: it finds the models covering the coordinate, uses the
finest-resolution one, and falls back to the global model if none fit. The response includes the
`model_used`.

## Setup

Needs Node 20.12 or newer.

```bash
npm install
npm run build
cp .env.example .env
```

The key is read only from `METSERVICE_TIDE_KEY`, never from a tool argument or committed file.

## Wiring into a client

Point any MCP client at the built `dist/index.js`. For Claude Desktop, add this to
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "metservice-tide": {
      "command": "node",
      "args": ["/absolute/path/to/metservice/dist/index.js"]
    }
  }
}
```

Use an absolute path for the script — `~` and `$HOME` aren't expanded. No key is needed here; the
server reads it from `.env`. To pass it explicitly instead, add
`"env": { "METSERVICE_TIDE_KEY": "..." }`, which takes precedence over `.env`.

If a bare `"node"` fails to launch (common with nvm — GUI apps don't inherit your shell `PATH`),
set `"command"` to the absolute path from `which node`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `METSERVICE_TIDE_KEY` | (required) | Beta API key. |
| `METSERVICE_TIDE_BASE_URL` | `https://test-api.marine.metservice.com/tide/v4` | Override for prod/GA. |
| `METSERVICE_TIDE_TIMEOUT_MS` | `20000` | Per-request timeout in ms. |

## Design notes

- **Isolated client.** Tools depend only on the `TideClient` interface (`src/client/tideClient.ts`),
  so the implementation can be repaired when the beta shifts without touching tool code.
- **Caching.** In-memory TTL cache (`src/client/cache.ts`): 6h for station/model discovery, 30min
  for predictions, none for health. Tide data is deterministic and the beta revokes access for
  excessive polling, so repeated calls in a session come from memory.
- **Errors.** RFC 9457 `problem+json` is parsed into a readable message — title, detail, each
  invalid parameter, and the `request_id` for bug reports — rather than dumped as raw JSON.
- **Verified quirks.** Uses `bounding_box`, sends `radius` with lat/lon model discovery, and treats
  the grouped `locations[]` envelope as the shape for every prediction endpoint. Any of these may
  change while the API is in beta.

## Layout

```
src/
  index.ts              MCP server and tool definitions (stdio)
  format.ts             wire shapes to compact output
  smoke.ts              live smoke test
  client/
    tideClient.ts       TideClient interface and HTTP implementation
    config.ts           env-based config
    cache.ts            TTL cache
    errors.ts           RFC 9457 parsing and formatting
    types.ts            wire types
```
