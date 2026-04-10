# mock-ollama

把第三方大模型接口伪装成 `Ollama` 服务，方便本地插件或脚本继续按 `http://localhost:11434` 这一套接入。

当前主要用途：

- 代理 OpenAI 兼容聊天接口
- 暴露 Ollama 风格的 `api/version`、`api/tags`、`api/show`
- 兼容部分 Anthropic 风格请求
- 打印请求和响应，便于查看token消耗

## 安装

### 全局安装

```bash
npm install -g mock-ollama
mock-ollama -h
```

### 直接用 npx

```bash
npm install mock-ollama
npx mock-ollama -h
```

### 本地开发

```bash
npm install
npm run dev
```

## 快速开始

最常见的是把它指到一个 OpenAI 兼容上游，比如 GLM:

```bash
export MOCK_OLLAMA_BASE_URL="open.bigmodel.cn/api/paas/v4"
export MOCK_OLLAMA_API_KEY="your-api-key"
mock-ollama
```

启动后默认监听：

```bash
http://localhost:11434
```

可以先测2个接口：

```bash
curl http://localhost:11434/api/version
curl http://localhost:11434/api/tags
```

聊天请求示例：

```bash
curl -X POST http://localhost:11434/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.6",
    "messages": [
      { "role": "user", "content": "你好" }
    ]
  }'
```

## 参数

```bash
mock-ollama --url <上游地址> --apikey <上游密钥>
```

常用参数：

- `--host`：监听地址，默认 `localhost`
- `--port`：监听端口，默认 `11434`
- `--url`：上游服务地址
- `--apikey`：上游服务密钥
- `--provider-preset`：额外 provider JSON 配置
- `--quiet`：安静模式，只关闭 `ObjectDump` 日志

## 环境变量

- `MOCK_OLLAMA_BASE_URL`
- `MOCK_OLLAMA_API_KEY`
- `MOCK_OLLAMA_PROVIDER_PRESET`

示例：

```bash
export MOCK_OLLAMA_BASE_URL="https://open.bigmodel.cn/api/paas/v4"
export MOCK_OLLAMA_API_KEY="your-api-key"
export MOCK_OLLAMA_PROVIDER_PRESET='{
  "my-glm": {
    "matchStr": "bigmodel.cn",
    "apiPath": {
      "chat": "/chat/completions",
      "tags": "/models"
    }
  }
}'
mock-ollama
```

## Provider 预设

内置会根据 `baseUrl` 自动匹配 provider。

当前内置示例：

- `api.anthropic.com`
- `api.deepseek.com`
- `bigmodel.cn`

如果内置不够，就自己传一段 JSON merge 进去：

```json
{
  "my-provider": {
    "matchStr": "example.com",
    "apiPath": {
      "chat": "/chat/completions",
      "tags": "/models"
    }
  }
}
```

## 路由接口

- `GET /`
- `GET /api/version`
- `GET /api/tags`
- `POST /api/show`
- `POST /chat/completions`
- `POST /v1/chat/completions`
- `POST /v1/messages`

## 许可证

`ISC`