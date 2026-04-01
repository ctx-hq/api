import type { RawCandidate } from "./scanner";

const GITHUB_API = "https://api.github.com";
const MCP_REGISTRY_API = "https://registry.modelcontextprotocol.io";
const HOMEBREW_API = "https://formulae.brew.sh/api";

// GitHub topic scanner — finds repos tagged with MCP/skill topics.
export async function importGitHubTopics(sourceKey: string, cursor: string): Promise<RawCandidate[]> {
  // sourceKey: "github:topic:mcp-server"
  const topic = sourceKey.split(":").pop() ?? "";
  const page = cursor ? parseInt(cursor) : 1;

  const resp = await fetch(
    `${GITHUB_API}/search/repositories?q=topic:${topic}+stars:>5&sort=stars&order=desc&per_page=30&page=${page}`,
    { headers: githubHeaders() }
  );

  if (!resp.ok) return [];
  const data = await resp.json() as { items: GitHubRepo[] };

  return (data.items ?? []).map((repo) => {
    const type_ = detectTypeFromTopic(topic);
    const name = sanitizeName(repo.name);
    return {
      external_id: `github:${repo.full_name}`,
      external_url: repo.html_url,
      detected_type: type_,
      detected_name: name,
      generated_manifest: generateManifest(type_, name, repo),
      confidence: calculateConfidence(repo, type_),
      stars: repo.stargazers_count,
      license: repo.license?.spdx_id ?? "",
    };
  });
}

// GitHub file scanner — finds repos containing SKILL.md.
export async function importGitHubSkills(sourceKey: string, cursor: string): Promise<RawCandidate[]> {
  const page = cursor ? parseInt(cursor) : 1;

  const resp = await fetch(
    `${GITHUB_API}/search/code?q=filename:SKILL.md+path:/&per_page=30&page=${page}`,
    { headers: githubHeaders() }
  );

  if (!resp.ok) return [];
  const data = await resp.json() as { items: GitHubCodeResult[] };

  return (data.items ?? []).map((item) => {
    const repoName = item.repository.full_name;
    const name = sanitizeName(item.repository.name);
    return {
      external_id: `github:${repoName}`,
      external_url: item.repository.html_url,
      detected_type: "skill" as const,
      detected_name: name,
      generated_manifest: JSON.stringify({
        name: `@community/${name}`,
        version: "0.0.1",
        type: "skill",
        description: item.repository.description ?? `Skill from ${repoName}`,
        repository: item.repository.html_url,
        skill: { entry: "SKILL.md" },
        install: { source: `github:${repoName}` },
      }),
      confidence: 0.85, // High confidence since SKILL.md exists
      stars: item.repository.stargazers_count ?? 0,
      license: "",
    };
  });
}

// MCP Registry importer — syncs from official MCP registry.
export async function importMCPRegistry(cursor: string): Promise<RawCandidate[]> {
  const params = new URLSearchParams({ limit: "50" });
  if (cursor) params.set("cursor", cursor);

  const resp = await fetch(`${MCP_REGISTRY_API}/v0.1/servers?${params}`);
  if (!resp.ok) return [];

  const data = await resp.json() as { servers: MCPRegistryServer[] };

  return (data.servers ?? []).map((server) => {
    const name = sanitizeName(server.name.split("/").pop() ?? server.name);
    const npmPkg = server.packages?.find((p: { registryType: string }) => p.registryType === "npm");

    return {
      external_id: `mcp:${server.name}`,
      external_url: server.repository ?? `https://registry.modelcontextprotocol.io/servers/${server.name}`,
      detected_type: "mcp" as const,
      detected_name: name,
      generated_manifest: JSON.stringify({
        name: `@community/${name}`,
        version: server.version ?? "0.0.1",
        type: "mcp",
        description: server.description ?? "",
        repository: server.repository ?? "",
        mcp: {
          transport: npmPkg?.transport?.type ?? "stdio",
          command: npmPkg ? "npx" : "",
          args: npmPkg ? ["-y", npmPkg.identifier] : [],
        },
        install: npmPkg ? { npm: npmPkg.identifier } : undefined,
      }),
      confidence: 0.95, // Official registry = high confidence
      stars: 0,
      license: server.license ?? "",
    };
  });
}

// Homebrew popular CLI tools importer.
export async function importHomebrewPopular(cursor: string): Promise<RawCandidate[]> {
  const resp = await fetch(`${HOMEBREW_API}/formula.json`);
  if (!resp.ok) return [];

  const formulas = await resp.json() as BrewFormula[];

  // Filter to popular formulas (>1000 installs in 30d) that are CLI-relevant
  const popular = formulas
    .filter((f) => f.analytics?.install_30d && Object.values(f.analytics.install_30d).reduce((a, b) => a + b, 0) > 1000)
    .slice(0, 50);

  return popular.map((f) => {
    const name = sanitizeName(f.name);
    return {
      external_id: `brew:${f.name}`,
      external_url: f.homepage,
      detected_type: "cli" as const,
      detected_name: name,
      generated_manifest: JSON.stringify({
        name: `@community/${name}`,
        version: f.versions.stable ?? "0.0.1",
        type: "cli",
        description: f.desc ?? "",
        license: f.license ?? "",
        homepage: f.homepage,
        cli: {
          binary: f.name,
          verify: `${f.name} --version`,
        },
        install: {
          brew: f.name,
        },
      }),
      confidence: 0.9,
      stars: 0,
      license: f.license ?? "",
    };
  });
}

// GitHub monorepo scanner — finds repos with multiple SKILL.md files in subdirs.
// Limited to 5 repos per invocation to stay within GitHub API rate limits.
export async function importGitHubMonorepos(_sourceKey: string, cursor: string): Promise<RawCandidate[]> {
  const page = cursor ? parseInt(cursor) : 1;

  // Search for repos that have marketplace.json (strong signal for skill collections)
  // or multiple SKILL.md files via code search.
  const resp = await fetch(
    `${GITHUB_API}/search/code?q=filename:marketplace.json+path:.claude-plugin&per_page=20&page=${page}`,
    { headers: githubHeaders() }
  );

  if (!resp.ok) return [];

  // Check remaining rate limit before proceeding with per-repo calls
  const remaining = parseInt(resp.headers.get("X-RateLimit-Remaining") ?? "100");
  if (remaining < 10) return [];

  const data = await resp.json() as { items: GitHubCodeResult[] };

  const candidates: RawCandidate[] = [];
  const seenRepos = new Set<string>();
  const MAX_REPOS = 5;
  let repoCount = 0;

  for (const item of data.items ?? []) {
    if (repoCount >= MAX_REPOS) break;

    const repoName = item.repository.full_name;
    if (seenRepos.has(repoName)) continue;
    seenRepos.add(repoName);
    repoCount++;

    // Fetch repo info to get default branch, then tree in parallel where possible
    const repoResp = await fetch(
      `${GITHUB_API}/repos/${repoName}`,
      { headers: githubHeaders() }
    );
    if (!repoResp.ok) continue;
    const repoInfo = await repoResp.json() as { default_branch: string };
    const defaultBranch = repoInfo.default_branch ?? "main";

    const treeResp = await fetch(
      `${GITHUB_API}/repos/${repoName}/git/trees/${defaultBranch}?recursive=1`,
      { headers: githubHeaders() }
    );
    if (!treeResp.ok) continue;
    const tree = await treeResp.json() as { tree: { path: string; type: string }[] };

    const skillPaths = (tree.tree ?? [])
      .filter(t => t.type === "blob" && t.path.endsWith("/SKILL.md"))
      .map(t => t.path);

    if (skillPaths.length < 2) continue; // Not a monorepo

    // Generate one candidate per skill
    for (const skillPath of skillPaths) {
      const dir = skillPath.replace(/\/SKILL\.md$/, "");
      const skillName = sanitizeName(dir.split("/").pop() ?? "");
      if (!skillName) continue;

      candidates.push({
        external_id: `github:${repoName}:${dir}`,
        external_url: `${item.repository.html_url}/tree/${defaultBranch}/${dir}`,
        detected_type: "skill" as const,
        detected_name: skillName,
        generated_manifest: JSON.stringify({
          name: `@community/${skillName}`,
          version: "0.0.1",
          type: "skill",
          description: item.repository.description ?? `Skill from ${repoName}/${dir}`,
          repository: item.repository.html_url,
          skill: { entry: "SKILL.md" },
          source: { github: repoName, path: dir, ref: defaultBranch },
        }),
        confidence: 0.80,
        stars: item.repository.stargazers_count ?? 0,
        license: "",
      });
    }
  }

  return candidates;
}

// Helpers

export function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "ctx-scanner/0.1",
  };
  // In production, use GITHUB_TOKEN env var for higher rate limits
  return headers;
}

function detectTypeFromTopic(topic: string): "skill" | "mcp" | "cli" {
  if (topic.includes("mcp") || topic.includes("model-context")) return "mcp";
  if (topic.includes("skill") || topic.includes("agent")) return "skill";
  return "cli";
}

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function calculateConfidence(repo: GitHubRepo, type_: string): number {
  let confidence = 0.5;
  if (repo.stargazers_count > 100) confidence += 0.1;
  if (repo.stargazers_count > 1000) confidence += 0.1;
  if (repo.license) confidence += 0.1;
  if (repo.description) confidence += 0.05;
  if (!repo.archived) confidence += 0.05;
  // Cap at 0.95 — only official registry gets higher
  return Math.min(confidence, 0.95);
}

function generateManifest(type_: string, name: string, repo: GitHubRepo): string {
  const base: Record<string, unknown> = {
    name: `@community/${name}`,
    version: "0.0.1",
    type: type_,
    description: repo.description ?? "",
    repository: repo.html_url,
    license: repo.license?.spdx_id ?? "",
    install: { source: `github:${repo.full_name}` },
  };

  if (type_ === "skill") {
    base.skill = { entry: "SKILL.md" };
  } else if (type_ === "mcp") {
    base.mcp = { transport: "stdio", command: "npx", args: ["-y", repo.full_name] };
  } else if (type_ === "cli") {
    base.cli = { binary: name, verify: `${name} --version` };
    base.install = { source: `github:${repo.full_name}`, brew: name };
  }

  return JSON.stringify(base);
}

// GitHub API types
interface GitHubRepo {
  full_name: string;
  name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  license: { spdx_id: string } | null;
  archived: boolean;
  topics: string[];
}

interface GitHubCodeResult {
  repository: {
    full_name: string;
    name: string;
    html_url: string;
    description: string | null;
    stargazers_count: number;
  };
}

interface MCPRegistryServer {
  name: string;
  description: string;
  version: string;
  repository: string;
  license: string;
  packages: { registryType: string; identifier: string; transport: { type: string } }[];
}

interface BrewFormula {
  name: string;
  desc: string;
  homepage: string;
  license: string;
  versions: { stable: string };
  analytics?: { install_30d?: Record<string, number> };
}
