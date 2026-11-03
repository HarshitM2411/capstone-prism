import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** The real starter data (`<repo>/data`), used as the known-good baseline in tests. */
export const DATA_DIR = fileURLToPath(new URL('../../../../data', import.meta.url));

export function readData<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8')) as T;
}

export interface SampleRequest {
  id: string;
  note: string;
  body: Record<string, unknown>;
}

/** The starter's `sample_requests.jsonl`: one request per line, ids like `req_malformed`. */
export function readSampleRequests(): SampleRequest[] {
  return readFileSync(join(DATA_DIR, 'sample_requests.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as SampleRequest);
}
