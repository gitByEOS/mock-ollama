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
    assert.match(page, /User 最后输入/);
    assert.match(page, /LOG_INTERACTION_PREVIEW_MAX = 2000/);
    assert.doesNotMatch(distributionRenderer + cardRenderer, /buildDistBar|GPTTokenizer|requestIdleCallback|querySelector|\.find\(|\.filter\(|\.map\(/);
    assert.doesNotMatch(page, /renderDistBarsProgressively|dist-bar-placeholder|log-usage-summary/);
    assert.match(page, /const MAX_REALTIME_LOGS_PER_FRAME = 10/);
    assert.match(page, /if \(batch\.length >= MAX_REALTIME_LOGS_PER_FRAME\) break/);
    assert.match(page, /requestAnimationFrame\(\(\) => \{\s*if \(generation !== detailRenderGeneration/);
    assert.match(page, /const authoritativeUsage = normalizedLogUsage\(log\)/);
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

test("Token 统计弹层关闭按钮顶部对齐，分页支持九个页码跳转", () => {
    assert.match(page, /class="panel-close token-dashboard-close"/);
    assert.match(page, /\.token-dashboard-close \{ flex:0 0 auto; align-self:flex-start; \}/);
    assert.match(page, /function tokenRequestPageNumbers\(currentPage, totalPages, maxVisible = 9\)/);
    assert.match(page, /Array\.from\(\{ length: visible \}, \(_, index\) => start \+ index\)/);
    assert.match(page, /class="token-page-button\$\{page === currentPage \? ' active' : ''\}"/);
    assert.match(page, /aria-current="page"/);
    assert.match(page, /function changeTokenRequestPage\(page\)/);
    assert.match(page, /tokenRequestOffset = \(page - 1\) \* tokenRequestData\.limit/);
});
