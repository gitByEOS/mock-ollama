import assert from "node:assert/strict";
import test from "node:test";
import { createParser } from "eventsource-parser";
import {
    ProtocolConversionError,
    anthropicErrorToOpenAi,
    openAiErrorToAnthropic,
} from "../src/bridge/errors";
import {
    anthropicRequestToResponses,
    anthropicResponseToResponses,
    responsesRequestToAnthropic,
    responsesResponseToAnthropic,
} from "../src/bridge/anthropic_responses";
import {
    convertAnthropicSseToResponses,
    convertResponsesSseToAnthropic,
    materializeAnthropicSse,
    materializeResponsesSse,
} from "../src/bridge/responses_sse";
import {
    convertChatSseToResponses,
    convertResponsesSseToChat,
    materializeChatSse,
} from "../src/bridge/chat_responses_sse";
import { conversionPairs, runConversion } from "../src/bridge/matrix";
import type { JsonObject } from "../src/bridge/types";
import { upstreamClient } from "../src/upstream";

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

function sse(type: string, body: JsonObject): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
}

test("Anthropic 请求映射完整保留字段、工具和多模态顺序", () => {
    const converted = anthropicRequestToResponses({
        model: "claude-x",
        stream: true,
        max_tokens: 321,
        system: [{ type: "text", text: "规则一" }, { type: "text", text: "规则二" }],
        thinking: { type: "enabled", budget_tokens: 4096 },
        temperature: 0.2,
        top_p: 0.9,
        metadata: { user_id: "user-1", trace: "t1", ignored: 1 },
        tools: [{ name: "weather", description: "天气", input_schema: { type: "object" } }],
        tool_choice: { type: "any", disable_parallel_tool_use: true },
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "巴黎天气" },
                    { type: "image", source: { type: "url", url: "https://example.test/a.png" } },
                ],
            },
            {
                role: "assistant",
                content: [{ type: "tool_use", id: "call_1", name: "weather", input: { city: "Paris" } }],
            },
            {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny" }],
            },
        ],
    });

    assert.equal(converted.instructions, "规则一\n规则二");
    assert.equal(converted.max_output_tokens, undefined);
    assert.deepEqual(converted.reasoning, { effort: "medium" });
    assert.deepEqual(converted.tool_choice, "required");
    assert.equal(converted.parallel_tool_calls, false);
    assert.equal(converted.metadata, undefined);
    assert.equal(converted.user, undefined);
    const tools = converted.tools as JsonObject[];
    assert.deepEqual((tools[0].parameters as JsonObject).properties, {});
    const input = converted.input as JsonObject[];
    assert.deepEqual((input[0].content as JsonObject[]).map((part) => part.type), ["input_text", "input_image"]);
    assert.equal(input[1].type, "function_call");
    assert.equal(input[1].arguments, "{\"city\":\"Paris\"}");
    assert.equal(input[2].type, "function_call_output");
    assert.equal(input[2].output, "sunny");
});

test("reasoning 模型未指定 thinking 时补默认 effort", () => {
    const converted = anthropicRequestToResponses({ model: "gpt-5.6-terra", stream: true });
    assert.deepEqual(converted.reasoning, { effort: "medium" });
});

test("thinking 配置优先于 reasoning 模型默认 effort", () => {
    const converted = anthropicRequestToResponses({
        model: "gpt-5.6-terra",
        thinking: { type: "enabled", budget_tokens: 2048 },
    });
    assert.deepEqual(converted.reasoning, { effort: "low" });
});

test("非 reasoning 模型未指定 thinking 时不补 effort", () => {
    const converted = anthropicRequestToResponses({ model: "gpt-4o" });
    assert.equal("reasoning" in converted, false);
});

test("Responses 请求反向映射 instructions、工具、思考和工具结果", () => {
    const converted = responsesRequestToAnthropic({
        model: "gpt-x",
        stream: true,
        instructions: "简洁回答",
        max_output_tokens: 456,
        reasoning: { effort: "high" },
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
        tool_choice: { type: "function", name: "lookup" },
        parallel_tool_calls: false,
        input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "查找" }] },
            { type: "reasoning", encrypted_content: "claude#EAAA", summary: [{ type: "summary_text", text: "想一想" }] },
            { type: "function_call", id: "fc_call_2", call_id: "call_2", name: "lookup", arguments: "{\"q\":1}" },
            { type: "function_call_output", call_id: "call_2", output: "ok" },
        ],
    });

    assert.equal(converted.system, "简洁回答");
    assert.equal(converted.max_tokens, 456);
    assert.deepEqual(converted.thinking, { type: "adaptive" });
    assert.deepEqual(converted.output_config, { effort: "high" });
    assert.deepEqual(converted.tool_choice, { type: "tool", name: "lookup", disable_parallel_tool_use: true });
    const messages = converted.messages as JsonObject[];
    assert.equal((messages[1].content as JsonObject[])[0].type, "thinking");
    assert.equal((messages[1].content as JsonObject[])[1].type, "tool_use");
    assert.deepEqual(((messages[1].content as JsonObject[])[1].input), { q: 1 });
    assert.equal((messages[2].content as JsonObject[])[0].type, "tool_result");
});

test("developer role 合入 system", () => {
    const result = responsesRequestToAnthropic({
        model: "gpt-5.6-terra",
        input: [
            { type: "message", role: "developer", content: [{ type: "input_text", text: "你是助手" }] },
            { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        ],
    });
    assert.equal(result.system, "你是助手");
    const messages = result.messages as JsonObject[];
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, "user");
});

test("不兼容思考签名不泄漏，stop_sequences 明确拒绝", () => {
    const converted = anthropicRequestToResponses({
        messages: [{
            role: "assistant",
            content: [
                { type: "thinking", thinking: "秘密", signature: "EAAA" },
                { type: "text", text: "答案" },
            ],
        }],
    });
    assert.equal((converted.input as JsonObject[]).length, 1);
    assert.equal((((converted.input as JsonObject[])[0].content as JsonObject[])[0]).text, "答案");
    assert.throws(
        () => anthropicRequestToResponses({ stop_sequences: ["END"] }),
        (error) => error instanceof ProtocolConversionError && error.status === 400 && error.field === "stop_sequences",
    );
    assert.throws(
        () => responsesRequestToAnthropic({
            tools: [{ type: "web_search_preview" }],
            tool_choice: { type: "web_search_preview" },
        }),
        (error) => error instanceof ProtocolConversionError && error.field === "tool_choice",
    );
});

test("Responses 普通响应按输出顺序映射工具、缓存用量和截断状态", () => {
    const converted = responsesResponseToAnthropic({
        id: "resp_01A",
        model: "gpt-x",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
            { type: "message", content: [{ type: "output_text", text: "hello" }] },
            { type: "reasoning", encrypted_content: "claude#EAAA", summary: [{ type: "summary_text", text: "思考" }] },
            { id: "fc_1", type: "function_call", call_id: "call_1", name: "bad", arguments: "{bad" },
            { id: "fc_2", type: "function_call", call_id: "call_2", name: "good", arguments: "{\"x\":2}" },
        ],
        usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 4 }, output_tokens: 3 },
    });
    assert.equal(converted.id, "msg_01A");
    assert.deepEqual((converted.content as JsonObject[]).map((block) => block.type), ["text", "thinking", "tool_use", "tool_use"]);
    assert.deepEqual((converted.content as JsonObject[])[2].input, {});
    assert.deepEqual((converted.content as JsonObject[])[3].input, { x: 2 });
    assert.equal(converted.stop_reason, "tool_use");
    assert.deepEqual(converted.usage, { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 4 });
});

test("Anthropic 普通响应映射 Responses 文本、工具、思考和用量", () => {
    const converted = anthropicResponseToResponses({
        id: "msg_01A",
        model: "claude-x",
        stop_reason: "max_tokens",
        content: [
            { type: "text", text: "hello" },
            { type: "thinking", thinking: "summary", signature: "gpt#gAAAAAAA" },
            { type: "tool_use", id: "call_1", name: "lookup", input: { q: 1 } },
        ],
        usage: {
            input_tokens: 5,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
            output_tokens: 4,
        },
    });
    assert.equal(converted.id, "resp_01A");
    assert.equal(converted.status, "incomplete");
    assert.deepEqual(converted.incomplete_details, { reason: "max_output_tokens" });
    assert.deepEqual((converted.output as JsonObject[]).map((item) => item.type), ["message", "reasoning", "function_call"]);
    assert.deepEqual(converted.usage, {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens: 4,
        total_tokens: 14,
    });
});

const anthropicTextFixture = [
    sse("message_start", {
        message: {
            id: "msg_01A",
            type: "message",
            role: "assistant",
            model: "claude-x",
            content: [],
            usage: { input_tokens: 12, output_tokens: 0 },
        },
    }),
    sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello" } }),
    sse("content_block_stop", { index: 0 }),
    sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
    sse("message_stop", {}),
].join("");

test("Anthropic SSE 按 §3 生成完整 Responses 生命周期", () => {
    const events = parseSse(convertAnthropicSseToResponses(anthropicTextFixture, {}, () => 1700000000));
    assert.deepEqual(events.map((event) => event.type), [
        "response.created",
        "response.in_progress",
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
        "response.output_text.done",
        "response.content_part.done",
        "response.output_item.done",
        "response.completed",
    ]);
    assert.deepEqual(events.map((event) => event.sequence_number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const response = events.at(-1)?.response as JsonObject;
    assert.equal(response.id, "resp_01A");
    assert.equal(response.created_at, 1700000000);
    assert.equal((((response.output as JsonObject[])[0].content as JsonObject[])[0]).text, "Hello");
    assert.deepEqual(response.usage, {
        input_tokens: 12,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        total_tokens: 13,
    });
});

test("Responses SSE 按 §3 反向生成完整 Anthropic 生命周期", () => {
    const responsesFixture = convertAnthropicSseToResponses(anthropicTextFixture, {}, () => 1700000000);
    const events = parseSse(convertResponsesSseToAnthropic(responsesFixture, { model: "gpt-x" }));
    assert.deepEqual(events.map((event) => event.type), [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
    ]);
    assert.equal((events[0].message as JsonObject).model, "claude-x");
    assert.equal((events[2].delta as JsonObject).text, "Hello");
    assert.deepEqual(events[4].usage, { input_tokens: 12, output_tokens: 1 });
});

test("SSE 并行工具按块索引独立缓冲并闭合", () => {
    const fixture = [
        sse("message_start", { message: { id: "msg_tools", model: "claude-x", usage: {} } }),
        sse("content_block_start", { index: 0, content_block: { type: "tool_use", id: "call_a", name: "a", input: {} } }),
        sse("content_block_start", { index: 1, content_block: { type: "tool_use", id: "call_b", name: "b", input: {} } }),
        sse("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "{\"b\":" } }),
        sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{\"a\":1}" } }),
        sse("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "2}" } }),
        sse("content_block_stop", { index: 0 }),
        sse("content_block_stop", { index: 1 }),
        sse("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } }),
        sse("message_stop", {}),
    ].join("");
    const events = parseSse(convertAnthropicSseToResponses(fixture));
    const completed = events.at(-1)?.response as JsonObject;
    const output = completed.output as JsonObject[];
    assert.equal(output[0].arguments, "{\"a\":1}");
    assert.equal(output[1].arguments, "{\"b\":2}");
    assert.equal(events.filter((event) => event.type === "response.output_item.done").length, 2);
});

test("SSE 思考仅在目标签名兼容时输出", () => {
    const signed = [
        sse("message_start", { message: { id: "msg_reason", model: "claude-x", usage: {} } }),
        sse("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "gpt#gAAAAAAA" } }),
        sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "summary" } }),
        sse("content_block_stop", { index: 0 }),
        sse("message_stop", {}),
    ].join("");
    assert.ok(parseSse(convertAnthropicSseToResponses(signed)).some((event) => event.type === "response.reasoning_summary_text.delta"));
    const unsigned = signed.replace("gpt#gAAAAAAA", "EAAA");
    assert.ok(!parseSse(convertAnthropicSseToResponses(unsigned)).some((event) => event.type === "response.reasoning_summary_text.delta"));
});

test("SSE 错误双向转换后不追加成功终止", () => {
    const fromAnthropic = parseSse(convertAnthropicSseToResponses([
        sse("message_start", { message: { id: "msg_error", model: "x" } }),
        sse("error", { error: { type: "overloaded_error", message: "busy" } }),
        sse("message_stop", {}),
    ].join("")));
    assert.ok(fromAnthropic.some((event) => event.type === "response.failed"));
    assert.ok(!fromAnthropic.some((event) => event.type === "response.completed"));

    const fromResponses = parseSse(convertResponsesSseToAnthropic([
        sse("response.created", { response: { id: "resp_error", model: "x" } }),
        sse("response.failed", { error: { type: "server_error", message: "failed" } }),
        sse("response.completed", { response: { id: "resp_error" } }),
    ].join("")));
    assert.equal(fromResponses.at(-1)?.type, "error");
    assert.ok(!fromResponses.some((event) => event.type === "message_stop"));
});

test("Anthropic max_tokens SSE 映射 response.incomplete", () => {
    const fixture = anthropicTextFixture.replace("end_turn", "max_tokens");
    const events = parseSse(convertAnthropicSseToResponses(fixture));
    assert.equal(events.at(-1)?.type, "response.incomplete");
    assert.deepEqual((events.at(-1)?.response as JsonObject).incomplete_details, { reason: "max_output_tokens" });
});

test("截断 SSE 不合成成功终止或工具 done", () => {
    const anthropic = parseSse(convertAnthropicSseToResponses(anthropicTextFixture.replace(
        sse("content_block_stop", { index: 0 }) + sse("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) + sse("message_stop", {}),
        "",
    )));
    assert.equal(anthropic.at(-1)?.type, "error");
    assert.ok(anthropic.some((event) => event.type === "response.failed"));
    assert.ok(!anthropic.some((event) => event.type === "response.completed"));

    const chat = [
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 7, id: "call_a", function: { name: "a", arguments: "{" } }] }, finish_reason: null }] })}\n\n`,
    ].join("");
    const chatEvents = parseSse(convertChatSseToResponses(chat));
    assert.equal(chatEvents.at(-1)?.type, "response.failed");
    assert.ok(!chatEvents.some((event) => event.type === "response.function_call_arguments.done"));
});

test("Chat→Responses output_index 按首次出现连续稳定", () => {
    const raw = [
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 9, id: "call_a", function: { name: "a", arguments: "{" } }] }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 2, id: "call_b", function: { name: "b", arguments: "{}" } }, { index: 9, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }] })}\n\n`,
        "data: [DONE]\n\n",
    ].join("");
    const events = parseSse(convertChatSseToResponses(raw));
    const added = events.filter((event) => event.type === "response.output_item.added");
    assert.deepEqual(added.map((event) => event.output_index), [0, 1, 2]);
    for (const item of added) {
        const id = (item.item as JsonObject).id;
        assert.ok(events.filter((event) => event.item_id === id || (event.item as JsonObject | undefined)?.id === id)
            .every((event) => event.output_index === item.output_index));
    }
    assert.deepEqual(((events.at(-1)?.response as JsonObject).output as JsonObject[]).map((item) => item.id), ["fc_call_a", added[1].item && (added[1].item as JsonObject).id, "fc_call_b"]);
});

test("Responses→Chat 工具流在终态空快照时仍返回 tool_calls", () => {
    const raw = [
        sse("response.created", { response: { id: "resp_tool", model: "gpt-x", status: "in_progress", output: [] } }),
        sse("response.output_item.added", {
            output_index: 0,
            item: { id: "fc_call_1", type: "function_call", call_id: "call_1", name: "lookup", arguments: "" },
        }),
        sse("response.function_call_arguments.delta", {
            item_id: "fc_call_1",
            output_index: 0,
            delta: "{\"city\":\"Paris\"}",
        }),
        sse("response.function_call_arguments.done", {
            item_id: "fc_call_1",
            output_index: 0,
            arguments: "{\"city\":\"Paris\"}",
        }),
        sse("response.output_item.done", {
            output_index: 0,
            item: {
                id: "fc_call_1",
                type: "function_call",
                status: "completed",
                call_id: "call_1",
                name: "lookup",
                arguments: "{\"city\":\"Paris\"}",
            },
        }),
        sse("response.completed", {
            response: { id: "resp_tool", model: "gpt-x", status: "completed", output: [], usage: {} },
        }),
    ].join("");
    const events = parseSse(convertResponsesSseToChat(raw));
    assert.equal(events.at(-1)?.choices && ((events.at(-1)?.choices as JsonObject[])[0]).finish_reason, "tool_calls");
});

test("SSE materializer 严格要求协议 terminal", () => {
    assert.throws(() => materializeResponsesSse(sse("response.created", { response: { id: "resp_x" } })), /without a terminal response/);
    assert.throws(() => materializeAnthropicSse(sse("message_start", { message: { id: "msg_x" } })), /without message_stop/);
    const chat = `data: ${JSON.stringify({ id: "chatcmpl-x", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    assert.equal((((materializeChatSse(chat).choices as JsonObject[])[0].message as JsonObject).content), "ok");
    assert.throws(() => materializeChatSse(chat.replace("data: [DONE]\n\n", "")), /without \[DONE\]/);
});

test("HTTP 错误状态映射保留语义", () => {
    assert.deepEqual(openAiErrorToAnthropic(429, { error: { message: "slow" } }), {
        type: "error",
        error: { type: "rate_limit_error", message: "slow" },
    });
    assert.deepEqual(anthropicErrorToOpenAi(401, { error: { type: "authentication_error", message: "bad key" } }), {
        error: {
            type: "authentication_error",
            code: "authentication_error",
            message: "bad key",
            param: null,
        },
    });
});

test("Messages→Responses 处理器命中 /v1/responses 并转换响应", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedBody: JsonObject = {};
    let capturedHeaders = new Headers();
    globalThis.fetch = async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body)) as JsonObject;
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({
            id: "resp_handler",
            model: "gpt-x",
            output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
            usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
        const response = await runConversion(new Request("http://local/v1/messages", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-claude-code-session-id": "claude-inbound-session",
            },
            body: JSON.stringify({ model: "gpt-x", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
        }), upstreamClient({ baseUrl: "https://upstream.test", apikey: "key", apiStyle: "responses" }), conversionPairs["anthropic-responses"]);
        assert.equal(capturedUrl, "https://upstream.test/v1/responses");
        assert.equal(capturedBody.max_output_tokens, undefined);
        const sessionId = capturedHeaders.get("session-id") ?? "";
        assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        assert.notEqual(sessionId, "claude-inbound-session");
        assert.equal(capturedHeaders.get("thread-id"), sessionId);
        assert.equal(capturedHeaders.get("x-client-request-id"), sessionId);
        assert.equal(capturedBody.prompt_cache_key, sessionId);
        assert.equal(((await response.json() as JsonObject).content as JsonObject[])[0].text, "ok");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("Responses 上游 session-id 对同一配置保持稳定", async () => {
    const originalFetch = globalThis.fetch;
    const sessionIds: string[] = [];
    globalThis.fetch = async (_input, init) => {
        sessionIds.push(new Headers(init?.headers).get("session-id") ?? "");
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
        const client = upstreamClient({ baseUrl: "https://upstream.test", apikey: "key", apiStyle: "responses" });
        await client.post("/v1/responses", { model: "gpt-x" });
        await client.post("/v1/responses", { model: "gpt-x" });
        assert.match(sessionIds[0], /^[0-9a-f-]{36}$/);
        assert.equal(sessionIds[0], sessionIds[1]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("Responses 上游探测 text/plain SSE 正文", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("event: response.created\ndata: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
    });
    try {
        const result = await upstreamClient({ baseUrl: "https://upstream.test", apikey: "key", apiStyle: "responses" }).post("/v1/responses", { model: "gpt-x" });
        assert.equal(result.isSse, true);
        assert.match(await result.response.text(), /^event: response\.created/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("Responses 上游不把 text/plain JSON 误判为 SSE", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{\"id\":\"resp_1\"}", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
    });
    try {
        const result = await upstreamClient({ baseUrl: "https://upstream.test", apikey: "key" }).post("/v1/responses", { model: "gpt-x" });
        assert.equal(result.isSse, false);
        assert.equal((await result.response.json() as JsonObject).id, "resp_1");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("Responses→Messages 处理器命中 /v1/messages 并转换响应", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = async (input) => {
        capturedUrl = String(input);
        return new Response(JSON.stringify({
            id: "msg_handler",
            model: "claude-x",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
        const response = await runConversion(new Request("http://local/v1/responses", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "claude-x", input: "hi", max_output_tokens: 10 }),
        }), upstreamClient({ baseUrl: "https://upstream.test", apikey: "key" }), conversionPairs["responses-anthropic"]);
        assert.equal(capturedUrl, "https://upstream.test/v1/messages");
        assert.equal((await response.json() as JsonObject).id, "resp_handler");
    } finally {
        globalThis.fetch = originalFetch;
    }
});
