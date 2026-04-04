import { describe, it, expect } from "vitest";
import { getFormulaBucket, migrateArchives } from "../../src/services/storage";
import { createMockR2 } from "../helpers";

function createMockBindings() {
  const FORMULAS = createMockR2();
  const PRIVATE_FORMULAS = createMockR2();
  return { FORMULAS, PRIVATE_FORMULAS } as any;
}

describe("getFormulaBucket", () => {
  it("returns FORMULAS for public visibility", () => {
    const env = createMockBindings();
    expect(getFormulaBucket(env, "public")).toBe(env.FORMULAS);
  });

  it("returns FORMULAS for unlisted visibility", () => {
    const env = createMockBindings();
    expect(getFormulaBucket(env, "unlisted")).toBe(env.FORMULAS);
  });

  it("returns PRIVATE_FORMULAS for private visibility", () => {
    const env = createMockBindings();
    expect(getFormulaBucket(env, "private")).toBe(env.PRIVATE_FORMULAS);
  });

  it("public↔private uses different buckets", () => {
    const env = createMockBindings();
    expect(getFormulaBucket(env, "public")).not.toBe(getFormulaBucket(env, "private"));
  });

  it("public↔unlisted uses same bucket", () => {
    const env = createMockBindings();
    expect(getFormulaBucket(env, "public")).toBe(getFormulaBucket(env, "unlisted"));
  });
});

describe("migrateArchives", () => {
  it("copies objects from source to dest and deletes from source", async () => {
    const source = createMockR2();
    const dest = createMockR2();
    const data = new TextEncoder().encode("archive-data").buffer;
    source._store.set("archives/@hong/pkg/1.0.0.tar.gz", data as ArrayBuffer);

    const failures = await migrateArchives(source as any, dest as any, [
      "archives/@hong/pkg/1.0.0.tar.gz",
    ]);

    expect(failures).toHaveLength(0);
    expect(source._store.has("archives/@hong/pkg/1.0.0.tar.gz")).toBe(false);
    expect(dest._store.has("archives/@hong/pkg/1.0.0.tar.gz")).toBe(true);
  });

  it("migrates multiple keys concurrently", async () => {
    const source = createMockR2();
    const dest = createMockR2();
    const data = new TextEncoder().encode("data").buffer;
    source._store.set("archives/@hong/pkg/1.0.0.tar.gz", data as ArrayBuffer);
    source._store.set("artifacts/@hong/pkg/1.0.0/darwin-arm64.tar.gz", data as ArrayBuffer);

    const failures = await migrateArchives(source as any, dest as any, [
      "archives/@hong/pkg/1.0.0.tar.gz",
      "artifacts/@hong/pkg/1.0.0/darwin-arm64.tar.gz",
    ]);

    expect(failures).toHaveLength(0);
    expect(source._store.size).toBe(0);
    expect(dest._store.size).toBe(2);
  });

  it("skips keys that do not exist in source", async () => {
    const source = createMockR2();
    const dest = createMockR2();

    const failures = await migrateArchives(source as any, dest as any, [
      "archives/@hong/missing/1.0.0.tar.gz",
    ]);

    expect(failures).toHaveLength(0);
    expect(dest._store.size).toBe(0);
  });

  it("returns failed keys when dest put throws", async () => {
    const source = createMockR2();
    const data = new TextEncoder().encode("data").buffer;
    source._store.set("archives/@hong/pkg/1.0.0.tar.gz", data as ArrayBuffer);

    const dest = {
      async put() { throw new Error("write error"); },
      async get() { return null; },
      async head() { return null; },
      async delete() {},
    };

    const failures = await migrateArchives(source as any, dest as any, [
      "archives/@hong/pkg/1.0.0.tar.gz",
    ]);

    expect(failures).toEqual(["archives/@hong/pkg/1.0.0.tar.gz"]);
    expect(source._store.has("archives/@hong/pkg/1.0.0.tar.gz")).toBe(true);
  });

  it("returns failed keys when dest head verification fails", async () => {
    const source = createMockR2();
    const data = new TextEncoder().encode("data").buffer;
    source._store.set("key1", data as ArrayBuffer);

    const dest = {
      async put() {},
      async get() { return null; },
      async head() { return null; },
      async delete() {},
    };

    const failures = await migrateArchives(source as any, dest as any, ["key1"]);

    expect(failures).toEqual(["key1"]);
    expect(source._store.has("key1")).toBe(true);
  });

  it("handles empty keys list as a no-op", async () => {
    const source = createMockR2();
    const dest = createMockR2();

    const failures = await migrateArchives(source as any, dest as any, []);

    expect(failures).toHaveLength(0);
  });

  it("partial failure rolls back successful copies from dest (all-or-nothing)", async () => {
    const source = createMockR2();
    const dest = createMockR2();
    const data = new TextEncoder().encode("data").buffer as ArrayBuffer;
    source._store.set("good-key", data);
    source._store.set("bad-key", data);

    // Wrap dest to fail only on "bad-key" put
    const wrappedDest = {
      put: async (key: string, val: ArrayBuffer) => {
        if (key === "bad-key") throw new Error("fail");
        dest._store.set(key, val);
      },
      get: dest.get.bind(dest),
      head: dest.head.bind(dest),
      delete: async (key: string) => { dest._store.delete(key); },
    };

    const failures = await migrateArchives(source as any, wrappedDest as any, ["good-key", "bad-key"]);

    expect(failures).toEqual(["bad-key"]);
    // Source is untouched — both keys remain
    expect(source._store.has("good-key")).toBe(true);
    expect(source._store.has("bad-key")).toBe(true);
    // Dest is rolled back — good-key was cleaned up
    expect(dest._store.has("good-key")).toBe(false);
  });

  it("reports failures when source delete throws after successful copy", async () => {
    const source = createMockR2();
    const dest = createMockR2();
    const data = new TextEncoder().encode("data").buffer as ArrayBuffer;
    source._store.set("key-a", data);

    // Wrap source so delete throws
    const wrappedSource = {
      get: source.get.bind(source),
      head: source.head.bind(source),
      put: source.put.bind(source),
      delete: async () => { throw new Error("delete failed"); },
    };

    const failures = await migrateArchives(wrappedSource as any, dest as any, ["key-a"]);

    // Source delete failed → reported as failure
    expect(failures).toEqual(["key-a"]);
    // Dest still has the copy (caller decides what to do)
    expect(dest._store.has("key-a")).toBe(true);
  });

  it("source keys deleted only after all copies succeed", async () => {
    const source = createMockR2();
    const dest = createMockR2();
    const data = new TextEncoder().encode("data").buffer as ArrayBuffer;
    source._store.set("key-a", data);
    source._store.set("key-b", data);

    const failures = await migrateArchives(source as any, dest as any, ["key-a", "key-b"]);

    expect(failures).toHaveLength(0);
    // Source fully cleaned
    expect(source._store.size).toBe(0);
    // Dest has both
    expect(dest._store.has("key-a")).toBe(true);
    expect(dest._store.has("key-b")).toBe(true);
  });
});
