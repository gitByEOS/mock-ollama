import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type TokenUsage = {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
};

export type TokenLog = TokenUsage & {
    occurredAt: string;
    model: string;
    upstream: string;
    userAgent: string;
    durationMs: number;
    status: number;
};

type NumberRecord = Record<string, unknown>;

type TrendBucket = {
    bucket: string;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    requestCount: number;
};

const TOKEN_DB_SCHEMA_VERSION = 1;

function asRecord(value: unknown): NumberRecord | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as NumberRecord : undefined;
}

function numberFrom(...values: unknown[]): number | undefined {
    for (const value of values) {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    }
    return undefined;
}

/** Anthropic 顶层 cache_* 与 input 分离；OpenAI/Responses 的 input/prompt 已含 cached。 */
function hasSeparatedCacheFields(usage: NumberRecord): boolean {
    return Object.hasOwn(usage, "cache_read_input_tokens")
        || Object.hasOwn(usage, "cache_creation_input_tokens")
        || Object.hasOwn(usage, "cache_read_tokens")
        || Object.hasOwn(usage, "cache_creation_tokens");
}

/** 统一为总输入口径：Anthropic 补上 cache，OpenAI/Responses 保持 prompt 总量。 */
export function extractTokenUsage(response: unknown): TokenUsage | undefined {
    const usage = asRecord(asRecord(response)?.usage);
    if (!usage) return undefined;
    const inputDetails = asRecord(usage.input_tokens_details);
    const promptDetails = asRecord(usage.prompt_tokens_details);
    const input = numberFrom(usage.input_tokens, usage.prompt_tokens);
    const output = numberFrom(usage.output_tokens, usage.completion_tokens);
    const cacheRead = numberFrom(
        usage.cache_read_input_tokens,
        usage.cache_read_tokens,
        inputDetails?.cached_tokens,
        promptDetails?.cached_tokens,
    );
    const cacheCreation = numberFrom(
        usage.cache_creation_input_tokens,
        usage.cache_creation_tokens,
        inputDetails?.cache_creation_tokens,
        promptDetails?.cache_creation_tokens,
    );
    if (input === undefined && output === undefined && cacheRead === undefined && cacheCreation === undefined) return undefined;
    const cacheReadTokens = cacheRead ?? 0;
    const cacheCreationTokens = cacheCreation ?? 0;
    const rawInput = input ?? 0;
    return {
        inputTokens: hasSeparatedCacheFields(usage)
            ? rawInput + cacheReadTokens + cacheCreationTokens
            : rawInput,
        outputTokens: output ?? 0,
        cacheReadTokens,
        cacheCreationTokens,
    };
}

function dateParts(occurredAt: string): { date: string; hour: string } {
    const parsed = new Date(occurredAt);
    const value = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    const offset = value.getTimezoneOffset() * 60_000;
    const local = new Date(value.getTime() - offset).toISOString();
    return { date: local.slice(0, 10), hour: local.slice(0, 13) };
}

function localDate(date: string): Date {
    return new Date(`${date}T00:00:00`);
}

function shiftLocalDate(date: string, days: number): string {
    const value = localDate(date);
    value.setDate(value.getDate() + days);
    return dateParts(value.toISOString()).date;
}

function emptyTrendBucket(bucket: string): TrendBucket {
    return {
        bucket,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requestCount: 0,
    };
}

function continuousDaily(rows: TrendBucket[], fromDate: string, days: number): TrendBucket[] {
    const byBucket = new Map(rows.map((row) => [row.bucket, row]));
    return Array.from({ length: days }, (_, index) => {
        const bucket = shiftLocalDate(fromDate, index);
        return byBucket.get(bucket) ?? emptyTrendBucket(bucket);
    });
}

function shiftLocalHour(hour: string, offset: number): string {
    const value = new Date(`${hour}:00:00`);
    value.setHours(value.getHours() + offset);
    return dateParts(value.toISOString()).hour;
}

function continuousRollingHourly(rows: TrendBucket[], currentHour: string): TrendBucket[] {
    const byBucket = new Map(rows.map((row) => [row.bucket, row]));
    return Array.from({ length: 24 }, (_, index) => {
        const bucket = shiftLocalHour(currentHour, index - 23);
        return byBucket.get(bucket) ?? emptyTrendBucket(bucket);
    });
}

function rollingHourStart(hour: string): string {
    return shiftLocalHour(hour, -23);
}

function defaultDatabasePath(): string {
    return process.env.MOCK_OLLAMA_TOKEN_DB_PATH
        ?? join(process.cwd(), ".mock-ollama", "token-usage.db");
}

export class TokenUsageStore {
    private readonly db: Database.Database;

    constructor(path = defaultDatabasePath()) {
        mkdirSync(dirname(path), { recursive: true });
        this.db = new Database(path);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("busy_timeout = 5000");
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS token_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                occurred_at TEXT NOT NULL,
                date TEXT NOT NULL,
                hour TEXT NOT NULL,
                model TEXT NOT NULL,
                upstream TEXT NOT NULL,
                user_agent TEXT NOT NULL,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                status INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_token_logs_date ON token_logs(date);
            CREATE INDEX IF NOT EXISTS idx_token_logs_date_occurred_at ON token_logs(date, occurred_at DESC);
            CREATE INDEX IF NOT EXISTS idx_token_logs_hour ON token_logs(hour);
            CREATE INDEX IF NOT EXISTS idx_token_logs_occurred_at ON token_logs(occurred_at);

            CREATE TABLE IF NOT EXISTS daily_rollup (
                date TEXT NOT NULL,
                model TEXT NOT NULL,
                upstream TEXT NOT NULL,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                request_count INTEGER NOT NULL DEFAULT 0,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (date, model, upstream)
            );
        `);
        const schemaVersion = this.db.pragma("user_version", { simple: true }) as number;
        if (schemaVersion > TOKEN_DB_SCHEMA_VERSION) {
            this.db.close();
            throw new Error(`token usage database schema ${schemaVersion} is newer than supported ${TOKEN_DB_SCHEMA_VERSION}`);
        }
        if (schemaVersion < TOKEN_DB_SCHEMA_VERSION) {
            // Token persistence has not shipped before schema v1, so there is no released legacy layout to rewrite.
            this.db.pragma(`user_version = ${TOKEN_DB_SCHEMA_VERSION}`);
        }
    }

    record(log: TokenLog): void {
        const { date, hour } = dateParts(log.occurredAt);
        const totalTokens = log.inputTokens + log.outputTokens;
        const insert = this.db.transaction(() => {
            this.db.prepare(`
                INSERT INTO token_logs (
                    occurred_at, date, hour, model, upstream, user_agent,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                    total_tokens, duration_ms, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                log.occurredAt, date, hour, log.model, log.upstream, log.userAgent,
                log.inputTokens, log.outputTokens, log.cacheReadTokens, log.cacheCreationTokens,
                totalTokens, log.durationMs, log.status,
            );
            this.db.prepare(`
                INSERT INTO daily_rollup (
                    date, model, upstream, input_tokens, output_tokens, cache_read_tokens,
                    cache_creation_tokens, total_tokens, request_count, duration_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                ON CONFLICT(date, model, upstream) DO UPDATE SET
                    input_tokens = input_tokens + excluded.input_tokens,
                    output_tokens = output_tokens + excluded.output_tokens,
                    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
                    cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
                    total_tokens = total_tokens + excluded.total_tokens,
                    request_count = request_count + 1,
                    duration_ms = duration_ms + excluded.duration_ms
            `).run(
                date, log.model, log.upstream, log.inputTokens, log.outputTokens,
                log.cacheReadTokens, log.cacheCreationTokens, totalTokens, log.durationMs,
            );
        });
        insert();
    }

    getDashboard(days = 7) {
        const safeDays = Math.min(Math.max(Math.floor(days), 1), 30);
        const nowHour = dateParts(new Date().toISOString()).hour;
        const today = nowHour.slice(0, 10);
        const fromDate = shiftLocalDate(today, -safeDays + 1);
        const rollingFromHour = shiftLocalHour(nowHour, -23);
        const isRollingDay = safeDays === 1;
        const totalsQuery = isRollingDay
            ? "SELECT COALESCE(SUM(total_tokens), 0) AS totalTokens, COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens, COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens, COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens, COUNT(*) AS requestCount, COALESCE(SUM(duration_ms), 0) AS durationMs FROM token_logs WHERE hour >= ? AND hour <= ?"
            : "SELECT COALESCE(SUM(total_tokens), 0) AS totalTokens, COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens, COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens, COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens, COALESCE(SUM(request_count), 0) AS requestCount, COALESCE(SUM(duration_ms), 0) AS durationMs FROM daily_rollup WHERE date >= ? AND date <= ?";
        const rangeParams = isRollingDay ? [rollingFromHour, nowHour] : [fromDate, today];
        const totals = this.db.prepare(totalsQuery).get(...rangeParams) as Record<string, number>;
        const activeClients = (this.db.prepare(
            isRollingDay
                ? "SELECT COUNT(DISTINCT user_agent) AS activeClients FROM token_logs WHERE hour >= ? AND hour <= ?"
                : "SELECT COUNT(DISTINCT user_agent) AS activeClients FROM token_logs WHERE date >= ? AND date <= ?",
        ).get(...(isRollingDay ? [rollingFromHour, nowHour] : [fromDate, today])) as { activeClients: number }).activeClients;
        const dailyRows = this.db.prepare(`
            SELECT date AS bucket, SUM(total_tokens) AS totalTokens, SUM(input_tokens) AS inputTokens,
                   SUM(output_tokens) AS outputTokens, SUM(cache_read_tokens) AS cacheReadTokens,
                   SUM(cache_creation_tokens) AS cacheCreationTokens, SUM(request_count) AS requestCount
            FROM daily_rollup WHERE date >= ? AND date <= ? GROUP BY date ORDER BY date
        `).all(fromDate, today) as TrendBucket[];
        const hourlyRows = this.db.prepare(`
            SELECT hour AS bucket, SUM(total_tokens) AS totalTokens, SUM(input_tokens) AS inputTokens,
                   SUM(output_tokens) AS outputTokens, SUM(cache_read_tokens) AS cacheReadTokens,
                   SUM(cache_creation_tokens) AS cacheCreationTokens, COUNT(*) AS requestCount
            FROM token_logs WHERE hour >= ? AND hour <= ? GROUP BY hour ORDER BY hour
        `).all(rollingFromHour, nowHour) as TrendBucket[];
        const daily = continuousDaily(dailyRows, fromDate, safeDays);
        const hourly = continuousRollingHourly(hourlyRows, nowHour);
        const models = (isRollingDay ? this.db.prepare(`
            SELECT model, SUM(total_tokens) AS totalTokens
            FROM token_logs WHERE hour >= ? AND hour <= ? GROUP BY model ORDER BY totalTokens DESC
        `) : this.db.prepare(`
            SELECT model, SUM(total_tokens) AS totalTokens
            FROM daily_rollup WHERE date >= ? AND date <= ? GROUP BY model ORDER BY totalTokens DESC
        `)).all(...(isRollingDay ? [rollingFromHour, nowHour] : [fromDate, today]));
        const totalTokens = totals.totalTokens ?? 0;
        const inputTokens = totals.inputTokens ?? 0;
        const outputTokens = totals.outputTokens ?? 0;
        const cacheReadTokens = totals.cacheReadTokens ?? 0;
        const durationMs = totals.durationMs ?? 0;
        return {
            overview: {
                totalTokens,
                requestCount: totals.requestCount ?? 0,
                activeClients,
                // 与官网一致：按 token 量加权，而非按请求是否命中
                cacheHitRate: inputTokens > 0 ? cacheReadTokens / inputTokens : 0,
                // 生成速率只看 output，避免 cache read 把吞吐抬虚
                tokensPerSecond: durationMs > 0 ? outputTokens / (durationMs / 1000) : 0,
            },
            range: {
                days: safeDays,
                from: isRollingDay ? rollingFromHour : fromDate,
                to: isRollingDay ? nowHour : today,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
            },
            trends: { daily, hourly },
            models,
        };
    }

    getRequests(days = 7, limit = 50, offset = 0) {
        const safeDays = Math.min(Math.max(Math.floor(days), 1), 30);
        const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
        const safeOffset = Math.max(Math.floor(offset), 0);
        const nowHour = dateParts(new Date().toISOString()).hour;
        const today = nowHour.slice(0, 10);
        const fromDate = shiftLocalDate(today, -safeDays + 1);
        const isRollingDay = safeDays === 1;
        const range = isRollingDay ? [rollingHourStart(nowHour), nowHour] : [fromDate, today];
        const where = isRollingDay ? "hour >= ? AND hour <= ?" : "date >= ? AND date <= ?";
        const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM token_logs WHERE ${where}`).get(...range) as { count: number }).count;
        const items = this.db.prepare(`
            SELECT id, occurred_at AS occurredAt, model, upstream,
                   input_tokens AS inputTokens, output_tokens AS outputTokens,
                   cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheCreationTokens,
                   total_tokens AS totalTokens, duration_ms AS durationMs, status
            FROM token_logs WHERE ${where}
            ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?
        `).all(...range, safeLimit, safeOffset);
        return { items, total, limit: safeLimit, offset: safeOffset };
    }


    close(): void {
        this.db.close();
    }
}

let sharedStore: TokenUsageStore | undefined;
const pendingWrites = new Set<Promise<void>>();

function getStore(): TokenUsageStore {
    sharedStore ??= new TokenUsageStore();
    return sharedStore;
}

/** Queue the synchronous SQLite write after the proxied response has completed. */
export function recordTokenUsageAsync(log: TokenLog): void {
    const write = new Promise<void>((resolve) => {
        setImmediate(() => {
            try {
                getStore().record(log);
            } catch (error) {
                console.error("record token usage failed:", error);
            } finally {
                resolve();
            }
        });
    });
    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write));
}

export async function flushTokenUsageWrites(): Promise<void> {
    while (pendingWrites.size > 0) await Promise.all([...pendingWrites]);
}

export async function closeTokenUsageStore(): Promise<void> {
    await flushTokenUsageWrites();
    sharedStore?.close();
    sharedStore = undefined;
}

export function getTokenDashboard(days?: number) {
    return getStore().getDashboard(days);
}

export function getTokenRequests(days?: number, limit?: number, offset?: number) {
    return getStore().getRequests(days, limit, offset);
}
