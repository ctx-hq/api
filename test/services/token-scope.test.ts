import { describe, it, expect } from "vitest";
import {
  hasEndpointScope,
  matchesPackageScope,
  validateEndpointScopes,
  validatePackageScopes,
  parseScopes,
} from "../../src/services/token-scope";

describe("hasEndpointScope", () => {
  it("returns true for wildcard scope", () => {
    expect(hasEndpointScope(["*"], "publish")).toBe(true);
    expect(hasEndpointScope(["*"], "yank")).toBe(true);
  });

  it("returns true for exact match", () => {
    expect(hasEndpointScope(["publish", "yank"], "publish")).toBe(true);
    expect(hasEndpointScope(["publish", "yank"], "yank")).toBe(true);
  });

  it("returns false when scope not included", () => {
    expect(hasEndpointScope(["publish"], "yank")).toBe(false);
    expect(hasEndpointScope(["read-private"], "publish")).toBe(false);
  });

  it("returns false for empty scopes", () => {
    expect(hasEndpointScope([], "publish")).toBe(false);
  });
});

describe("matchesPackageScope", () => {
  it("returns true for wildcard", () => {
    expect(matchesPackageScope(["*"], "@alice/tool")).toBe(true);
  });

  it("returns true for exact match", () => {
    expect(matchesPackageScope(["@alice/tool"], "@alice/tool")).toBe(true);
  });

  it("returns false for non-matching exact", () => {
    expect(matchesPackageScope(["@alice/tool"], "@alice/other")).toBe(false);
  });

  it("matches @scope/* pattern", () => {
    expect(matchesPackageScope(["@myorg/*"], "@myorg/tool")).toBe(true);
    expect(matchesPackageScope(["@myorg/*"], "@myorg/another")).toBe(true);
    expect(matchesPackageScope(["@myorg/*"], "@other/tool")).toBe(false);
  });

  it("matches prefix* pattern", () => {
    expect(matchesPackageScope(["@myorg/tool-*"], "@myorg/tool-cli")).toBe(true);
    expect(matchesPackageScope(["@myorg/tool-*"], "@myorg/tool-web")).toBe(true);
    expect(matchesPackageScope(["@myorg/tool-*"], "@myorg/other")).toBe(false);
  });

  it("handles multiple patterns (any match)", () => {
    expect(
      matchesPackageScope(["@alice/tool", "@bob/*"], "@bob/thing"),
    ).toBe(true);
    expect(
      matchesPackageScope(["@alice/tool", "@bob/*"], "@alice/tool"),
    ).toBe(true);
    expect(
      matchesPackageScope(["@alice/tool", "@bob/*"], "@charlie/x"),
    ).toBe(false);
  });

  it("returns false for empty scopes", () => {
    expect(matchesPackageScope([], "@alice/tool")).toBe(false);
  });
});

describe("validateEndpointScopes", () => {
  it("accepts valid scopes", () => {
    expect(validateEndpointScopes(["publish", "yank"])).toBeNull();
    expect(validateEndpointScopes(["*"])).toBeNull();
    expect(validateEndpointScopes(["read-private", "manage-access", "manage-org"])).toBeNull();
  });

  it("rejects invalid scopes", () => {
    expect(validateEndpointScopes(["publish", "invalid"])).toBe("invalid");
    expect(validateEndpointScopes(["delete"])).toBe("delete");
  });
});

describe("validatePackageScopes", () => {
  it("accepts valid patterns", () => {
    expect(validatePackageScopes(["*"])).toBeNull();
    expect(validatePackageScopes(["@scope/name"])).toBeNull();
    expect(validatePackageScopes(["@scope/*"])).toBeNull();
    expect(validatePackageScopes(["@scope/prefix*"])).toBeNull();
  });

  it("rejects wildcard in middle", () => {
    expect(validatePackageScopes(["@scope/a*b"])).toBe("@scope/a*b");
  });

  it("rejects unscoped path with slash", () => {
    expect(validatePackageScopes(["foo/bar"])).toBe("foo/bar");
  });
});

describe("parseScopes", () => {
  it("parses valid JSON array", () => {
    expect(parseScopes('["publish","yank"]')).toEqual(["publish", "yank"]);
  });

  it("returns wildcard for null/undefined", () => {
    expect(parseScopes(null)).toEqual(["*"]);
    expect(parseScopes(undefined)).toEqual(["*"]);
  });

  it("returns empty array for invalid JSON (fail-closed)", () => {
    expect(parseScopes("not-json")).toEqual([]);
  });

  it("returns empty array for non-array JSON (fail-closed)", () => {
    expect(parseScopes('{"a":1}')).toEqual([]);
  });

  it("returns empty array for array with non-strings (fail-closed)", () => {
    expect(parseScopes("[1, 2]")).toEqual([]);
  });

  it("returns wildcard only for null/undefined (legacy tokens)", () => {
    expect(parseScopes(null)).toEqual(["*"]);
    expect(parseScopes(undefined)).toEqual(["*"]);
    // Empty string is NOT null — it's corrupt data
    expect(parseScopes("")).toEqual([]);
  });
});

describe("deploy token enforcement", () => {
  it("deploy token with read-private cannot publish", () => {
    const deployScopes = ["read-private"];
    expect(hasEndpointScope(deployScopes, "publish")).toBe(false);
    expect(hasEndpointScope(deployScopes, "yank")).toBe(false);
    expect(hasEndpointScope(deployScopes, "manage-access")).toBe(false);
    expect(hasEndpointScope(deployScopes, "manage-org")).toBe(false);
    expect(hasEndpointScope(deployScopes, "read-private")).toBe(true);
  });

  it("personal token with wildcard can do everything", () => {
    const personalScopes = ["*"];
    expect(hasEndpointScope(personalScopes, "publish")).toBe(true);
    expect(hasEndpointScope(personalScopes, "yank")).toBe(true);
    expect(hasEndpointScope(personalScopes, "read-private")).toBe(true);
  });

  it("scoped CI token can only publish to specific packages", () => {
    const ciEndpoints = ["publish"];
    const ciPackages = ["@myorg/*"];
    expect(hasEndpointScope(ciEndpoints, "publish")).toBe(true);
    expect(hasEndpointScope(ciEndpoints, "yank")).toBe(false);
    expect(matchesPackageScope(ciPackages, "@myorg/tool")).toBe(true);
    expect(matchesPackageScope(ciPackages, "@other/tool")).toBe(false);
  });
});
