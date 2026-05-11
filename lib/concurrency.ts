import pLimit from "p-limit";

export async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const limit = pLimit(Math.max(1, concurrency));
  return Promise.all(items.map((item, index) => limit(() => mapper(item, index))));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: { retries?: number; baseDelayMs?: number },
): Promise<T> {
  const retries = options?.retries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 600;

  let attempt = 0;
  let lastError: unknown;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }
      const sleepMs = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
      attempt += 1;
    }
  }

  throw lastError;
}
