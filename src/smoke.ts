/**
 * Smoke test: exercises the client against the live beta API. Paced to respect the beta rate
 * limit. Run with `npm run smoke` (after `npm run build`) with METSERVICE_TIDE_KEY set.
 * Never prints the API key.
 */

import { HttpTideClient } from './client/tideClient.js';
import { toReadableError } from './client/errors.js';
import { normalizeEnvelope } from './format.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const client = new HttpTideClient();
  const line = (label: string, v: unknown) => console.log(`\n== ${label}\n${JSON.stringify(v, null, 2).slice(0, 500)}`);

  try {
    line('health', await client.checkHealth());
    await sleep(6000);

    const stations = await client.listStations({ boundingBox: [174, -38, 175, -36] });
    line(`stations in bbox (count=${stations.length})`, stations.slice(0, 3));
    await sleep(6000);

    const events = await client.getStationTideEvents('linz6400');
    line('station events (linz6400)', {
      source: normalizeEnvelope(events).source,
      first2: normalizeEnvelope(events).locations[0]?.points.slice(0, 2),
    });
    await sleep(6000);

    const point = await client.getTideEventsAtPoint({ latitude: -39.05, longitude: 174.02 });
    line('point events (auto model)', {
      model_used: point.modelId,
      first2: normalizeEnvelope(point.envelope).locations[0]?.points.slice(0, 2),
    });
    await sleep(6000);

    // Deliberate error path: bad datum -> readable RFC 9457 message, not raw JSON.
    try {
      await client.getStationTimeseries('linz6400', { datum: 'WRONG' as never });
    } catch (err) {
      console.log(`\n== error path (expected)\n${toReadableError(err)}`);
    }

    console.log('\nSMOKE OK');
  } catch (err) {
    console.log(`\nSMOKE FAILED:\n${toReadableError(err)}`);
    process.exit(1);
  }
}

main();
