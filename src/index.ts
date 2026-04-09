import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config as loadEnv } from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { version, name } from "../package.json";
import { Utils } from "./utils";
// 加载环境变量
loadEnv();

type ProviderName = "bigmodel" | "anthropic" | "mock-anthropic" | "unknown";
type AgentApiConfig = {
    chat: string;
}
type ProviderConfig = {
    name: ProviderName;
    baseUrl: string;
    apikey: string;
    apiPath: AgentApiConfig | null;
}

let G_ProviderConfig : ProviderConfig = {
    name: "unknown",
    baseUrl: "",
    apikey: "",
    apiPath: null,
}

function processProviderName(baseUrl: string) {
    if (baseUrl.includes("api.anthropic.com")) {
        return "anthropic";
    }
    else if (baseUrl.includes("/anthropic")) {
        return "mock-anthropic";
    }
    else if (baseUrl.includes("api.bigmodel.cn")) {
        return "bigmodel";
    }
    else {
        return "unknown";
    }
}
function processApiPath(providerName: ProviderName) {
    switch (providerName) {
        case "anthropic":
        case "mock-anthropic":
            return {chat: "/v1/messages"};
        case "bigmodel":
            return {chat: "/chat/completions"};
        default:
            return null;
    }
}

function buildRequestHeaders(headers: HeadersInit) {
    const requestHeaders = new Headers(headers);
    requestHeaders.delete("authorization");
    requestHeaders.set("Authorization", `Bearer ${G_ProviderConfig.apikey}`);
    requestHeaders.set("x-api-key", G_ProviderConfig.apikey); // anthropic 兼容接口
    return requestHeaders;
}
function buildResponseHeaders(headers: HeadersInit) {
    const responseHeaders = new Headers(headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("transfer-encoding");
    return responseHeaders;
}

// 代理服务
const app = new Hono();
app.get("/", (c) => c.text("ok"));
app.get("/api/version", (c) => c.json({ version: version, vendor: name }));
app.post("/v1/messages", async (c) => {
    const startTime = Date.now();
    const body = await c.req.json();
    const chooseModel = body.model ?? "unknown";

    console.log(`[${Utils.timeNow()}] [请求] POST /v1/messages from model ${chooseModel}`);

    try {
        const realRequestUrl = `${G_ProviderConfig.baseUrl}${G_ProviderConfig.apiPath?.chat}`;
        const headers = buildRequestHeaders(c.req.raw.headers);
        
        Utils.dumpObject("发送请求", { url: realRequestUrl, method: "POST", headers: headers, body: body });
        const res = await fetch(realRequestUrl, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(body),
        });
        console.log(`[${Utils.timeNow()}] [上游响应] status=${res.status}`);
        const contentType = res.headers.get("content-type");
        const responseHeaders = buildResponseHeaders(res.headers);

        if (Utils.isSseContentType(contentType) && res.body) { // SSE 响应处理
            const [clientBody, logBody] = res.body.tee();
            void Utils.readStreamToText(logBody)
                .then((rawText) => {
                    Utils.dumpObject("请求回应", {
                        status: res.status,
                        headers: res.headers,
                        body: Utils.responseBodyForLog(rawText, contentType),
                    });
                })
                .catch((error) => {
                    console.error(`[${Utils.timeNow()}] [错误] SSE 日志读取失败:`, error);
                });

            console.log(`[${Utils.timeNow()}] [响应] /v1/messages (耗时: ${Date.now() - startTime}ms)`);
            return new Response(clientBody, {
                status: res.status,
                headers: responseHeaders,
            });
        }

        // 非 SSE 响应处理
        const rawText = await res.clone().text();
        Utils.dumpObject("请求回应", {
            status: res.status,
            headers: res.headers,
            body: Utils.responseBodyForLog(rawText, contentType),
        });
        console.log(`[${Utils.timeNow()}] [响应] /v1/messages (耗时: ${Date.now() - startTime}ms)`);
        return new Response(res.body, {
            status: res.status,
            headers: responseHeaders,
        });

    } catch (e) {
        console.error(`[${Utils.timeNow()}] [错误] 请求发生异常:`, e);
        return c.json({ error: String(e) }, 500);
    }
});

// 主函数：解析参数并启动服务器
async function main() {
    const cli = await yargs(hideBin(process.argv))
            .usage('Usage: mock-ollama [command] <options>') 
            .scriptName("mock-ollama")
            .alias("v", "version")
            .alias("h", "help")
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
            .parse();
    const port = cli.port ?? 11434;
    const host = cli.host ?? "localhost";
    serve(
        {
            fetch: app.fetch,
            hostname: host,
            port: port,
        },
        (info) => {
            console.log(`模拟服务启动在 http://${info.address}:${info.port}`);
        },
    );


    G_ProviderConfig.baseUrl = cli.url ?? process.env.MOCK_OLLAMA_BASE_URL ?? "";
    G_ProviderConfig.apikey = cli.apikey ?? process.env.MOCK_OLLAMA_API_KEY ?? "";

    if (G_ProviderConfig.baseUrl.length === 0 || G_ProviderConfig.apikey.length === 0) {
        console.error("上游服务商配置错误，请检查命令行参数或环境变量");
        console.error("你可以通过命令行参数 --url 和 --apikey 设置");
        console.error("也可以环境变量 MOCK_OLLAMA_BASE_URL 和 MOCK_OLLAMA_API_KEY 设置");
        process.exit(1);
    }
    else {
        if (G_ProviderConfig.baseUrl.endsWith("/")) {// 去除末尾斜杠
            G_ProviderConfig.baseUrl = G_ProviderConfig.baseUrl.slice(0, -1);
        }
    }

    G_ProviderConfig.name = processProviderName(G_ProviderConfig.baseUrl);
    G_ProviderConfig.apiPath = processApiPath(G_ProviderConfig.name);
    console.log(`上游服务商配置:\n${G_ProviderConfig.name}, ${G_ProviderConfig.baseUrl}, ${Utils.maskSecret(G_ProviderConfig.apikey)}`);
    Utils.dumpObject("ApiPathConfig", G_ProviderConfig.apiPath);
}

// 启动入口
main().catch((err) => {
    console.error("服务启动报错:", err);
    process.exit(1);
});
  