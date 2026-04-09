import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config as loadEnv } from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { version, name } from "../package.json";
// 加载环境变量
loadEnv();

type ProviderConfig = {
    baseUrl: string;
    apikey: string;
}
let G_ProviderConfig : ProviderConfig = {
    baseUrl: "",
    apikey: "",
}

function maskSecret(secret: string): string {
    if (secret.length <= 10) {
        return secret;
    }
    return `${secret.slice(0, 5)}...${secret.slice(-5)}`;
}


const app = new Hono();
app.get("/", (c) => c.text("ok"));
app.get("/api/version", (c) => c.json({ version: version, vendor: name }));



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

    console.log(`上游服务商配置: ${G_ProviderConfig.baseUrl}, ${maskSecret(G_ProviderConfig.apikey)}`);
}

// 启动入口
main().catch((err) => {
    console.error("服务启动报错:", err);
    process.exit(1);
});
  