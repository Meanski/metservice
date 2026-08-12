/** Client configuration, resolved from the environment. The API key is read here and nowhere else. */

export interface TideClientConfig {
  baseUrl: string;
  /** The raw API key. Never log, print, or serialize this. */
  apiKey: string | undefined;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
}

const DEFAULT_BASE_URL = 'https://test-api.marine.metservice.com/tide/v4';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TideClientConfig {
  return {
    baseUrl: (env.METSERVICE_TIDE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: env.METSERVICE_TIDE_KEY,
    timeoutMs: Number(env.METSERVICE_TIDE_TIMEOUT_MS ?? 20000),
  };
}
