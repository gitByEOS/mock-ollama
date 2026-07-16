export type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as JsonObject
        : null;
}

export function string(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

export function array(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

export function number(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function integer(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function parseObjectJson(value: unknown): JsonObject {
    if (typeof value !== "string" || value.trim() === "") return {};
    try {
        return object(JSON.parse(value)) ?? {};
    } catch {
        return {};
    }
}
