// Test helpers for API tests

export function createMockEnv() {
  return {
    DB: createMockD1(),
    FORMULAS: createMockR2(),
    CACHE: createMockKV(),
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    API_VERSION: "v1",
  };
}

export interface MockD1 {
  prepare(sql: string): MockD1Statement;
  batch(statements: MockD1Statement[]): Promise<unknown[]>;
  _tables: Map<string, unknown[]>;
}

interface MockD1Statement {
  bind(...params: unknown[]): MockD1Statement;
  first(): Promise<unknown>;
  all(): Promise<{ results: unknown[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
}

function createMockD1(): MockD1 {
  const tables: Map<string, unknown[]> = new Map();

  const db: MockD1 = {
    _tables: tables,
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return this;
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { success: true, meta: { changes: 0 } };
        },
      };
    },
    async batch(statements: MockD1Statement[]) {
      const results = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      return results;
    },
  };

  return db;
}

function createMockR2() {
  const store = new Map<string, ArrayBuffer>();
  return {
    async put(key: string, value: ArrayBuffer) {
      store.set(key, value);
    },
    async get(key: string) {
      const val = store.get(key);
      return val ? { arrayBuffer: async () => val } : null;
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

function createMockKV() {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}
