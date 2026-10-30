/**
 * Cache TTL para gauges derivados de PG/SQS — evita consulta a cada scrape.
 */
export class CachedValue<T> {
  private value: T | undefined;
  private fetchedAt = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly fetch: () => Promise<T>,
    private readonly fallback: T,
  ) {}

  async get(): Promise<T> {
    const now = Date.now();
    if (this.value !== undefined && now - this.fetchedAt < this.ttlMs) {
      return this.value;
    }
    try {
      this.value = await this.fetch();
      this.fetchedAt = now;
      return this.value;
    } catch {
      // Mantém último valor bom; se nunca houve, usa fallback.
      if (this.value !== undefined) {
        return this.value;
      }
      return this.fallback;
    }
  }

  /** Força próximo get() a refetch (testes). */
  invalidate(): void {
    this.fetchedAt = 0;
  }
}
