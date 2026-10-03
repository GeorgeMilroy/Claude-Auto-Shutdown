// Small shared pieces of the scanner: the list of problems, error wording, bounded concurrency.

const MAX_LISTED_PROBLEMS = 25;
const MAX_ERROR_TEXT = 200;

/**
 * Everything that means "I could not see properly", one English sentence each. A non-empty list
 * fails the scanner check, so a problem is never dropped: past the display limit they are counted.
 */
export class Problems {
  private readonly sentences = new Set<string>();

  add(sentence: string): void {
    this.sentences.add(sentence);
  }

  addAll(other: Problems): void {
    for (const sentence of other.sentences) this.sentences.add(sentence);
  }

  get count(): number {
    return this.sentences.size;
  }

  list(): string[] {
    const all = [...this.sentences];
    if (all.length <= MAX_LISTED_PROBLEMS) return all;
    return [...all.slice(0, MAX_LISTED_PROBLEMS), `...and ${all.length - MAX_LISTED_PROBLEMS} more problems.`];
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function notNull<T>(value: T | null): value is T {
  return value !== null;
}

function errorCode(error: unknown): string | null {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === 'string' ? code : null;
}

/** The file or folder is simply not there (any more). Everything else is a failure to look. */
export function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Short error text for a sentence that already names the file: Node's ", open 'C:\...'" is cut. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const pathSuffix = errorCode(error) === null ? -1 : message.indexOf(', ');
  const text = (pathSuffix > 0 ? message.slice(0, pathSuffix) : message).trim().slice(0, MAX_ERROR_TEXT);
  return text || 'unknown error';
}

/**
 * Two spellings of one location compare equal: Windows ignores case and accepts both slashes, and
 * \\wsl$\ is the old name of \\wsl.localhost\.
 */
export function locationKey(location: string): string {
  if (process.platform !== 'win32') return location;
  return location
    .replace(/\//g, '\\')
    .replace(/^\\\\wsl\$\\/i, '\\\\wsl.localhost\\')
    .toLowerCase();
}

/** `task` over every item, at most `limit` at a time, results in item order. `task` must not reject. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
