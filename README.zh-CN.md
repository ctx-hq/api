# ctx Registry API

[![CI](https://github.com/ctx-hq/registry/actions/workflows/ci.yml/badge.svg)](https://github.com/ctx-hq/registry/actions/workflows/ci.yml)
[![Deploy](https://github.com/ctx-hq/registry/actions/workflows/deploy.yml/badge.svg)](https://github.com/ctx-hq/registry/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Hono](https://img.shields.io/badge/Hono-E36002?logo=hono&logoColor=white)](https://hono.dev)

[English](README.md)

[getctx.org](https://getctx.org) 的后端 API —— 一个开放的注册中心，用于发现、发布和安装 Claude Code 技能、MCP 服务器和 CLI 工具。

```
ctx install @anthropic/claude-skill    # 一条命令搞定
```

基于 [Hono](https://hono.dev) 构建，运行于 Cloudflare Workers。零冷启动，全球分布。

## 为什么需要 ctx？

AI 编程助手（Claude Code、Cursor、Windsurf 等）需要一种统一的方式来发现和安装工具。ctx 提供：

- **包注册中心** —— 管理技能、MCP 服务器和 CLI 工具
- **一键安装** —— 自动配置到所有支持的 AI 助手
- **混合搜索** —— FTS 全文 + 向量语义，精准找到合适的工具
- **开放协议** —— `GET /:fullName.ctx` 返回任何 Agent 都能解析的纯文本指令

## 快速开始

```bash
# 克隆并安装
git clone https://github.com/ctx-hq/registry.git && cd registry
pnpm install

# 配置 Cloudflare 资源
cp wrangler.toml.example wrangler.toml
# 编辑 wrangler.toml —— 填入你的 D1 database_id

# 创建本地数据库并启动
pnpm db:migrate
pnpm dev
```

## 参与贡献

### 环境要求

- Node.js 22+, pnpm 10+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`pnpm add -g wrangler`)
- Cloudflare 账号（免费计划即可）

### 初始化

1. **复制配置模板：**
   ```bash
   cp wrangler.toml.example wrangler.toml
   ```

2. **创建 Cloudflare 资源**（仅首次）：
   ```bash
   wrangler d1 create ctx-registry       # 将 database_id 填入 wrangler.toml
   wrangler r2 bucket create ctx-formulas
   ```

3. **设置密钥**（GitHub OAuth）：
   ```bash
   wrangler secret put GITHUB_CLIENT_SECRET
   ```

4. **应用迁移并运行：**
   ```bash
   pnpm db:migrate
   pnpm dev
   ```

### 可用脚本

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 本地开发服务器（端口 8787） |
| `pnpm test` | 运行测试（Vitest） |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm db:migrate` | 本地应用 D1 迁移 |
| `pnpm deploy` | 部署到 Cloudflare Workers |

### CI/CD

推送到 `main` 分支自动触发部署。需配置以下 GitHub Secrets：

| Secret | 用途 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | Wrangler 部署认证 |
| `D1_DATABASE_ID` | D1 数据库标识符 |

## API 参考

### 包管理

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/v1/packages` | — | 包列表（筛选：`type`、`category`；排序：`downloads`、`created`） |
| GET | `/v1/packages/:fullName` | — | 包详情，含版本历史和分类 |
| GET | `/v1/packages/:fullName/versions` | — | 版本列表 |
| GET | `/v1/packages/:fullName/versions/:version` | — | 版本详情（manifest、readme、发布者用户名） |

### 搜索与解析

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/v1/search?q=&mode=` | — | 搜索（模式：`fts`、`vector`、`hybrid`） |
| POST | `/v1/resolve` | — | 批量版本约束解析 |
| GET | `/v1/packages/:fullName/resolve/:constraint` | — | 单包版本约束解析 |
| GET | `/:fullName.ctx` | — | Agent 可读安装指令（纯文本） |
| GET | `/v1/categories` | — | 分类列表及包数量 |

### 发布

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | `/v1/publish` | Bearer | 发布版本（multipart：manifest + 归档） |
| POST | `/v1/yank/:fullName/:version` | Bearer | 撤回版本 |
| GET | `/v1/download/:fullName/:version` | — | 下载 Formula 归档 |

### 认证与账户

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | `/v1/auth/device` | — | 发起设备授权流程 |
| POST | `/v1/auth/token` | — | 轮询获取访问令牌 |
| POST | `/v1/auth/github` | — | GitHub OAuth 换取 token |
| GET | `/v1/me` | Bearer | 当前用户信息 |
| GET | `/v1/me/tokens` | Bearer | 列出 API token（不暴露 token 值） |
| POST | `/v1/me/tokens` | Bearer | 创建命名 token（可选：`expires_in_days`） |
| DELETE | `/v1/me/tokens/:id` | Bearer | 撤销 token |
| DELETE | `/v1/me` | Bearer | 删除账户（匿名化 PII，转移包所有权） |

### 组织管理

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | `/v1/orgs` | Bearer | 创建组织 |
| GET | `/v1/orgs/:name` | — | 组织详情 |
| GET | `/v1/orgs/:name/members` | Bearer | 成员列表（仅成员可查） |
| POST | `/v1/orgs/:name/members` | Bearer | 添加成员（owner/admin） |
| DELETE | `/v1/orgs/:name/members/:username` | Bearer | 移除成员（owner） |

### 扫描器（管理员）

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/v1/scanner/sources` | Bearer | 扫描源列表 |
| GET | `/v1/scanner/candidates` | Bearer | 已发现候选包 |
| GET | `/v1/scanner/candidates/:id` | Bearer | 候选详情 |
| POST | `/v1/scanner/run` | Admin | 手动触发扫描 |
| POST | `/v1/scanner/candidates/:id/approve` | Admin | 审批并导入 |
| POST | `/v1/scanner/candidates/:id/reject` | Admin | 拒绝候选 |
| GET | `/v1/scanner/stats` | Bearer | 扫描统计 |

## 项目结构

```
src/
├── index.ts                # 入口，中间件，错误处理，定时任务
├── bindings.ts             # Cloudflare 绑定类型定义
├── models/types.ts         # 共享 TypeScript 接口
├── routes/                 # HTTP 处理器
│   ├── auth.ts             # OAuth、Token 管理、账户删除
│   ├── packages.ts         # 包 CRUD
│   ├── search.ts           # FTS + 向量混合搜索
│   ├── publish.ts          # 包发布
│   ├── resolve.ts          # 批量版本解析
│   ├── versions.ts         # 单包版本解析
│   ├── download.ts         # 归档下载
│   ├── orgs.ts             # 组织管理
│   ├── scanner.ts          # 包发现管道
│   ├── agent.ts            # /:fullName.ctx Agent 端点
│   ├── categories.ts       # 分类列表
│   └── health.ts           # 健康检查
├── services/               # 业务逻辑
│   ├── scanner.ts          # GitHub 主题扫描器
│   ├── importer.ts         # 候选 → 包导入
│   ├── enrichment.ts       # LLM 驱动的元数据增强
│   ├── search.ts           # 混合搜索引擎
│   ├── categories.ts       # 分类种子数据和查询
│   └── publish.ts          # 发布校验
├── middleware/
│   ├── auth.ts             # Bearer Token 认证
│   ├── security-headers.ts # 安全响应头 + CORS
│   └── rate-limit.ts       # 按用户/IP 限流
└── utils/                  # 命名校验、语义版本、错误、响应工具
migrations/                 # D1 SQL 迁移（0001–0009）
test/                       # Vitest 测试
```

### Cloudflare 绑定

| 绑定 | 类型 | 用途 |
|------|------|------|
| DB | D1 | 包元数据、用户、组织、审计日志 |
| FORMULAS | R2 | Formula 归档存储（tar.gz） |
| CACHE | KV | 限流、设备授权流程状态 |
| VECTORIZE | Vectorize | 包嵌入索引，用于语义搜索 |
| AI | Workers AI | 嵌入生成和元数据增强 |
| ENRICHMENT_QUEUE | Queue | 异步增强管道 |

### 安全机制

- **认证**：SHA-256 哈希 Bearer Token（高熵无盐 —— 与 GitHub/npm 同方案）
- **限流**：匿名 180 次/分/IP，认证用户 600 次/分/用户（按 user_id 计数，防多 token 绕过）
- **安全头**：`X-Content-Type-Options`、`X-Frame-Options`、`Content-Security-Policy`、`Referrer-Policy`
- **账户删除**：完整 PII 匿名化（唯一 tombstone），包所有权转移至哨兵用户
- **数据最小化**：API 响应不暴露内部 UUID；`published_by` 通过 JOIN 返回用户名

## 包命名规范

采用作用域命名：`@scope/name`

- 作用域和名称：小写字母、数字、连字符
- 示例：`@anthropic/claude-skill`、`@community/github-mcp`

## 许可证

[MIT](LICENSE) © ctx-hq
