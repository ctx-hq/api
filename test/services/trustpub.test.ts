import { describe, it, expect } from "vitest";
import { extractWorkflow, matchesTrustedPublisher } from "../../src/services/trustpub";
import type { OIDCClaims } from "../../src/services/trustpub";

describe("extractWorkflow", () => {
  it("extracts workflow filename from full ref", () => {
    expect(
      extractWorkflow("myorg/myrepo/.github/workflows/release.yml@refs/tags/v1.0.0"),
    ).toBe("release.yml");
  });

  it("extracts workflow from branch ref", () => {
    expect(
      extractWorkflow("owner/repo/.github/workflows/ci.yml@refs/heads/main"),
    ).toBe("ci.yml");
  });

  it("handles workflow without ref suffix", () => {
    expect(
      extractWorkflow("owner/repo/.github/workflows/deploy.yml"),
    ).toBe("deploy.yml");
  });
});

describe("matchesTrustedPublisher", () => {
  const baseClaims: OIDCClaims = {
    repository: "myorg/myrepo",
    repository_owner: "myorg",
    workflow_ref: "myorg/myrepo/.github/workflows/release.yml@refs/tags/v1.0.0",
    job_workflow_ref: "myorg/myrepo/.github/workflows/release.yml@refs/tags/v1.0.0",
    environment: "production",
    iss: "https://token.actions.githubusercontent.com",
    aud: "https://getctx.org",
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  it("matches when repo + workflow match", () => {
    expect(
      matchesTrustedPublisher(baseClaims, {
        github_repo: "myorg/myrepo",
        workflow: "release.yml",
        environment: null,
      }),
    ).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(
      matchesTrustedPublisher(baseClaims, {
        github_repo: "MyOrg/MyRepo",
        workflow: "Release.yml",
        environment: null,
      }),
    ).toBe(true);
  });

  it("rejects wrong repo", () => {
    expect(
      matchesTrustedPublisher(baseClaims, {
        github_repo: "other/repo",
        workflow: "release.yml",
        environment: null,
      }),
    ).toBe(false);
  });

  it("rejects wrong workflow", () => {
    expect(
      matchesTrustedPublisher(baseClaims, {
        github_repo: "myorg/myrepo",
        workflow: "ci.yml",
        environment: null,
      }),
    ).toBe(false);
  });

  it("matches when environment is required and present", () => {
    expect(
      matchesTrustedPublisher(baseClaims, {
        github_repo: "myorg/myrepo",
        workflow: "release.yml",
        environment: "production",
      }),
    ).toBe(true);
  });

  it("rejects when environment is required but missing", () => {
    const claimsNoEnv = { ...baseClaims, environment: "" };
    expect(
      matchesTrustedPublisher(claimsNoEnv, {
        github_repo: "myorg/myrepo",
        workflow: "release.yml",
        environment: "production",
      }),
    ).toBe(false);
  });

  it("rejects when environment is required but wrong", () => {
    const claimsDiffEnv = { ...baseClaims, environment: "staging" };
    expect(
      matchesTrustedPublisher(claimsDiffEnv, {
        github_repo: "myorg/myrepo",
        workflow: "release.yml",
        environment: "production",
      }),
    ).toBe(false);
  });
});
