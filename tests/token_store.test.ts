import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractTokenUsage, TokenUsageStore } from "../src/token_store";
import { responseBodyForLog } from "../src/utils";

test("提取三种上游格式的 token usage，Anthropic 输入含 cache", () => {
    assert.deepEqual(extractTokenUsage({
        usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 8, cache_creation_input_tokens: 3 },
    }), { inputTokens: 31, outputTokens: 5, cacheReadTokens: 8, cacheCreationTokens: 3 });
    assert.deepEqual(extractTokenUsage({
        usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 8 } },
    }), { inputTokens: 20, outputTokens: 5, cacheReadTokens: 8, cacheCreationTokens: 0 });
    assert.deepEqual(extractTokenUsage({
        usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 8 } },
    }), { inputTokens: 20, outputTokens: 5, cacheReadTokens: 8, cacheCreationTokens: 0 });
    assert.equal(extractTokenUsage({ usage: {} }), undefined);
});

test("原始记录写入时同步 upsert 日聚合，命中率按 token 加权", () => {
    const dir = mkdtempSync(join(tmpdir(), "mock-ollama-token-store-"));
    const store = new TokenUsageStore(join(dir, "usage.db"));
    const now = new Date().toISOString();
    try {
        store.record({
            occurredAt: now,
            model: "claude-test",
            upstream: "anthropic",
            userAgent: "client-a",
            inputTokens: 610,
            outputTokens: 20,
            cacheReadTokens: 500,
            cacheCreationTokens: 10,
            durationMs: 1_000,
            status: 200,
        });
        store.record({
            occurredAt: now,
            model: "gpt-test",
            upstream: "openai",
            userAgent: "client-b",
            inputTokens: 30,
            outputTokens: 10,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            durationMs: 1_000,
            status: 200,
        });

        const dashboard = store.getDashboard(7);
        assert.deepEqual(dashboard.overview, {
            totalTokens: 670,
            requestCount: 2,
            activeClients: 2,
            cacheHitRate: 500 / 640,
            tokensPerSecond: 15,
        });
        assert.equal(dashboard.trends.daily.length, 7);
        assert.equal(dashboard.trends.daily.filter((row) => row.totalTokens > 0).length, 1);
        assert.equal(dashboard.trends.daily.find((row) => row.totalTokens > 0)?.requestCount, 2);
        assert.deepEqual(dashboard.models.map((row: any) => row.model), ["claude-test", "gpt-test"]);
        const requests = store.getRequests(7, 1, 1);
        assert.equal(requests.total, 2);
        assert.equal(requests.items.length, 1);
        assert.equal((requests.items[0] as any).model, "claude-test");
    } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("趋势返回连续 bucket 与四层守恒数据", () => {
    const dir = mkdtempSync(join(tmpdir(), "mock-ollama-token-trends-"));
    const path = join(dir, "usage.db");
    const store = new TokenUsageStore(path);
    try {
        const now = new Date();
        const previous = new Date(now);
        previous.setDate(previous.getDate() - 2);
        store.record({
            occurredAt: previous.toISOString(), model: "claude", upstream: "anthropic", userAgent: "a",
            inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheCreationTokens: 10,
            durationMs: 1_000, status: 200,
        });
        const dashboard = store.getDashboard(3);
        assert.equal(dashboard.trends.daily.length, 3);
        assert.equal(dashboard.trends.hourly.length, 24);
        const populated = dashboard.trends.daily.find((row) => row.totalTokens === 120)!;
        assert.deepEqual(populated, {
            bucket: populated.bucket,
            totalTokens: 120,
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 50,
            cacheCreationTokens: 10,
            requestCount: 1,
        });
        assert.equal(dashboard.trends.daily.filter((row) => row.totalTokens === 0).length, 2);
        assert.equal(dashboard.range.days, 3);
        assert.ok(dashboard.range.timezone.length > 0);
    } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("三种流式协议保留完整 usage", () => {
    const anthropic = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 20, cache_read_input_tokens: 8, cache_creation_input_tokens: 3 } } })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 5 } })}\n\n`,
    ].join("");
    const responses = `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 8 } } },
    })}\n\n`;
    const chat = `data: ${JSON.stringify({ usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 8 } } })}\n\ndata: [DONE]\n\n`;

    assert.deepEqual(extractTokenUsage(responseBodyForLog(anthropic, "text/event-stream")), {
        inputTokens: 31, outputTokens: 5, cacheReadTokens: 8, cacheCreationTokens: 3,
    });
    assert.deepEqual(extractTokenUsage(responseBodyForLog(responses, "text/event-stream")), {
        inputTokens: 20, outputTokens: 5, cacheReadTokens: 8, cacheCreationTokens: 0,
    });
    assert.deepEqual(extractTokenUsage(responseBodyForLog(chat, "text/event-stream")), {
        inputTokens: 20, outputTokens: 5, cacheReadTokens: 8, cacheCreationTokens: 0,
    });
});

test("数据库使用显式 schema 版本且不会按 token 大小改写数据", () => {
    const dir = mkdtempSync(join(tmpdir(), "mock-ollama-token-schema-"));
    const path = join(dir, "usage.db");
    const store = new TokenUsageStore(path);
    store.record({
        occurredAt: new Date().toISOString(), model: "claude", upstream: "anthropic", userAgent: "a",
        inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheCreationTokens: 10,
        durationMs: 1_000, status: 200,
    });
    store.close();
    const db = new Database(path);
    try {
        assert.equal(db.pragma("user_version", { simple: true }), 1);
    } finally {
        db.close();
    }
    const reopened = new TokenUsageStore(path);
    try {
        const item = reopened.getRequests(1, 1, 0).items[0] as Record<string, number>;
        assert.equal(item.inputTokens, 100);
        assert.equal(item.totalTokens, 120);
    } finally {
        reopened.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
