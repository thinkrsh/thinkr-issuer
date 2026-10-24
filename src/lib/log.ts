// The one log line per request. It never holds a wallet, a signature, or an IP address: the method,
// the path, the status, and the time only.
export type LogLine = (line: string) => void;

export interface RequestLogEntry {
  readonly at: Date;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly durationMs: number;
}

export function formatRequestLog(entry: RequestLogEntry): string {
  const { at, method, path, status, durationMs } = entry;
  return `${at.toISOString()} ${method} ${path} ${String(status)} ${String(durationMs)}ms`;
}

export function writeLogLine(line: string): void {
  process.stdout.write(`${line}\n`);
}
