# ctx Registry API

[![CI](https://github.com/ctx-hq/api/actions/workflows/ci.yml/badge.svg)](https://github.com/ctx-hq/api/actions/workflows/ci.yml)
[![Deploy](https://github.com/ctx-hq/api/actions/workflows/deploy.yml/badge.svg)](https://github.com/ctx-hq/api/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Hono](https://img.shields.io/badge/Hono-E36002?logo=hono&logoColor=white)](https://hono.dev)

[English](README.md)

[getctx.org](https://getctx.org) 包注册中心 API —— 发现、发布和解析 Claude Code 技能、MCP 服务器和 CLI 工具。

基于 [Hono](https://hono.dev) 构建，运行于 Cloudflare Workers，使用 D1、R2、KV 作为存储。

## 功能特性

- **包管理** — 作用域包（`@scope/name`），遵循语义化版本
- **全文搜索** — 基于 FTS5 索引，支持名称、描述、关键词搜索
- **版本解析** — 约束表达式解析（`^`、`~`、`>=`、`*`、精确匹配）
- **组织管理** — 创建组织，管理成员与角色
- **认证发布** — 基于 GitHub OAuth 的设备授权流程
- **扫描管道** — 自动从 GitHub、MCP Registry、Homebrew 发现包
- **Agent 友好** — `GET /:fullName.ctx` 返回纯文本安装说明

## 快速开始

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

## 可用脚本

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 本地开发服务器 |
| `pnpm test` | 运行测试 |
| `pnpm test:watch` | 监听模式运行测试 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm db:migrate` | 本地应用 D1 迁移 |
| `pnpm deploy` | 部署到 Cloudflare Workers |

## API 端点

### 包管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/packages` | 包列表（支持 `type` 筛选，`downloads`\|`created` 排序） |
| GET | `/v1/packages/:fullName` | 包详情及版本历史 |
| GET | `/v1/packages/:fullName/versions` | 版本列表 |
| GET | `/v1/packages/:fullName/versions/:version` | 指定版本详情 |

### 发布（需认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/publish` | 发布包版本（multipart：manifest + 归档） |
| POST | `/v1/yank/:fullName/:version` | 撤回版本 |

### 搜索与解析

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/search?q=` | 全文搜索 |
| POST | `/v1/resolve` | 批量版本约束解析 |
| GET | `/v1/packages/:fullName/resolve/:constraint` | 单包约束解析 |
| GET | `/:fullName.ctx` | Agent 可读安装说明 |

### 下载

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/download/:fullName/:version` | 下载 Formula 归档 |

### 认证

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/auth/device` | 发起设备授权流程 |
| POST | `/v1/auth/token` | 轮询获取访问令牌 |
| GET | `/v1/auth/callback` | GitHub OAuth 回调 |

### 组织管理（需认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/orgs` | 创建组织 |
| GET | `/v1/orgs/:name` | 组织详情 |
| GET | `/v1/orgs/:name/members` | 成员列表 |
| POST | `/v1/orgs/:name/members` | 添加成员（owner/admin） |
| DELETE | `/v1/orgs/:name/members/:username` | 移除成员（owner） |

### 扫描器（管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/scanner/candidates` | 已发现候选包列表 |
| POST | `/v1/scanner/run` | 手动触发扫描 |
| POST | `/v1/scanner/candidates/:id/approve` | 审批并导入 |
| POST | `/v1/scanner/candidates/:id/reject` | 拒绝候选 |
| GET | `/v1/scanner/stats` | 扫描统计 |

### 系统

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 注册中心元信息 |
| GET | `/v1/health` | 健康检查 |

## 项目结构

```
src/
├── index.ts              # 应用入口，路由挂载，错误处理
├── bindings.ts           # Cloudflare 绑定类型
├── models/types.ts       # 共享 TypeScript 接口
├── routes/               # HTTP 端点处理器
├── services/             # 业务逻辑
├── middleware/            # 认证、CORS、限流
└── utils/                # 命名校验、语义版本、错误类型
migrations/               # D1 SQL 迁移（0001–0005）
test/                     # Vitest 测试
```

### Cloudflare 绑定

| 绑定 | 类型 | 用途 |
|------|------|------|
| DB | D1 | 包元数据、用户、组织 |
| FORMULAS | R2 | Formula 归档存储（tar.gz） |
| CACHE | KV | 限流、设备授权流程状态 |

## 包命名规范

采用作用域命名：`@scope/name`

- 作用域和名称：小写字母、数字、连字符
- 示例：`@anthropic/claude-skill`、`@community/my-tool`

## 版本约束

| 约束 | 匹配规则 |
|------|----------|
| `*` / `latest` | 最高可用版本 |
| `^1.2.3` | `>=1.2.3` 且 `<2.0.0` |
| `~1.2.3` | `>=1.2.3` 且 `<1.3.0` |
| `>=1.2.3` | 任何 `>=1.2.3` 的版本 |
| `1.2.3` | 精确匹配 |

## 限流

- 每 IP 每分钟 180 次请求
- 作用于所有 `/v1/*` 端点
- 超限返回 `429 Too Many Requests` 及 `Retry-After` 头

## 部署

需在 GitHub Actions 中配置 `CLOUDFLARE_API_TOKEN` 密钥。推送到 `main` 分支自动触发部署。

```bash
pnpm deploy
```

## 许可证

[MIT](LICENSE) © ctx-hq
