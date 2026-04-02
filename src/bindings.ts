import type { UserRow } from "./models/types";

export type Bindings = {
  DB: D1Database;
  FORMULAS: R2Bucket;
  CACHE: KVNamespace;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  ENRICHMENT_QUEUE: Queue;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_TOKEN?: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    user: UserRow;
    tokenScopes: {
      endpoints: string[];
      packages: string[];
      tokenType: string;
    };
  };
};
