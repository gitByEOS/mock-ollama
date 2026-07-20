import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { serve } from "@hono/node-server";
import { createCursorApp, type CursorModel } from "../src/cursor";
import { parseQuickTunnelUrl } from "../src/cursor_tunnel";

async function listen(app: { fetch: (request: Request) => Promise<Response> | Response }) {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port");
    return {
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: async () => {
            server.close();
            await once(server, "close");
        },
    };
}

async function startUpstream() {
    let received: Record<string, unknown> | null = null;
    const server = http.createServer(async (req, res) => {
        if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
            res.writeHead(404).end();
            return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        if (received.stream === true) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`data: {"model":"${received.model}","choices":[{"delta":{"content":"hi"}}]}\n\n`);
            res.end("data: [DONE]\n\n");
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "chat.completion", model: received.model, choices: [{ message: { role: "assistant", content: "ok" } }] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Upstream did not bind a TCP port");
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        received: () => received,
        close: async () => {
            server.close();
            await once(server, "close");
        },
    };
}

const key = "cursor-test-key";
const auth = { authorization: `Bearer ${key}` };
const models: CursorModel[] = [{ id: "gpt-5.5" }, { id: "gpt-5.6-terra" }, { id: "claude-sonnet" }];

test("Cursor proxy only exposes health and authenticated BYOK routes", async () => {
    const upstream = await startUpstream();
    const cursor = await listen(createCursorApp({ apiKey: key, upstreamBaseUrl: upstream.baseUrl, models }));
    try {
        const health = await fetch(`${cursor.baseUrl}/healthz`);
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), { ok: true });

        const unauthorized = await fetch(`${cursor.baseUrl}/v1/models`);
        assert.equal(unauthorized.status, 401);

        const modelsResp = await fetch(`${cursor.baseUrl}/v1/models`, { headers: auth });
        assert.equal(modelsResp.status, 200);
        assert.deepEqual(await modelsResp.json(), {
            object: "list",
            data: [
                { id: "gpt-5.5", object: "model", created: 0, owned_by: "mock-ollama" },
                { id: "gpt-5.6-terra", object: "model", created: 0, owned_by: "mock-ollama" },
                { id: "claude-sonnet", object: "model", created: 0, owned_by: "mock-ollama" },
            ],
        });

        const admin = await fetch(`${cursor.baseUrl}/api/logs`, { headers: auth });
        assert.equal(admin.status, 404);
        const messages = await fetch(`${cursor.baseUrl}/v1/messages`, { method: "POST", headers: auth });
        assert.equal(messages.status, 404);
    } finally {
        await cursor.close();
        await upstream.close();
    }
});

test("Cursor proxy passes through model name and preserves SSE", async () => {
    const upstream = await startUpstream();
    const cursor = await listen(createCursorApp({ apiKey: key, upstreamBaseUrl: upstream.baseUrl, models }));
    try {
        // 未配置的模型名被拒绝
        const rejected = await fetch(`${cursor.baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
        });
        assert.equal(rejected.status, 400);

        // 配置的模型名原样转发到上游
        const completion = await fetch(`${cursor.baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-5.6-terra", messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(completion.status, 200);
        assert.equal(upstream.received()?.model, "gpt-5.6-terra");
        const completionBody = await completion.json() as { model: string; choices: Array<{ message: { content: string } }> };
        assert.equal(completionBody.model, "gpt-5.6-terra");
        assert.equal(completionBody.choices[0].message.content, "ok");

        // SSE 流原样透传，不改写 model
        const stream = await fetch(`${cursor.baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-5.5", stream: true, messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(stream.headers.get("content-type"), "text/event-stream");
        const streamBody = await stream.text();
        assert.match(streamBody, /"model":"gpt-5.5"/);
        assert.match(streamBody, /data: \[DONE\]/);
    } finally {
        await cursor.close();
        await upstream.close();
    }
});

test("quick tunnel URL parser accepts Cloudflare logs", () => {
    assert.equal(
        parseQuickTunnelUrl("INF |  https://purple-star.trycloudflare.com  |"),
        "https://purple-star.trycloudflare.com",
    );
    assert.equal(parseQuickTunnelUrl("no URL yet"), null);
});

test("oversized JSON body is rejected before reaching upstream", async () => {
    let upstreamHit = false;
    const upstream = http.createServer((req, res) => {
        upstreamHit = true;
        res.writeHead(200).end("{}");
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const cursor = await listen(createCursorApp({
        apiKey: key,
        upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
        models,
    }));
    try {
        const huge = "x".repeat(17 * 1024 * 1024);
        const rejected = await fetch(`${cursor.baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: huge }] }),
        });
        assert.equal(rejected.status, 400);
        assert.equal(upstreamHit, false);
    } finally {
        await cursor.close();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
});
