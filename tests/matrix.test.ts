import assert from "node:assert/strict";
import test from "node:test";
import { createParser } from "eventsource-parser";
import {
    chatRequestToAnthropic,
} from "../src/bridge/anthropic_chat";
import {
    chatRequestToResponses,
    chatResponseToResponses,
    responsesRequestToChat,
    responsesResponseToChat,
} from "../src/bridge/chat_responses";
import { convertChatSseToResponses, convertResponsesSseToChat } from "../src/bridge/chat_responses_sse";
import type { ApiFormat } from "../src/bridge/matrix";
import {
    createApp,
    createProviderContext,
    detectUpstreamFormat,
    dispatchMatrix,
    matrixAction,
    parseApiStyle,
    processApiPath,
} from "../src/index";
import type { JsonObject } from "../src/bridge/types";

function parseSse(raw: string): JsonObject[] {
    const events: JsonObject[] = [];
    const parser = createParser({
        onEvent: (event) => {
            if (event.data !== "[DONE]") events.push(JSON.parse(event.data) as JsonObject);
        },
    });
    parser.feed(raw.endsWith("\n\n") ? raw : `${raw}\n\n`);
    return events;
}

test("C→A 请求转换保留 system、工具调用和工具结果", () => {
    const result = chatRequestToAnthropic({
        model: "claude-x",
        max_completion_tokens: 50,
        messages: [
            { role: "system", content: "简洁回答" },
            { role: "user", content: "天气" },
            { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "weather", arguments: "{\"city\":\"Paris\"}" } }] },
            { role: "tool", tool_call_id: "call_1", content: "sunny" },
        ],
        tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }],
    });
    assert.equal(result.system, "简洁回答");
    assert.equal(result.max_tokens, 50);
    const messages = result.messages as JsonObject[];
    assert.equal((messages[1].content as JsonObject[])[0].type, "tool_use");
    assert.deepEqual((messages[1].content as JsonObject[])[0].input, { city: "Paris" });
    assert.equal((messages[2].content as JsonObject[])[0].type, "tool_result");
});

test("R↔C 请求直接转换保留工具 schema、choice 和 token 参数", () => {
    const responses = chatRequestToResponses({
        model: "gpt-x",
        max_completion_tokens: 99,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ type: "function", function: { name: "lookup", description: "查找", parameters: { type: "object" } } }],
        tool_choice: { type: "function", function: { name: "lookup" } },
    });
    assert.equal(responses.max_output_tokens, 99);
    assert.equal(((responses.tools as JsonObject[])[0]).name, "lookup");
    assert.deepEqual(responses.tool_choice, { type: "function", name: "lookup" });

    const chat = responsesRequestToChat(responses);
    assert.equal(chat.max_completion_tokens, 99);
    assert.equal((((chat.tools as JsonObject[])[0]).function as JsonObject).name, "lookup");
    assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "lookup" } });
});

test("R↔C 普通响应保留文本、工具、finish 与 usage", () => {
    const responses = chatResponseToResponses({
        id: "chatcmpl-1",
        created: 123,
        model: "gpt-x",
        choices: [{
            message: { role: "assistant", content: "ok", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":1}" } }] },
            finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    assert.equal(responses.id, "resp_1");
    assert.deepEqual((responses.output as JsonObject[]).map((item) => item.type), ["message", "function_call"]);
    const chat = responsesResponseToChat(responses);
    const choice = (chat.choices as JsonObject[])[0];
    assert.equal(choice.finish_reason, "tool_calls");
    assert.equal(objectMessage(choice).content, "ok");
    assert.equal(((chat.usage as JsonObject).total_tokens), 5);
});

function objectMessage(choice: JsonObject): JsonObject {
    return choice.message as JsonObject;
}

test("R↔C SSE 双向生成协议终止事件并保留增量", () => {
    const chatRaw = [
        `data: ${JSON.stringify({ id: "chatcmpl-s", model: "gpt-x", choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "chatcmpl-s", model: "gpt-x", choices: [{ delta: { content: "Hel" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "chatcmpl-s", model: "gpt-x", choices: [{ delta: { content: "lo" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
        "data: [DONE]\n\n",
    ].join("");
    const responseEvents = parseSse(convertChatSseToResponses(chatRaw, { model: "gpt-x" }));
    assert.ok(responseEvents.some((event) => event.type === "response.output_text.delta" && event.delta === "Hel"));
    assert.equal(responseEvents.at(-1)?.type, "response.completed");
    const roundTrip = convertResponsesSseToChat(responseEvents.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    const chatEvents = parseSse(roundTrip);
    assert.ok(chatEvents.some((event) => ((event.choices as JsonObject[])[0].delta as JsonObject).content === "Hel"));
    assert.equal(((chatEvents.at(-1)?.choices as JsonObject[])[0]).finish_reason, "stop");
    assert.ok(roundTrip.endsWith("data: [DONE]\n\n"));
});

test("apiStyle 三档、auto 探测并拒绝已废弃旧值", () => {
    assert.equal(parseApiStyle("anthropic"), "anthropic");
    assert.equal(parseApiStyle("responses"), "responses");
    assert.equal(parseApiStyle("chat"), "chat");
    assert.throws(() => parseApiStyle("openai"), /Unsupported apiStyle/);
    assert.throws(() => parseApiStyle("bridge"), /Unsupported apiStyle/);
    assert.equal(detectUpstreamFormat("https://api.anthropic.com"), "anthropic");
    assert.equal(detectUpstreamFormat("https://gateway.test/responses-api"), "responses");
    assert.equal(detectUpstreamFormat("https://api.deepseek.com"), "chat");
    assert.equal(processApiPath("https://x.test", "responses").chat, "/v1/responses");
});

test("3×3 分发矩阵恰含 3 格透传和 6 格转换", () => {
    const formats: ApiFormat[] = ["anthropic", "responses", "chat"];
    const actions = formats.flatMap((inbound) => formats.map((upstream) => matrixAction(inbound, upstream)));
    assert.equal(actions.filter((action) => action === "passthrough").length, 3);
    assert.deepEqual(actions, [
        "passthrough", "anthropic-responses", "anthropic-chat",
        "responses-anthropic", "passthrough", "responses-chat",
        "chat-anthropic", "chat-responses", "passthrough",
    ]);
    for (const inbound of formats) {
        for (const upstream of formats) assert.equal(typeof dispatchMatrix[inbound][upstream], "function");
    }
});

const endpoint: Record<ApiFormat, string> = {
    anthropic: "/v1/messages",
    responses: "/v1/responses",
    chat: "/v1/chat/completions",
};

const requestBody: Record<ApiFormat, JsonObject> = {
    anthropic: { model: "model-x", max_tokens: 20, messages: [{ role: "user", content: "hi" }] },
    responses: { model: "model-x", max_output_tokens: 20, input: "hi" },
    chat: { model: "model-x", max_completion_tokens: 20, messages: [{ role: "user", content: "hi" }] },
};

const responseBody: Record<ApiFormat, JsonObject> = {
    anthropic: { id: "msg_matrix", type: "message", role: "assistant", model: "model-x", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
    responses: { id: "resp_matrix", object: "response", status: "completed", model: "model-x", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    chat: { id: "chatcmpl-matrix", object: "chat.completion", model: "model-x", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
};

test("--bridge=false 三端点均按原路径和原 body 透传", async () => {
    const originalFetch = globalThis.fetch;
    try {
        for (const format of ["anthropic", "responses", "chat"] as ApiFormat[]) {
            let capturedUrl = "";
            let capturedBody: JsonObject = {};
            globalThis.fetch = async (input, init) => {
                capturedUrl = String(input);
                capturedBody = JSON.parse(String(init?.body)) as JsonObject;
                return new Response(JSON.stringify(responseBody[format]), { headers: { "content-type": "application/json" } });
            };
            const app = createApp(createProviderContext({
                baseUrl: "https://upstream.test", apikey: "key", apiStyle: "anthropic", bridge: false,
            }));
            const response = await app.request(endpoint[format], {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody[format]),
            });
            assert.equal(response.status, 200);
            assert.equal(capturedUrl, `https://upstream.test${endpoint[format]}`);
            assert.deepEqual(capturedBody, requestBody[format]);
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("--bridge=false 的 Responses 配置仍保持透明代理", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: JsonObject = {};
    let capturedHeaders = new Headers();
    globalThis.fetch = async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as JsonObject;
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify(responseBody.responses), { headers: { "content-type": "application/json" } });
    };
    try {
        const app = createApp(createProviderContext({
            baseUrl: "https://upstream.test", apikey: "key", apiStyle: "responses", bridge: false,
        }));
        const request = { ...requestBody.responses, stream: false, store: true, prompt_cache_key: "cache" };
        const response = await app.request("/v1/responses", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(capturedBody, request);
        assert.equal(capturedHeaders.get("originator"), null);
        assert.equal(capturedHeaders.get("session-id"), null);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("--bridge=true 九格均命中所选上游端点", async () => {
    const originalFetch = globalThis.fetch;
    try {
        for (const inbound of ["anthropic", "responses", "chat"] as ApiFormat[]) {
            for (const upstream of ["anthropic", "responses", "chat"] as ApiFormat[]) {
                let capturedUrl = "";
                let capturedBody: JsonObject = {};
                let fetchCount = 0;
                globalThis.fetch = async (input, init) => {
                    fetchCount++;
                    capturedUrl = String(input);
                    capturedBody = JSON.parse(String(init?.body)) as JsonObject;
                    const response = responseBody[upstream];
                    if (upstream === "responses") {
                        const raw = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`;
                        return new Response(raw, { headers: { "content-type": "text/event-stream" } });
                    }
                    return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
                };
                const app = createApp(createProviderContext({
                    baseUrl: "https://upstream.test", apikey: "key", apiStyle: upstream, bridge: true,
                }));
                const response = await app.request(endpoint[inbound], {
                    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody[inbound]),
                });
                assert.equal(response.status, 200, `${inbound}→${upstream}`);
                assert.equal(capturedUrl, `https://upstream.test${endpoint[upstream]}`, `${inbound}→${upstream}`);
                assert.equal(fetchCount, 1, `${inbound}→${upstream} 不应借道第三种协议`);
                assert.equal(
                    upstream === "responses" ? "input" in capturedBody : Array.isArray(capturedBody.messages),
                    true,
                    `${inbound}→${upstream} 请求体应为上游协议`,
                );
                if (upstream === "responses") {
                    assert.equal(capturedBody.stream, true, `${inbound}→R 应自动强制上游流式`);
                    assert.equal(capturedBody.max_output_tokens, undefined, `${inbound}→R 应删除 max_output_tokens`);
                    assert.equal(capturedBody.store, false, `${inbound}→R 应设置 store:false`);
                }
                const clientBody = await response.json() as JsonObject;
                assert.equal(
                    inbound === "anthropic"
                        ? clientBody.type === "message"
                        : clientBody.object === (inbound === "responses" ? "response" : "chat.completion"),
                    true,
                    `${inbound}→${upstream} 响应体应还原为入站协议`,
                );
            }
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("Chat→Responses 非流请求可聚合上游 SSE", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        const response = responseBody.responses;
        const raw = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`;
        return new Response(raw, { headers: { "content-type": "text/plain" } });
    };
    try {
        const app = createApp(createProviderContext({
            baseUrl: "https://upstream.test", apikey: "key", apiStyle: "responses", bridge: true,
        }));
        const response = await app.request("/v1/chat/completions", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody.chat),
        });
        assert.match(response.headers.get("content-type") ?? "", /application\/json/);
        const body = await response.json() as JsonObject;
        assert.equal(body.object, "chat.completion");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("A/R/C 打到 Responses 时使用统一关联标识", async () => {
    const originalFetch = globalThis.fetch;
    const captures: Array<{ body: JsonObject; headers: Headers }> = [];
    globalThis.fetch = async (_input, init) => {
        captures.push({
            body: JSON.parse(String(init?.body)) as JsonObject,
            headers: new Headers(init?.headers),
        });
        return new Response(JSON.stringify(responseBody.responses), { headers: { "content-type": "application/json" } });
    };
    try {
        const app = createApp(createProviderContext({
            baseUrl: "https://upstream.test", apikey: "key", apiStyle: "responses", bridge: true,
        }));
        await app.request("/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json", "x-claude-code-session-id": "claude-session" },
            body: JSON.stringify(requestBody.anthropic),
        });
        await app.request("/v1/responses", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...requestBody.responses, prompt_cache_key: "responses-cache-key" }),
        });
        await app.request("/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...requestBody.chat, prompt_cache_key: "chat-cache-key" }),
        });

        const [anthropic, responses, chat] = captures;
        const assertLinkedIdentifiers = (capture: { body: JsonObject; headers: Headers }) => {
            const sessionId = capture.headers.get("session-id") ?? "";
            assert.equal(capture.headers.get("thread-id"), sessionId);
            assert.equal(capture.headers.get("x-client-request-id"), sessionId);
            assert.equal(capture.body.prompt_cache_key, sessionId);
            return sessionId;
        };
        const anthropicSessionId = assertLinkedIdentifiers(anthropic);
        const responsesSessionId = assertLinkedIdentifiers(responses);
        const chatSessionId = assertLinkedIdentifiers(chat);
        assert.match(anthropicSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.notEqual(anthropicSessionId, "claude-session");
        assert.equal(responsesSessionId, "responses-cache-key");
        assert.equal(chatSessionId, anthropicSessionId);

        const otherApp = createApp(createProviderContext({
            baseUrl: "https://other-upstream.test", apikey: "key", apiStyle: "responses", bridge: true,
        }));
        await otherApp.request("/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(requestBody.anthropic),
        });
        assert.notEqual(assertLinkedIdentifiers(captures[3]), anthropicSessionId);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
