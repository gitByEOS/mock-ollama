import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";

const page = readFileSync(join(__dirname, "../src/page.html"), "utf8");
const inlineScript = page.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];

test("页面内联脚本语法有效", () => {
    assert.ok(inlineScript, "page.html should contain an inline script");
    assert.doesNotThrow(() => new Script(inlineScript));
});

test("实时日志按动画帧批处理、隐藏页暂停并统一裁剪", () => {
    assert.match(page, /const pendingRealtimeLogs = new Map\(\)/);
    assert.match(page, /pendingRealtimeLogs\.set\(newLog\.id, newLog\)/);
    assert.match(page, /realtimeLogFrame = requestAnimationFrame\(flushRealtimeLogs\)/);
    assert.match(page, /if \(document\.hidden \|\| pendingRealtimeLogs\.size === 0\) return/);
    assert.match(page, /document\.addEventListener\('visibilitychange'/);
    assert.match(page, /logs\.slice\(-MAX_VISIBLE_LOGS\)/);
    assert.match(page, /window\.scrollTo\(\{ top: 0, behavior: 'smooth' \}\)/);
});

test("主页卡片恢复原有视觉结构且保持 O(1) 轻量渲染", () => {
    const distributionStart = page.indexOf("function renderLogDistribution");
    const cardStart = page.indexOf("function renderSingleLogCard", distributionStart);
    const cardEnd = page.indexOf("function renderLogs", cardStart);
    const distributionRenderer = page.slice(distributionStart, cardStart);
    const cardRenderer = page.slice(cardStart, cardEnd);
    for (const className of ["log-card", "log-header", "log-time", "log-method", "log-path", "log-session", "log-status", "log-expand-btn"]) {
        assert.match(cardRenderer, new RegExp(className), `missing legacy ${className} structure`);
    }
    assert.match(cardRenderer, /renderLogDistribution\(log\)/);
    assert.match(distributionRenderer, /class="dist-bar-wrap"/);
    assert.match(distributionRenderer, /renderAuthoritativeUsage\(log, usage\)/);
    assert.match(page, /function renderLogInteraction\(log\)/);
    assert.match(page, /function requestInteractionSummary\(log\)/);
    assert.match(page, /User 输入/);
    assert.match(page, /Assistant 上下文/);
    assert.match(page, /工具结果/);
    assert.doesNotMatch(page.slice(page.indexOf('function requestInteractionSummary'), page.indexOf('function responseOutput')), /MAX_LOG_CONTEXT_MESSAGES|Assistant 工具调用|本轮工具调用/);
    assert.match(page, /LOG_INTERACTION_PREVIEW_MAX = 2000/);
    assert.doesNotMatch(distributionRenderer + cardRenderer, /buildDistBar|GPTTokenizer|requestIdleCallback|querySelector|\.find\(|\.filter\(|\.map\(/);
    assert.doesNotMatch(page, /renderDistBarsProgressively|dist-bar-placeholder|log-usage-summary/);
    assert.match(page, /const MAX_REALTIME_LOGS_PER_FRAME = 10/);
    assert.match(page, /if \(batch\.length >= MAX_REALTIME_LOGS_PER_FRAME\) break/);
    assert.match(page, /function detailTaskIsCurrent\(generation, logId\)/);
    assert.match(page, /detailTaskIsCurrent\(generation, log\.id\)/);
    assert.match(page, /const authoritativeUsage = normalizedLogUsage\(log\)/);
    assert.match(page, /const sseFrameCount = Number\(log\.response\?\.frameCount \|\| 0\)/);
    assert.match(page, /const messageLength = String\(log\.response\?\.assistantText \|\| ''\)\.length/);
    assert.match(page, /const toolNames = Array\.isArray\(log\.response\?\.toolCalls\)/);
    assert.match(page, /工具调用 <span class="dist-cat-value tool">\$\{escapeHtml\(toolNames\)\}<\/span>/);
    assert.match(page, /\.log-interaction-content::-webkit-scrollbar \{ width: 4px; height: 4px; \}/);
});

test("详情页分阶段加载历史消息且完整展示内部内容", () => {
    assert.match(page, /function renderDetailAsync\(log, generation\)/);
    assert.match(page, /function yieldDetailRender\(\)/);
    assert.match(page, /requestAnimationFrame\(\(\) => requestAnimationFrame\(resolve\)\)/);
    assert.match(page, /const DETAIL_MESSAGE_BATCH_SIZE = 12/);
    assert.match(page, /renderNextDetailMessageBatch\(log, generation\)/);
    assert.match(page, /继续加载/);
    assert.match(page, /function renderRequestContent\(content\)/);
    assert.match(page, /return content\.map\(\(block, index\) => \{/);
    assert.doesNotMatch(page, /详情内容已截断|DETAIL_MESSAGE_CONTENT_MAX|DETAIL_CONTENT_BLOCKS/);
    assert.match(page, /MAX_DETAIL_TOKENIZED_MESSAGES = 24/);
    assert.match(page, /MAX_DETAIL_TOKENIZED_CHARS = 16000/);
    assert.match(page, /const DETAIL_TOOL_STATS_MESSAGES = 100/);
});

test("Diff 有复杂度硬上限和快速降级", () => {
    assert.match(page, /const MAX_LCS_TOKENS_PER_SIDE = 2000/);
    assert.match(page, /const MAX_LCS_MATRIX_CELLS = 2000000/);
    assert.match(page, /return quickTokenDiff\(tokensA, tokensB\)/);
    assert.match(page, /内容过大，已使用快速对比/);
});

test("Diff 高频滚动只在动画帧统一写布局", () => {
    assert.match(page, /scrollFrame = requestAnimationFrame\(flushDiffScroll\)/);
    assert.match(page, /pendingRatio = Math\.max\(0, Math\.min\(1, ratio\)\)/);
    assert.match(page, /minimapRect = minimap\.getBoundingClientRect\(\)/);
    assert.match(page, /minimapRect \?\?= minimap\.getBoundingClientRect\(\)/);
});

test("详情 Token 使用量使用紧凑单位", () => {
    assert.match(page, /function formatDetailedTokenMetric\(value\)/);
    assert.match(page, /输入: \$\{formatDetailedTokenMetric\(u\.input_tokens\)\}/);
    assert.match(page, /缓存: \$\{formatDetailedTokenMetric\(u\.cache_read_input_tokens\)\}/);
});

test("Token 统计范围支持 1d、7d、30d 且切换重新加载", () => {
    assert.match(page, /id="tokenPeriod1d"[^>]*onclick="setTokenDashboardPeriod\(1\)"/);
    assert.match(page, /id="tokenPeriod7d"[^>]*onclick="setTokenDashboardPeriod\(7\)"/);
    assert.match(page, /id="tokenPeriod30d"[^>]*onclick="setTokenDashboardPeriod\(30\)"/);
    assert.match(page, /fetch\(`\/api\/token-usage\?days=\$\{period\}`\)/);
    assert.match(page, /tokenTrendGranularity = period === 1 \? 'hourly' : 'daily'/);
    assert.match(page, /function setTokenDashboardPeriod\(days\)/);
    assert.match(page, /void loadTokenDashboard\(\)/);
    assert.match(page, /过去 24 小时/);
    assert.doesNotMatch(page, /tokenHourlyButton|tokenDailyButton/);
});

test("Token 统计控件采用居中白色强调态，分页支持九个页码跳转", () => {
    assert.match(page, /class="panel-close token-dashboard-close"/);
    assert.match(page, /\.token-dashboard-close \{ display:grid; flex:0 0 auto; align-self:flex-start; padding:0; place-items:center; \}/);
    assert.match(page, /\.token-dashboard-close svg \{ width:16px; height:16px; stroke:#888; stroke-linecap:round; stroke-width:2; \}/);
    assert.match(page, /<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3 13 13M13 3 3 13"\/><\/svg>/);
    assert.match(page, /\.token-switch button \{[^}]*border:1px solid #333[^}]*border-radius:8px[^}]*\}/);
    assert.match(page, /\.token-switch button\.active \{ color:#f3f4f6; border-color:#777; background:#222; box-shadow:inset 0 -1px 0 #bbb; \}/);
    assert.match(page, /\.token-page-button\.active::after \{[^}]*width:10px; height:2px;[^}]*background:#fff;[^}]*\}/);
    assert.match(page, /function tokenRequestPageNumbers\(currentPage, totalPages, maxVisible = 9\)/);
    assert.match(page, /Array\.from\(\{ length: visible \}, \(_, index\) => start \+ index\)/);
    assert.match(page, /class="token-page-button\$\{page === currentPage \? ' active' : ''\}"/);
    assert.match(page, /aria-current="page"/);
    assert.match(page, /function changeTokenRequestPage\(page\)/);
    assert.match(page, /tokenRequestOffset = \(page - 1\) \* tokenRequestData\.limit/);
});
