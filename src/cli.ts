import { serve } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { startCursorServer } from "./cursor_server";
import { createApp } from "./router";
import { configureProvider } from "./provider";
import { dumpObject, maskSecret, setObjectDumpQuiet } from "./utils";

if (existsSync(".env")) loadEnvFile();

const packageVersion = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8")).version as string;

export async function main() {
    const providerPresetDemo = [
        "\n命令行参数示例:",
        `  mock-ollama --url "https://api.deepseek.com" --apikey "your-key"`,
        `  mock-ollama --url "https://api.anthropic.com" --apikey "your-key" --open`,
        `  mock-ollama --url https://open.bigmodel.cn/api/paas/v4 --apikey key --bridge`,
        `  mock-ollama --cursor`,
        "\n启动后测试:",
        `  curl http://localhost:11434/api/version`,
        `  curl http://localhost:11434/api/tags`,
        `  curl -X POST http://localhost:11434/chat/completions -H "Content-Type: application/json" -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}'`,
        "\n访问 http://localhost:11434 查看日志页面",
    ].join("\n");
    const cli = await yargs(hideBin(process.argv))
            .usage("Usage: mock-ollama [command] <options>")
            .scriptName("mock-ollama")
            .version(packageVersion)
            .alias("v", "version")
            .alias("h", "help")
            .alias("q", "quiet")
            .option("port", {
                type: "number",
                description: "模拟 ollama server port",
            })
            .option("host", {
                type: "string",
                description: "模拟 ollama server host",
            })
            .option("apikey", {
                type: "string",
                description: "上游服务商 apikey，或者export MOCK_OLLAMA_API_KEY",
            })
            .option("url", {
                type: "string",
                description: "上游服务商 url，或者export MOCK_OLLAMA_BASE_URL",
            })
            .option("api-style", {
                type: "string",
                choices: ["auto", "anthropic", "responses", "chat"],
                description: "上游 API 格式：auto/anthropic/responses/chat，auto 自动探测",
            })
            .option("bridge", {
                type: "boolean",
                default: false,
                description: "启用 Anthropic/Responses/Chat 三格式矩阵互转",
            })
            .option("cursor", {
                type: "boolean",
                default: false,
                description: "启动仅供 Cursor BYOK 使用的本机公网代理和临时 Cloudflare Tunnel",
            })
            .option("cursor-port", {
                type: "number",
                default: 11435,
                description: "Cursor 公网代理端口，默认 11435",
            })
            .option("cursor-api-key", {
                type: "string",
                description: "Cursor 公网代理 Bearer key，默认生成随机 key",
            })
            .option("cursor-upstream", {
                type: "string",
                default: "http://localhost:11434",
                description: "已运行的本机 mock-ollama 地址",
            })
            .option("cursor-tunnel", {
                type: "string",
                choices: ["quick", "off"],
                default: "quick",
                description: "Cursor 入口隧道模式：quick 或 off",
            })
            .option("quiet", {
                type: "boolean",
                description: "安静模式",
            })
            .option("open", {
                type: "boolean",
                description: "启动后自动打开浏览器",
            })
            .option("max_context", {
                type: "number",
                description: "网页上下文长度上限（token）",
                default: 200_000,
            })
            .epilog(providerPresetDemo)
            .parse();

    if (cli.cursor) {
        const configuredApiKey = cli.cursorApiKey ?? process.env.MOCK_OLLAMA_CURSOR_API_KEY;
        const apiKey = configuredApiKey ?? randomBytes(32).toString("base64url");
        await startCursorServer({
            port: cli.cursorPort,
            apiKey,
            upstream: cli.cursorUpstream ?? process.env.MOCK_OLLAMA_CURSOR_UPSTREAM ?? "http://localhost:11434",
            tunnel: cli.cursorTunnel as "quick" | "off",
            generatedKey: configuredApiKey === undefined,
        });
        return;
    }

    const port = cli.port ?? 11434;
    const host = cli.host ?? "localhost";
    setObjectDumpQuiet(cli.quiet ?? false);
    const context = configureProvider({
        baseUrl: cli.url ?? process.env.MOCK_OLLAMA_BASE_URL ?? "",
        apikey: cli.apikey ?? process.env.MOCK_OLLAMA_API_KEY ?? "",
        apiStyle: cli.apiStyle,
        bridge: cli.bridge,
        contextLength: cli.max_context,
    });

    if (context.config.baseUrl.length === 0 || context.config.apikey.length === 0) {
        console.error("上游服务商配置错误，请检查命令行参数或环境变量");
        console.error("你可以通过命令行参数 --url 和 --apikey 设置");
        console.error("也可以环境变量 MOCK_OLLAMA_BASE_URL 和 MOCK_OLLAMA_API_KEY 设置");
        process.exit(1);
    }

    const app = createApp(context);
    serve(
        {
            fetch: app.fetch,
            hostname: host,
            port,
        },
        (info) => {
            const displayUrl = `http://localhost:${info.port}`;
            console.log(`服务启动: ${displayUrl}（浏览器打开获取更好体验）`);
            if (cli.open) {
                const { execSync } = require("node:child_process");
                try {
                    execSync(`open "${displayUrl}"`, { stdio: "ignore" });
                } catch {
                    try {
                        execSync(`xdg-open "${displayUrl}"`, { stdio: "ignore" });
                    } catch {
                        console.log(`请手动打开浏览器访问 ${displayUrl}`);
                    }
                }
            }
        },
    );
    console.log(`上游服务商配置:\n${context.config.name}, ${context.config.apiStyle}→${context.upstreamFormat}, bridge=${context.bridge}, ${context.config.baseUrl}, ${maskSecret(context.config.apikey)}`);
    console.log(`网页上下文上限: ${context.contextLength} tokens`);
    dumpObject("ApiPathConfig", context.config.apiPath);
}

if (require.main === module) {
    main().catch((error) => {
        console.error("服务启动报错:", error);
        process.exit(1);
    });
}
