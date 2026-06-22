# mock-ollama

把第三方大模型接口伪装成 `Ollama` 服务，方便本地插件或脚本继续按 `http://localhost:11434` 这一套接入。

当前主要用途：

- 代理 OpenAI/Anthropic 兼容聊天接口
- 暴露 Ollama 风格的 `api/version`、`api/tags`、`api/show`
- Web UI 实时监控请求日志、Token 分布、Cache 命中

## 安装

### 全局安装

```bash
npm install -g mock-ollama
mock-ollama -h
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
    "model": "glm-5",
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
- `--api-style`：上游 API 风格，支持 `auto`、`anthropic`、`openai`，默认 `auto`
- `--quiet`：安静模式，关闭详细日志
- `--open`：启动后自动打开浏览器
- `--max_context`：网页上下文上限（token），默认 `200000`

## 环境变量

- `MOCK_OLLAMA_BASE_URL`：上游服务地址
- `MOCK_OLLAMA_API_KEY`：上游服务密钥

示例：

```bash
export MOCK_OLLAMA_BASE_URL="https://open.bigmodel.cn/api/paas/v4"
export MOCK_OLLAMA_API_KEY="your-api-key"
mock-ollama
```

强制使用 Anthropic 兼容接口：

```bash
mock-ollama --url "https://api.example.com" --apikey "your-key" --api-style anthropic
```

## 路由接口

- `GET /`
- `GET /api/version`
- `GET /api/tags`
- `POST /api/show`
- `POST /chat/completions`
- `POST /v1/chat/completions`
- `POST /v1/messages`

## Web UI

启动后访问 `http://localhost:11434` 即可打开 Web 监控界面。

功能：

- **实时推送**：SSE 实时接收新请求，自动刷新列表
- **Token 分布条**：可视化展示 System/User/Assistant/Thinking/Response 等各部分占比
- **Cache 监控**：显示缓存命中情况，缓存下降时红色警告
- **友好视图**：解析请求/响应，展示关键信息
- **原始数据**：一键复制完整 JSON 数据
- **对比视图**：与上一条 POST 请求对比，Token 级别 LCS diff 高亮差异
- **提取差异**：一键提取变化的消息内容，复制到剪贴板

界面截图：

### 主界面

![主界面](docs/main_view.png)

### 详情面板

![详情面板](docs/detail_view.png)

### 对比视图

![对比视图](docs/diff_view.png)

## 许可证

`ISC`