import { object, string, type JsonObject } from "./types";

export class ProtocolConversionError extends Error {
    constructor(
        message: string,
        readonly status = 400,
        readonly field?: string,
    ) {
        super(message);
        this.name = "ProtocolConversionError";
    }
}


function anthropicErrorType(status: number): string {
    if (status === 400) return "invalid_request_error";
    if (status === 401) return "authentication_error";
    if (status === 403) return "permission_error";
    if (status === 404) return "not_found_error";
    if (status === 429) return "rate_limit_error";
    return status >= 500 ? "api_error" : "invalid_request_error";
}

function openAiErrorType(status: number): string {
    if (status === 401) return "authentication_error";
    if (status === 403) return "permission_error";
    if (status === 404) return "not_found_error";
    if (status === 429) return "rate_limit_error";
    return status >= 500 ? "server_error" : "invalid_request_error";
}

export function errorMessage(body: unknown, fallback: string): string {
    const detail = object(body);
    return string(object(detail?.error)?.message) ?? string(detail?.message) ?? fallback;
}

export function openAiErrorToAnthropic(status: number, body: unknown): JsonObject {
    return {
        type: "error",
        error: {
            type: anthropicErrorType(status),
            message: errorMessage(body, "Upstream request failed"),
        },
    };
}

export function anthropicErrorToOpenAi(status: number, body: unknown): JsonObject {
    const detail = object(body);
    const sourceError = object(detail?.error);
    return {
        error: {
            type: openAiErrorType(status),
            code: string(sourceError?.type) ?? openAiErrorType(status),
            message: errorMessage(body, "Upstream request failed"),
            param: null,
        },
    };
}
