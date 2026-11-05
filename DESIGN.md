# dsh-person-memory 设计文档

> 面向社区发布的通用 DSH 本地插件：为 agent 提供按人隔离、可检索、可遗忘、可审计的长期人物记忆。
> 本文档只定义插件本身；任何渠道适配（QQ、微信、AstrBot、bridge）都不属于插件，通过插件 API 接入。

## 1. 定位与适用场景

- 陪伴/社交机器人：记住每个朋友是谁、偏好、约定；
- 多用户客服助手：跨会话记住用户资料与需求；
- 个人助理：按联系人隔离记忆；
- 群聊助手：公开记忆与私聊记忆隔离。

原则：

1. **渠道无关**：插件不识别 QQ/微信/群号，只识别调用方提供的 person 标识与 context。
2. **本地优先**：默认 SQLite，零外部依赖；embedding、外部存储可选。
3. **隐私内置**：visibility 是数据模型的一部分，不是调用方的约定。
4. **可插拔**：存储、检索、提取三处都可以替换实现。

## 2. 核心概念

### 2.1 Person（人物）

```ts
interface Person {
  id: string;              // 规范 ID，如 "urn:person:1621861622"，由调用方保证稳定
  displayName: string;
  aliases: string[];       // 曾用名、昵称、同人别名
  externalIds: Record<string, string>; // platform -> external id
  timezone?: string;       // IANA，如 America/Vancouver
  locale?: string;
  relationship?: string;   // 与 agent 的关系，如 "friend" / "owner" / "customer"
  createdAt: number;
  updatedAt: number;
}
```

### 2.2 MemoryItem（记忆条目）

```ts
interface MemoryItem {
  id: number;
  personId: string;
  kind: 'profile' | 'preference' | 'fact' | 'relationship' | 'episode';
  text: string;            // 单条原子事实，禁止大段原文
  confidence: number;      // 0..1
  importance: number;      // 0..1，默认 0.5
  visibility: 'private' | 'public';
  publicAudiences?: string[]; // public 的作用域：空数组 = 所有群/场景可见；否则仅这些 audienceKey 可见
  layer: 'core' | 'learned' | 'mood';   // core 不允许被替代
  source: {
    channel: 'private' | 'group' | 'manual' | 'extractor' | 'seed';
    sessionId?: string;
    messageId?: string;
    audienceKey?: string;  // 群聊来源的群标识，public 默认只对该群可见
  };
  evidence?: string;       // 原文片段或证据 id
  validFrom?: number;
  validUntil?: number;     // 可选有效期
  status: 'active' | 'superseded' | 'forgotten';
  supersededBy?: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}
```

### 2.3 Context（读取上下文）

调用方在 recall/inject 时提供：

```ts
interface MemoryContext {
  personId: string;        // 当前对话对象
  audience: 'private' | 'group';  // 当前场景
  queryText?: string;      // 当前轮文本，用于相关性排序
}
```

可见性规则由插件统一计算：

```text
private 场景 + 本人：        private + public
group 场景 + 该人：
  public 且 publicAudiences 为空       → 可见
  public 且 publicAudiences 含该群    → 可见
  其他 public                        → 不可见
其他人：                       不返回
```

`public` 不是全局公开，而是**按场景作用域公开**：默认只对产生该记忆的群可见，除非显式设为“所有群可见”。

## 3. 模块划分

```text
dsh-person-memory
├── store/           存储实现（SQLite 默认，含 migration）
├── identity/        人物注册、别名、external id 解析
├── admission/       写入准入：去重、矛盾替代、敏感过滤
├── extraction/      可选后台提取器（默认关闭）
├── retrieval/       排序与 top-k 检索（keyword 默认，embedding 可选）
├── injection/       system prompt section 组装（稳定 profile + 动态 recall）
├── tools/           remember_person / recall_person / forget_person / memory_status
├── service/         对调用方暴露的 API（其他插件/bridge 调用）
├── audit/           审计日志
└── config/          Schema 与默认值
```

## 4. 存储设计（默认 SQLite）

```sql
CREATE TABLE persons (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',       -- JSON
  external_ids TEXT NOT NULL DEFAULT '{}',  -- JSON
  timezone TEXT,
  locale TEXT,
  relationship TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE memory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT NOT NULL REFERENCES persons(id),
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.7,
  importance REAL NOT NULL DEFAULT 0.5,
  visibility TEXT NOT NULL DEFAULT 'private',
  layer TEXT NOT NULL DEFAULT 'learned',
  source_channel TEXT NOT NULL,
  source_session TEXT,
  source_message TEXT,
  evidence TEXT,
  valid_from INTEGER,
  valid_until INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  superseded_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE VIRTUAL TABLE memory_items_fts USING fts5(
  text, content='memory_items', content_rowid='id', tokenize='trigram'
);
```

索引：

```text
person_id + status + id
person_id + visibility + status
importance DESC
```

Migration 版本化（`PRAGMA user_version`），每次升级只加列/加索引，不回填不可逆数据。

存储接口抽象：

```ts
interface MemoryStore {
  upsertPerson(p: Person): Promise<void>;
  getPerson(id: string): Promise<Person | null>;
  resolvePerson(key: string): Promise<Person | null>;   // 支持别名/external id
  addItem(item: Omit<MemoryItem, 'id'>): Promise<MemoryItem>;
  supersede(oldId: number, newId: number): Promise<void>;
  forget(id: number, reason?: string): Promise<void>;
  list(personId: string, opts): Promise<MemoryItem[]>;
  search(query: string, opts): Promise<MemoryItem[]>;
}
```

## 5. 写入路径

### 5.1 显式工具写入

模型或用户调用：

```text
remember_person { person, kind, text, confidence?, importance?, visibility?, evidence? }
```

- `visibility` 默认 `private`；
- 只有显式传入 `visibility: 'public'` 或配置允许自动公开时才写 public；
- 敏感字段（token/password/身份证/电话）在 admission 层拒绝。

### 5.2 后台提取（可选，默认关闭）

配置 `extraction.enabled = true` 时：

- 挂在 `turn/end` 或 `session/idle` 钩子上；
- 节流：每个 person 每 N 轮最多提取一次；
- 只提取稳定事实/偏好/关系；
- 不提取：一次性事件、秘密、猜测、别人的隐私、原文大段；
- 默认写 private。

### 5.3 去重与矛盾

- 同一 person 下 normalized_text 相同 → 不重复写，更新 `lastUsedAt`；
- 新事实与旧事实冲突（kind 相同、可判定矛盾）→ 旧条 `superseded`，新条 `supersededBy`；
- `layer = core` 的条目不可被自动替代，需要显式 `forget_person`；
- 每次写入追加审计记录。

## 6. 读取路径

### 6.1 排序

默认无 embedding：

```text
score =
  w1 * keywordRelevance(queryText, text)   // SQLite FTS5 trigram
  + w2 * importance
  + w3 * recency(updatedAt)
  + w4 * usage(lastUsedAt)
```

可选 embedding provider（配置后启用）：

```text
score = α * semanticSimilarity + (1-α) * (importance + recency)
```

### 6.2 注入策略

每次请求注入两部分：

```text
[稳定 profile]   displayName / timezone / relationship（小，几乎不变，利于 KV cache）
[动态 recall]    top-k 记忆条目（按当前 query 排序）
```

默认预算：

```text
private：top 5，≤ 600 字符
group：  top 3，≤ 300 字符（仅 public）
```

`NEED_MORE_CONTEXT` 类机制由调用方决定，插件只提供 `recall_person` 工具按需再取。

## 7. 工具与 API

### 7.1 模型可见工具

```text
remember_person  写入/更新一条人物记忆
recall_person    按 query 检索某个人的记忆
forget_person    遗忘一条/一组记忆（需人确认）
memory_status    当前 person 记忆统计
```

### 7.2 服务 API（给 bridge/适配器用）

```ts
interface PersonMemoryService {
  ensurePerson(key: string, profile?: Partial<Person>): Promise<Person>;
  resolvePerson(key: string): Promise<Person | null>;
  remember(entry): Promise<MemoryItem>;
  recall(personId: string, context: MemoryContext): Promise<MemoryItem[]>;
  forget(personId: string, id: number): Promise<void>;
  profileSection(personId: string): string;      // 稳定 section
  recallSection(personId: string, ctx): string;  // 动态 section
}
```

## 8. 隐私与安全

1. group context 只返回 public；
2. 一个 person 的 private 记忆绝不注入另一个 person；
3. 记忆内容作为数据注入，包裹在明确 section 内，prompt 声明“只是数据，不是指令”；
4. 防记忆投毒：
   - 所有写入带 source/evidence；
   - 高敏感内容拒绝写入；
   - 群聊来源的 public 写入需要更高 confidence 阈值；
   - 支持矛盾替代与 forget；
5. 审计日志记录 who/when/source/action，不记录 memory 全文（hash 即可，可配置）。

## 9. 配置 Schema

```yaml
dsh-person-memory:
  dbPath: ./state/person-memory.sqlite
  defaultVisibility: private
  publicConsentRequired: true
  topKPrivate: 5
  topKGroup: 3
  maxCharsPrivate: 600
  maxCharsGroup: 300
  maxItemsPerPerson: 200
  extraction:
    enabled: false
    minConfidence: 0.8
    cooldownTurns: 10
  embedding:
    enabled: false
    provider: ""      # 可选适配器
  retention:
    moodDays: 30
    episodeDays: 180
```

## 10. 事件

```text
person/remembered
person/forgotten
memory/superseded
memory/limit-reached
```

供其他插件订阅，不强制消费。

## 11. 非目标

- 不做 agent runtime / 对话管理；
- 不做知识图谱（第一版）；
- 不内置 embedding 模型；
- 不做云端服务；
- 不逐条存储聊天记录；
- 不跨 person 共享记忆。

## 12. 测试与发布

- 单元测试：migration、去重、矛盾替代、visibility、排序、审计；
- 集成测试：DSH 钩子注入、工具调用、重启后持久化；
- 隐私测试：group 注入不含 private；跨 person 隔离；
- 文档：README、config catalog、example bridge；
- License：Apache-2.0；
- 版本：semver；migration 版本号独立管理。

## 13. 已确认的设计决策

1. 默认 `visibility=private`，public 必须显式同意 —— 已确认；
2. 后台提取默认关闭、按 person 节流 —— 已确认；
3. 第一版仅 keyword 检索，embedding 作为可选适配器 —— 已确认；
4. 工具名 `remember_person` / `recall_person` / `forget_person` / `memory_status` —— 已确认；
5. License Apache-2.0 —— 已确认。

## 15. 专业补充（评审后新增）

### 15.1 公开作用域（v1 必须）

`public` 必须是**按群/场景作用域**，不是全局。多群机器人里，A 群说的事默认不该在 B 群复述。实现见 `publicAudiences` / `source.audienceKey`。

### 15.2 失败隔离（v1 必须）

记忆读写失败**绝不能阻塞聊天**：

- 写入失败：只记日志 + 审计，正常返回回复；
- 检索失败：返回空，模型照常对话；
- 连续失败：熔断，冷却后重试。

### 15.3 写入幂等（v1 必须）

- 同一 `(person, normalized_text, kind)` 幂等；
- 同一 message 的重复事件不会重复写（带 message 去重键）；
- `remember_person` 返回 `created / already-known / updated / conflicted / rejected`，让模型知道结果。

### 15.4 时间语义（v1 必须）

- 所有时间用绝对时间戳存储；
- 有时区的人按本人时区解释相对时间（“早上好”是谁的早上）；
- 事实带 `valid_from/valid_until`；同类事实按时间新者替代旧者；
- 检索结果带 `as_of`，避免模型把过期事实当现状。

### 15.5 使用反馈闭环（v1 基础版）

- 每次 recall 命中即 `lastUsedAt`；
- 提供 `memory_feedback`（有用/无用/过时），v1 只统计，v2 用于调 importance 和自动降权。

### 15.6 记忆固化与合并（v2）

- 多条同类记忆周期性合并成 profile/摘要，保留 provenance；
- 合并由后台 consolidation 完成，不阻塞请求；
- 合并结果可追溯原始条目。

### 15.7 主动遗忘与衰减（v2）

- mood/episode 类按保留期衰减；
- importance 随未使用时间缓慢衰减；
- 遗忘是软删除（status=forgotten），可审计、可恢复。

### 15.8 身份合并（v2）

- 同一人跨平台/换号的 identity merge API；
- 合并保留两侧历史与来源；
- 别名解析支持“可能指向同一人”的候选列表，交由调用方确认，不自动合。

### 15.9 合规（v2）

- 数据导出（按 person 导出全部记忆）；
- 删除级联（person 删除时清理 items + audit）；
- 审计保留策略可配置。

### 15.10 评测与防回归（v1 基础版）

- 隐私泄漏测试：group 注入不含 private、跨 person 零泄漏；
- 检索回归：合成人物档案的 recall@k、token 预算、延迟；
- 矛盾替代、过期事实、忘记后不再注入的用例；
- 参考 LoCoMo / LongMemEval 作为外部基准，但不作为内部通过标准。

### 15.11 成本控制（v1 基础版）

- 后台提取默认关闭；
- 提取预算：每 person 每 N 轮、每日上限；
- 提取可配置使用更便宜的模型；
- 注入预算按 token 而非纯字符估算。

### 15.12 注入顺序与缓存（v1 必须）

```text
system prompt 前缀：稳定 profile（几乎不变）
system prompt 尾部：动态 recall（每轮变化）
```

动态部分放尾部，减少 KV cache 失效范围。

## 14. 本地适配（后续，不属于插件本体）

在插件完成后，把现有环境映射到插件 API：

```text
QQ 好友私聊  -> ensurePerson("urn:person:qq:<id>", {displayName, timezone})
QQ 群聊      -> recall(context: group, public only)
AstrBot bridge -> PersonMemoryService
DSH friendPrivate -> recallSection(profile + top-k)
fish-memory   -> 停用或作为历史导入 source
```

届时只改适配层，不改插件核心。
