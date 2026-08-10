# Cache drop 分析与实施方案

> 分析对象：`/Users/bole/.config/mock-ollama/cache-drops.jsonl`、`src/log_store.ts`、`src/router.ts`、`tests/matrix.test.ts`。本文只提供实施方案，不修改业务源码。

## 1. 数据统计（可复算）

采样文件实际为 **666 条 JSON 记录、约 11M**（用户提供的“560 条、约 10MB”与文件当前内容不一致；以下数字以文件读取结果为准）。时间范围 `2026-08-04 18:29:22.258` 至 `2026-08-06 15:54:01.890`；全部为 `POST /v1/messages`、模型 `gpt-5.6-terra`，包含 32 个 `cacheScope`。

```bash
wc -l /Users/bole/.config/mock-ollama/cache-drops.jsonl
du -h /Users/bole/.config/mock-ollama/cache-drops.jsonl
python3 - <<'PY'
import json, statistics, collections
p='/Users/bole/.config/mock-ollama/cache-drops.jsonl'
r=[json.loads(x) for x in open(p)]
print('records',len(r),'first',min(x['time'] for x in r),'last',max(x['time'] for x in r))
for k in ('cacheScope','model','path'):
 print(k,collections.Counter(x.get(k) for x in r).most_common())
for k in ('lostTokens','prevCacheRead','currentCacheRead'):
 a=[x[k] for x in r]; print(k,'min/max/sum/mean/median',min(a),max(a),sum(a),statistics.mean(a),statistics.median(a))
print('diff_count',collections.Counter(len(x['diffs']) for x in r))
print('no_diffs',sum(not x['diffs'] for x in r))
print('index0',sum(any(d['index']==0 for d in x['diffs']) for x in r))
print('append_or_remove',sum(any(d['last'] is None or d['new'] is None for d in x['diffs']) for x in r))
PY
```

复核结果：`lostTokens` 最小/最大/总和/平均/中位数为 `1024/143360/9359360/14053.09/8192`；`prevCacheRead` 为 `8704/160256/27694080/41582.70/34304`；`currentCacheRead` 为 `7680/142848/18334720/27529.61/19968`。所有记录都有 diff；538/666 记录含 index 0 变化，631/666 含消息新增或删除（`last`/`new` 为 null）。由于当前实现只在内存中保留最近 200 条日志，JSONL 是更完整的长期证据。

## 2. 当前实现与边界

### 2.1 检测流程

`src/log_store.ts:43-51` 的 `extractCacheRead` 依次读取：`usage.cache_read_input_tokens`、`usage.input_tokens_details.cached_tokens`、`usage.prompt_tokens_details.cached_tokens`，只接受非负有限 number。

`src/log_store.ts:89-124` 的 `addLogEntry` 仅对 `POST + cacheScope + response` 生效，向后倒序查找**同 cacheScope 的最近一条 POST**；找到可读 cache counter 后，若 `currentCacheRead < prevCacheRead`，记录 `lostTokens = prev-current`、两条 log id 和 `computeMessageDiff` 结果，并异步追加 JSONL。比较后立即 `break`，不会继续查更早样本。

`src/log_store.ts:53-66` 的 `computeMessageDiff` 仅比较 `request.messages` 数组按位置的 `content` 文本。数组中 content 为字符串直接使用；数组 content 只拼接 block 的 `text`；其他值使用 `JSON.stringify`。它不比较 role、name、tool_call、tool result、system、Responses 的 `input`、模型/参数、顺序以外的结构。

`src/router.ts:51-91` 的 scope：Responses 使用客户端 `prompt_cache_key`；Messages 使用 system 文本 SHA-1 前 8 位；Chat 使用第一条 message 文本 SHA-1 前 8 位。`src/router.ts:41-49` 的 session id 优先取三个 header，再退回 `prompt_cache_key`。bridge 转换前在 `convertedRequestWithLog` 记录入站 body（`src/router.ts:216-282`），透传在 `proxyChatRequest` 记录原 body（`src/router.ts:94-214`）。

### 2.2 误判/漏报

* 误判：同 scope 的并发/乱序响应按 `logEntries` 完成顺序配对；较晚请求先完成时，会与错误的上一请求比较。scope 仅由 system/首消息/外部 key 决定，不能保证同一实际缓存前缀。
* 误判：counter 下降可能是上游计数口径改变、采样/批处理、跨模型或 provider 缓存重建，不一定是前缀丢失；当前无 counter 来源、请求序号、响应完成时间、上游 request id。
* 误判：system 变化在 Messages 中改变 scope，通常不会触发 drop，导致真实 system 变化被排除在比较之外；Chat scope 只看首条消息，首条 role 或非 text 属性变化可漏掉。
* 漏报：counter 缺失、字符串数字、嵌套未知 usage 字段、只在 SSE 中未被 `responseBodyForLog` 保留的 usage 都不会检测。
* 漏报：counter 持平但缓存重建、counter 上升但实际前缀失效、跨 scope 的 drop、第一条样本 drop、超过 200 条后内存上下文丢失。
* 漏报/错误归因：消息重写同一 index 的内容会被报告，但新增/删除会造成大量后续位置 diff，不能区分“单条重写”和“尾部截断”；动态元数据/工具定义不在 diff 中。
* 持久化问题：`void appendCacheDropSample` 不等待；多请求并发 `appendFile` 没有队列/锁，进程崩溃可能丢行或交错；文件无限增长；日志中当前 diff 原文可包含系统指令、用户 prompt、路径和工具参数。

## 3. 分级实施方案

### P0：先保证可解释、可安全持久化

**文件：`src/log_store.ts`。**

1. 扩展类型：

```ts
type CacheCounter = { value: number; source: 'anthropic'|'responses'|'chat'|'unknown' };
type CacheDropKind = 'system_change'|'message_rewrite'|'context_truncation'|'metadata_change'|'counter_only'|'unknown';
type CacheDrop = { lostTokens:number; prevCacheRead:number; currentCacheRead:number;
  prevLogId:number; evidence: CacheDropKind[]; confidence:'high'|'medium'|'low';
  diffSummary: DiffSummary; counterSource?: string; }
type DiffSummary = { changed:number; added:number; removed:number; firstChanged?:number;
  commonPrefix:number; commonSuffix:number; rolesChanged:boolean; metadataChanged:boolean; systemChanged:boolean; };
```
保持旧字段 `lostTokens/prevCacheRead/currentCacheRead`，新增字段向前兼容。

2. 将 `extractCacheRead` 改为 `extractCacheCounter(response): CacheCounter|undefined`，按已支持的三个路径返回 source；字符串数字默认拒绝，避免静默改变口径。
3. 新增 `computeRequestFingerprint(request)` 和 `summarizeRequestDiff(prev,current)`：规范化 JSON（排序对象 key、保留数组顺序），分别计算 system、messages/input、tools、采样参数、model 的 SHA-256（只落 hash）；消息比较同时包含 `role`、content block type/text、tool call id/name/arguments。保留 `computeMessageDiff` 作为兼容 API，但不再把全文写入长期日志。
4. 增加串行写队列：

```ts
let writeTail = Promise.resolve();
function enqueueCacheDrop(sample: unknown) {
  writeTail = writeTail.then(async () => {
    await mkdir(dirname(path), {recursive:true});
    await appendFile(path, JSON.stringify(sample)+'\\n', {encoding:'utf8', flag:'a'});
  }).catch(e => console.error('append cache drop sample failed:', e));
  return writeTail;
}
```
`appendCacheDropSample` 返回该 Promise；调用处可 `void`，但测试必须 `await flushCacheDropWrites()`。单进程串行保证顺序；多进程部署用 lockfile（`open(path+'.lock','wx')` + finally unlink，退避并设置超时）或改为每进程独立文件后由 collector 合并，不能声称 appendFile 可提供跨进程记录原子性。
5. 增加 `CACHE_DROPS_MAX_BYTES`（默认 50 MiB）、`CACHE_DROPS_RETENTION`（默认 7 天）和轮转：写入前检查 size，重命名为 `.1`…`.N`，使用 `rename`；保留 gzip/删除策略由配置控制。轮转和 append 共用队列。

**文件：`src/router.ts`。**

6. 对每次请求记录 `requestId`（UUID）、`startedAt`、`completedAt`、`cacheScopeKind`、`scopeInputHash`、`cacheCounterSource`；同一 requestId 贯穿转换和上游 headers。请求 scope 不应只由 system/首消息构成：使用 `deriveCacheScope`，优先可信 `prompt_cache_key`，否则为 `sessionId + model + route + systemHash + prefixHash`；scope 输入原文只做内存处理。
7. 在 `requestCacheScope` 不把空 system/空首消息当成“无 scope”后盲目比较；返回 `{id, kind, confidence}`，桥接后保留 inbound 与 upstream 两个 scope 字段，避免转换导致无法关联。

### P1：分类变化来源并降低归因错误

在 `log_store.ts` 新增纯函数 `classifyCacheDrop(prev,current): CacheDropEvidence`。伪代码：

```ts
const d = summarizeRequestDiff(prev.request, current.request);
const evidence = [];
if (d.systemChanged) evidence.push('system_change');
if (d.commonPrefix < d.prevLength && d.commonPrefix === d.currentLength)
  evidence.push('message_rewrite');
if (d.currentLength < d.prevLength && d.commonPrefix === d.currentLength)
  evidence.push('context_truncation');
if (d.metadataChanged && d.commonPrefix === Math.min(d.prevLength,d.currentLength))
  evidence.push('metadata_change');
if (!evidence.length) evidence.push('counter_only');
return { evidence, confidence: d.rolesChanged || d.unknownContent ? 'low' : 'medium' };
```

* **system 变化**：Messages 的 `system` 字符串或 block 规范化 hash 改变；必须单独字段，不依赖 messages diff。
* **消息重写**：同 role/index 的 content 或 tool arguments 改变，且前缀在改写点后仍存在；记录 `firstChanged` 和改写前后 token/字符长度。
* **上下文截断**：新消息是旧消息的严格前缀（尾部移除），或显式 `truncation`/`context_management` 字段；仅有长度变短不足以定论，标 low confidence。
* **动态元数据**：`temperature/top_p/max_tokens/metadata/tools/tool_choice/parallel_tool_calls/store` 等改变但消息 prefix hash 不变，归入 metadata_change；工具 schema 应 hash，不落原文。

P1 同时在 `src/router.ts` 对 Responses 的 `input`（字符串、message item、output item）建立统一 `normalizeConversation`; 对 Chat/Anthropic 走各自字段适配。未知结构生成 `unknownContent: true`，禁止 high confidence。

### P2：脱敏、查询和可观测性

**文件：`src/log_store.ts`（或新建 `src/cache_drop.ts` 并从 log_store 导出）。**

实现 `sanitizeForCacheLog(value, policy)`：默认不保存 request/response 全文；仅保存长度、元素数量、角色计数、SHA-256 截断 hash（至少 16 hex）、首尾 token 数等统计。递归限制深度/字段数/字符串长度；字段名匹配 `authorization|api[_-]?key|token|password|secret|cookie|path` 时替换 `[REDACTED]`。现有 JSONL 中已暴露 `last/new` 全文，应将旧文件 chmod 0600 后按 retention 删除或离线脱敏重写，不要继续复制到新日志。

增加 `GET /api/cache-drops`（`src/router.ts`）只返回聚合统计/已脱敏 evidence；默认禁止全文 diff；增加 limit、时间范围和 scope hash 过滤。可选 SSE 事件 `cache-drop`，但只发送脱敏摘要。

## 4. 具体测试和验收指标

**文件：`tests/matrix.test.ts`**（或新增 `tests/cache_drop.test.ts`，推荐拆分）。

1. `extractCacheCounter` 覆盖三个 usage 路径、0、负数、Infinity、字符串和未知路径。
2. 纯函数分类：system-only；单条 user content 重写；尾部消息删除；中间消息删除（不得判为高置信截断）；tools/metadata-only；未知 block；counter-only。
3. 同 scope counter 10000→8000 产生 `lostTokens=2000`，且只落 hash/summary，不落 prompt；同 counter、上升、缺失均不产生 drop。
4. 两个 scope 交错完成、不同 requestId 的并发测试，验证按 request predecessor/序列而非完成顺序错误配对；首条和跨 scope 不报警。
5. 666 行回放测试：JSONL 每行可解析，分类总数等于 drop 数，任意输出不含 system 指令、API key、绝对路径和 message 原文（用敏感词/路径断言）。
6. 并发 append 1000 条，行数必须 1000、每行 JSON 完整；模拟一次写失败后后续写入仍可进行；轮转触发后旧文件存在、总大小不超过配置上限（允许单行上限加成）。
7. 三协议桥接分别验证 Anthropic `system/messages`、Responses `input`、Chat `messages` 都产生一致 normalized hashes，且日志 requestId 在 SSE/非 SSE 完成后唯一。

验收指标：无未解释 JSONL 写入失败；单进程并发记录 1000/1000 可解析；分类测试高置信 precision ≥95%（人工标注至少 200 条）；真实 drop recall ≥90%（以相同标注集为准）；敏感字段泄漏率 0；轮转后磁盘上限符合配置；API 旧 `cacheDrop` 三字段兼容率 100%；现有 `npm run verify` 全绿。

## 5. 分阶段迁移与回滚

1. **观测阶段（1 个版本）**：先只增加 requestId、counter source、normalized hash 和 summary，保留旧三字段；用 feature flag `MOCK_OLLAMA_CACHE_DROP_V2=shadow`，V2 只写旁路 `.v2.jsonl`，不改变告警。
2. **双写阶段（1 个版本）**：V1/V2 都写，随机抽样比较配对和分类；启用串行队列、0600 权限、轮转。以验收指标连续 24 小时达标后默认 V2。
3. **切换阶段**：`MOCK_OLLAMA_CACHE_DROP_MODE=v2`，API 返回 V2 evidence；保留旧字段和旧文件读取兼容 7 天。提供 `flushCacheDropWrites`/启动恢复检查，异常时降级为内存摘要并计数 `cache_drop_write_errors`。
4. **清理阶段**：确认下游不依赖全文 `diffs` 后停止写全文，按 retention 删除旧文件；不得自动删除用户文件，删除前需明确配置和备份。
5. **回滚**：将 mode 设回 `v1` 或关闭 `MOCK_OLLAMA_CACHE_DROPS_PATH`，重启进程；V2 文件只读保留，V1 三字段继续可解析。若写队列/轮转故障，临时切换独立 per-process 文件；禁止直接 `git revert` 正在写入的日志路径配置而不先 drain 队列。回滚验收：请求代理成功率不下降、日志写入错误为 0、旧测试全绿。

## 6. 实施顺序与注意事项

先落地 `log_store.ts` 的类型/规范化/分类纯函数和可测试写队列，再接入 `router.ts` requestId 与协议适配，最后开放 API 和默认脱敏。不要在 `addLogEntry` 继续用“同 scope 最近 POST + 完成顺序”作为唯一关联依据；不要把 SHA-1 8 位 hash 当作安全脱敏或唯一标识，内部使用 SHA-256 至少 128 bit，并将 key/输入版本写入 `hashVersion` 以便未来算法迁移。