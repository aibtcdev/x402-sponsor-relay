export class MemoryKV implements KVNamespace {
  private readonly store = new Map<string, string>();

  async get(
    key: string,
    type?: "text" | "json" | "arrayBuffer" | "stream"
  ): Promise<string | null>;
  async get<T>(
    key: string,
    type: "json"
  ): Promise<T | null>;
  async get(
    key: string,
    _type: "arrayBuffer"
  ): Promise<ArrayBuffer | null>;
  async get(
    key: string,
    _type: "stream"
  ): Promise<ReadableStream | null>;
  async get<T>(
    key: string,
    type: "text" | "json" | "arrayBuffer" | "stream" = "text"
  ): Promise<T | string | ArrayBuffer | ReadableStream | null> {
    const value = this.store.get(key) ?? null;
    if (value === null) {
      return null;
    }

    if (type === "json") {
      return JSON.parse(value) as T;
    }

    if (type === "arrayBuffer") {
      return new TextEncoder().encode(value).buffer;
    }

    if (type === "stream") {
      return null;
    }

    return value;
  }

  async getWithMetadata(): Promise<KVNamespaceGetWithMetadataResult<unknown, string>> {
    throw new Error("not implemented");
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: {
    prefix?: string | null;
    limit?: number | null;
    cursor?: string | null;
  }): Promise<KVNamespaceListResult<unknown>> {
    const prefix = options?.prefix ?? "";
    const names = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
    const limited = options?.limit != null ? names.slice(0, options.limit) : names;
    return {
      keys: limited.map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    } as KVNamespaceListResult<unknown>;
  }
}
