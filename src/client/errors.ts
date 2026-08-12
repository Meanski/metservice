/**
 * RFC 9457 (problem+json) error parsing for the Tide API.
 *
 * Live error bodies carry the RFC core (type/title/status/detail/instance) plus
 * MetService extensions `request_id` and `timestamp`, and an `invalid_params` array
 * that is [{name, reason}] for field errors but empty for semantic errors (over-land,
 * bad datum) where the message lives only in `detail`.
 */

export interface InvalidParam {
  name: string;
  reason: string;
}

export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  invalid_params?: InvalidParam[];
  request_id?: string;
  timestamp?: string;
}

/**
 * A typed error carrying the parsed problem document. Thrown by the client for any
 * non-2xx response (and for local pre-flight failures like a missing API key).
 */
export class TideApiError extends Error {
  readonly status: number;
  readonly problem: ProblemDetails;
  readonly requestId?: string;

  constructor(status: number, problem: ProblemDetails, message: string) {
    super(message);
    this.name = 'TideApiError';
    this.status = status;
    this.problem = problem;
    this.requestId = problem.request_id;
  }
}

/** Best-effort parse of a response body into ProblemDetails. */
export function parseProblem(status: number, contentType: string, body: string): ProblemDetails {
  if (contentType.includes('json')) {
    try {
      const parsed = JSON.parse(body) as ProblemDetails;
      if (parsed && typeof parsed === 'object') {
        return { status, ...parsed };
      }
    } catch {
      /* fall through to a synthetic problem */
    }
  }
  return {
    status,
    title: 'Unexpected error',
    detail: body.slice(0, 500) || `HTTP ${status} with no body`,
  };
}

/** Render a ProblemDetails into a single human-readable string (never raw JSON). */
export function formatProblem(problem: ProblemDetails): string {
  const status = problem.status ?? 0;
  const title = problem.title ?? 'Error';
  const lines: string[] = [`Tide API error ${status} ${title}`.trim()];

  if (problem.detail && problem.detail !== title) {
    lines[0] += `: ${problem.detail}`;
  }
  for (const p of problem.invalid_params ?? []) {
    lines.push(`  - ${p.name}: ${p.reason}`);
  }
  const trailer: string[] = [];
  if (problem.request_id) trailer.push(`request_id: ${problem.request_id}`);
  if (problem.instance) trailer.push(`path: ${problem.instance}`);
  if (trailer.length) lines.push(`(${trailer.join(', ')})`);

  return lines.join('\n');
}

/** Convert any thrown value from a client call into a readable message for a tool result. */
export function toReadableError(err: unknown): string {
  if (err instanceof TideApiError) {
    return formatProblem(err.problem);
  }
  if (err instanceof Error) {
    // Network / DNS / timeout etc.
    return `Request failed: ${err.message}`;
  }
  return `Request failed: ${String(err)}`;
}
