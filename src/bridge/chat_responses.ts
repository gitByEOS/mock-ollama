import { array, number, object, string, type JsonObject } from "./types";
import { ProtocolConversionError } from "./errors";

function chatPartToResponses(rawPart: unknown, role: string): JsonObject[] {
    if (typeof rawPart === "string") {
        return [{ type: role === "assistant" ? "output_text" : "input_text", text: rawPart }];
    }
    const part = object(rawPart);
    if (!part) return [];
    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
        return [{ type: role === "assistant" ? "output_text" : "input_text", text: string(part.text) ?? "" }];
    }
    if (part.type === "image_url") {
        const imageUrl = typeof part.image_url === "string" ? part.image_url : string(object(part.image_url)?.url);
        return imageUrl ? [{ type: "input_image", image_url: imageUrl }] : [];
    }
    if (part.type === "file") {
        const file = object(part.file) ?? {};
        return [{
            type: "input_file",
            ...(string(file.file_id) ? { file_id: file.file_id } : {}),
            ...(string(file.file_data) ? { file_data: file.file_data } : {}),
            ...(string(file.filename) ? { filename: file.filename } : {}),
        }];
    }
    return [];
}

function responsesPartToChat(rawPart: unknown): JsonObject[] {
    const part = object(rawPart);
    if (!part) return [];
    if (part.type === "input_text" || part.type === "output_text") {
        return [{ type: "text", text: string(part.text) ?? "" }];
    }
    if (part.type === "input_image") {
        return string(part.image_url) ? [{ type: "image_url", image_url: { url: part.image_url } }] : [];
    }
    if (part.type === "input_file") {
        return [{
            type: "file",
            file: {
                ...(string(part.file_id) ? { file_id: part.file_id } : {}),
                ...(string(part.file_data) ? { file_data: part.file_data } : {}),
                ...(string(part.filename) ? { filename: part.filename } : {}),
            },
        }];
    }
    return [];
}

/** OpenAI Chat Completions 请求直转 OpenAI Responses 请求。 */
export function chatRequestToResponses(body: JsonObject): JsonObject {
    if (body.stop !== undefined && !(Array.isArray(body.stop) && body.stop.length === 0)) {
        throw new ProtocolConversionError("OpenAI Responses API does not support Chat stop", 400, "stop");
    }
    const input: JsonObject[] = [];
    const instructions: string[] = [];
    for (const rawMessage of array(body.messages)) {
        const message = object(rawMessage);
        const role = string(message?.role);
        if (!message || !role) continue;
        const rawContent = typeof message.content === "string" ? [message.content] : array(message.content);
        if (role === "system" || role === "developer") {
            const text = rawContent.flatMap((part) => chatPartToResponses(part, role))
                .map((part) => string(part.text) ?? "").filter(Boolean).join("\n");
            if (text) instructions.push(text);
            continue;
        }
        if (role === "tool") {
            input.push({
                type: "function_call_output",
                call_id: string(message.tool_call_id) ?? "",
                output: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
            });
            continue;
        }
        if (role !== "user" && role !== "assistant") continue;
        const content = rawContent.flatMap((part) => chatPartToResponses(part, role));
        if (content.length > 0) input.push({ type: "message", role, content });
        if (role === "assistant") {
            for (const rawCall of array(message.tool_calls)) {
                const call = object(rawCall) ?? {};
                const fn = object(call.function) ?? {};
                const callId = string(call.id) ?? `call_${input.length}`;
                input.push({
                    type: "function_call",
                    id: `fc_${callId}`,
                    call_id: callId,
                    name: string(fn.name) ?? "unknown",
                    arguments: string(fn.arguments) ?? "{}",
                });
            }
        }
    }
    const result: JsonObject = {
        model: body.model,
        input,
        stream: body.stream === true,
    };
    if (instructions.length > 0) result.instructions = instructions.join("\n");
    result.max_output_tokens = body.max_completion_tokens ?? body.max_tokens;
    for (const field of ["temperature", "top_p", "service_tier", "parallel_tool_calls", "user"] as const) {
        if (body[field] !== undefined) result[field] = body[field];
    }
    if (body.reasoning_effort !== undefined) result.reasoning = { effort: body.reasoning_effort };
    const tools = array(body.tools).flatMap((rawTool): JsonObject[] => {
        const tool = object(rawTool);
        const fn = object(tool?.function);
        if (!tool || tool.type !== "function" || !fn) return [];
        return [{
            type: "function",
            name: string(fn.name) ?? "unknown",
            ...(string(fn.description) ? { description: fn.description } : {}),
            parameters: object(fn.parameters) ?? { type: "object", properties: {} },
        }];
    });
    if (tools.length > 0) result.tools = tools;
    const choice = body.tool_choice;
    const choiceObject = object(choice);
    if (typeof choice === "string") result.tool_choice = choice === "none" ? "none" : choice;
    else if (choiceObject?.type === "function") {
        result.tool_choice = { type: "function", name: string(object(choiceObject.function)?.name) ?? "" };
    }
    const format = object(body.response_format);
    if (format) result.text = { format };
    return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
}

/** OpenAI Responses 请求直转 OpenAI Chat Completions 请求。 */
export function responsesRequestToChat(body: JsonObject): JsonObject {
    const messages: JsonObject[] = [];
    if (string(body.instructions)) messages.push({ role: "system", content: body.instructions });
    const input = typeof body.input === "string"
        ? [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }]
        : array(body.input);
    for (const rawItem of input) {
        const item = object(rawItem);
        if (!item) continue;
        const type = string(item.type) ?? (string(item.role) ? "message" : "");
        if (type === "message") {
            const role = string(item.role) ?? "user";
            const content = typeof item.content === "string"
                ? item.content
                : array(item.content).flatMap(responsesPartToChat);
            messages.push({ role, content });
            continue;
        }
        if (type === "function_call") {
            messages.push({
                role: "assistant",
                content: null,
                tool_calls: [{
                    id: string(item.call_id) ?? string(item.id)?.replace(/^fc_/, "") ?? "call_unknown",
                    type: "function",
                    function: { name: string(item.name) ?? "unknown", arguments: string(item.arguments) ?? "{}" },
                }],
            });
            continue;
        }
        if (type === "function_call_output") {
            messages.push({
                role: "tool",
                tool_call_id: string(item.call_id) ?? "",
                content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
            });
        }
    }
    const result: JsonObject = {
        model: body.model,
        messages,
        stream: body.stream === true,
        max_completion_tokens: body.max_output_tokens,
    };
    for (const field of ["temperature", "top_p", "service_tier", "parallel_tool_calls", "user"] as const) {
        if (body[field] !== undefined) result[field] = body[field];
    }
    if (string(object(body.reasoning)?.effort)) result.reasoning_effort = object(body.reasoning)?.effort;
    const tools = array(body.tools).flatMap((rawTool): JsonObject[] => {
        const tool = object(rawTool);
        if (!tool || tool.type !== "function") return [];
        return [{
            type: "function",
            function: {
                name: string(tool.name) ?? "unknown",
                ...(string(tool.description) ? { description: tool.description } : {}),
                parameters: object(tool.parameters) ?? { type: "object", properties: {} },
            },
        }];
    });
    if (tools.length > 0) result.tools = tools;
    const choice = body.tool_choice;
    const choiceObject = object(choice);
    if (typeof choice === "string") result.tool_choice = choice;
    else if (choiceObject?.type === "function") {
        result.tool_choice = { type: "function", function: { name: choiceObject.name } };
    }
    const textFormat = object(object(body.text)?.format);
    if (textFormat) result.response_format = textFormat;
    return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
}

function chatFinishReason(response: JsonObject, hasTools: boolean): string {
    if (hasTools) return "tool_calls";
    if (response.status === "incomplete" || object(response.incomplete_details)?.reason === "max_output_tokens") return "length";
    return "stop";
}

/** OpenAI Responses 普通响应直转 Chat Completions 响应。 */
export function responsesResponseToChat(response: JsonObject, request: JsonObject = {}): JsonObject {
    const text: string[] = [];
    const refusals: string[] = [];
    const toolCalls: JsonObject[] = [];
    for (const rawItem of array(response.output)) {
        const item = object(rawItem);
        if (!item) continue;
        if (item.type === "message") {
            for (const rawPart of array(item.content)) {
                const part = object(rawPart);
                if (part?.type === "output_text") text.push(string(part.text) ?? "");
                if (part?.type === "refusal") refusals.push(string(part.refusal) ?? "");
            }
        }
        if (item.type === "function_call") {
            toolCalls.push({
                id: string(item.call_id) ?? string(item.id)?.replace(/^fc_/, "") ?? "call_unknown",
                type: "function",
                function: { name: string(item.name) ?? "unknown", arguments: string(item.arguments) ?? "{}" },
            });
        }
    }
    const usage = object(response.usage) ?? {};
    const prompt = number(usage.input_tokens) ?? 0;
    const completion = number(usage.output_tokens) ?? 0;
    return {
        id: string(response.id)?.replace(/^resp_/, "chatcmpl-") ?? `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion",
        created: number(response.created_at) ?? Math.floor(Date.now() / 1000),
        model: string(response.model) ?? string(request.model) ?? "unknown",
        choices: [{
            index: 0,
            message: {
                role: "assistant",
                content: text.join("") || null,
                ...(refusals.length > 0 ? { refusal: refusals.join("") } : {}),
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: chatFinishReason(response, toolCalls.length > 0),
        }],
        usage: {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: number(usage.total_tokens) ?? prompt + completion,
            ...(object(usage.input_tokens_details) ? { prompt_tokens_details: usage.input_tokens_details } : {}),
            ...(object(usage.output_tokens_details) ? { completion_tokens_details: usage.output_tokens_details } : {}),
        },
    };
}

/** OpenAI Chat Completions 普通响应直转 Responses 响应。 */
export function chatResponseToResponses(response: JsonObject, request: JsonObject = {}): JsonObject {
    const choice = object(array(response.choices)[0]) ?? {};
    const message = object(choice.message) ?? {};
    const id = string(response.id)?.replace(/^chatcmpl-/, "resp_") ?? `resp_${crypto.randomUUID()}`;
    const output: JsonObject[] = [];
    const content: JsonObject[] = [];
    if (string(message.content)) content.push({ type: "output_text", text: message.content, annotations: [] });
    if (string(message.refusal)) content.push({ type: "refusal", refusal: message.refusal });
    if (content.length > 0) {
        output.push({ id: `msg_${id}`, type: "message", status: "completed", role: "assistant", content });
    }
    for (const rawCall of array(message.tool_calls)) {
        const call = object(rawCall) ?? {};
        const fn = object(call.function) ?? {};
        const callId = string(call.id) ?? `call_${output.length}`;
        output.push({
            id: `fc_${callId}`,
            type: "function_call",
            status: "completed",
            call_id: callId,
            name: string(fn.name) ?? "unknown",
            arguments: string(fn.arguments) ?? "{}",
        });
    }
    const usage = object(response.usage) ?? {};
    const input = number(usage.prompt_tokens) ?? 0;
    const outputTokens = number(usage.completion_tokens) ?? 0;
    const incomplete = choice.finish_reason === "length";
    return {
        id,
        object: "response",
        created_at: number(response.created) ?? Math.floor(Date.now() / 1000),
        model: string(response.model) ?? string(request.model) ?? "unknown",
        status: incomplete ? "incomplete" : "completed",
        ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
        output,
        usage: {
            input_tokens: input,
            input_tokens_details: object(usage.prompt_tokens_details) ?? { cached_tokens: 0 },
            output_tokens: outputTokens,
            ...(object(usage.completion_tokens_details) ? { output_tokens_details: usage.completion_tokens_details } : {}),
            total_tokens: number(usage.total_tokens) ?? input + outputTokens,
        },
    };
}

/** Anthropic Messages 普通响应直转 Chat Completions 响应。 */
