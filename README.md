# cc-translate

在 Claude Code 右侧开一个翻译侧栏：Claude 的英文输出自动翻译成中文；你在侧栏输入中文，翻译成英文后**以你本人的身份**发送（`asUser`），和你在主输入框敲回车没有区别。

翻译请求只发往你配置的端点（任意 Anthropic-messages 或 OpenAI 兼容网关），**不经过也不消耗当前会话的 Claude 订阅**。mod 只使用 `$.http.fetch`，从不调用 `$.model.complete`。

## 安装

从 GitHub 直接安装：

```text
/plugin install cc-translate --marketplace byyuchun/cc-translate
```

或本地开发时：

```bash
claude --plugin-dir ~/dev/cc-translate
```

默认**不会**自动开启：运行

```text
/zh
```

才会打开侧栏（任意宽度都会落座）并开始翻译，此前的历史不会补翻。`/zh-close` 或点侧栏的关闭标记会关掉侧栏并停止翻译（包括主输入框的中文自动翻译）。想每个会话一开始就翻译，把插件配置 `auto_open`（或配置文件里的 `"auto_open": true`）设为 true。

## 配置

两种方式任选，`userConfig` 优先，缺的字段由配置文件补：

1. 插件配置（`base_url` / `token` / `model` / `protocol` / `auth`），`token` 存系统钥匙串。
2. `~/.claude/cc-translate.json`：

```json
{
  "base_url": "https://your-endpoint.example.com",
  "token": "YOUR-TOKEN",
  "model": "your-model",
  "protocol": "anthropic",
  "auth": "bearer"
}
```

- `protocol`: `anthropic`（`POST {base}/v1/messages`）或 `openai`（`POST {base}/chat/completions`）
- `auth`: `bearer`（`ANTHROPIC_AUTH_TOKEN` 风格）或 `x-api-key`
- `fallback_model`（可选）：主模型失败时重试一次用的模型；建议选一个不带推理的快速模型
- 任何兼容这两种协议的网关都可以，包括官方 API、DeepSeek、OpenRouter、自建代理
- 改完文件后运行 `/zh-config` 重新读取（不显示 token）
- 运行 `/zh-test` 用一句话实际验证端点是否可用
- 默认**不**复用会话自身的 `ANTHROPIC_*` 环境变量，避免翻译流量落到当前会话的 provider；确实想复用时把 `use_session_env` 设为 true

## 使用

| 操作 | 效果 |
| --- | --- |
| 侧栏输入框里打中文，回车 | 翻译成英文并直接发送 |
| `翻译并发送` 按钮 | 同上 |
| `翻译并填草稿` 按钮 | 只把英文填进主输入框，你自己回车 |
| 主输入框里打中文 | 自动翻译成英文后发送（可用配置项 `auto_input` 关闭） |
| `/zh` / `/zh-close` | 打开侧栏并开始翻译 / 关闭侧栏并停止翻译 |
| `/zh-config` | 查看端点、模型、协议（token 只显示是否已设置） |
| `/zh-test` | 调一次端点，验证翻译链路是否通 |
| `/zh-retry` | 重新排队所有翻译失败的条目 |
| `重试失败项` | 侧栏里出现失败条目时的按钮，等同 `/zh-retry` |
| `/zh-clear` | 清空侧栏历史 |
| `暂停` / `继续` | 暂停自动翻译（历史仍会记录） |
| `显示原文` / `隐藏原文` | 译文下方是否附带英文原文摘要 |

Claude 的回复边生成边翻译：每写完一段（约 300 字符以上、在段落空行处、不切代码块）就排队翻译，不必等整轮结束。Claude 弹出选项让你选择时（AskUserQuestion），对话框先以英文出现，译文到达后原地换成中文。

工具调用在侧栏以中文动词 + 未翻译的命令/路径显示（例如「执行命令 · ls -la」），代码、命令、路径永远不被改写。

## 超时与重试

`$.http.fetch` 由引擎在 **30 秒**处截断，这个上限不可配置。mod 因此：

- 每段最多约 2000 字符，长回复自动分段；
- 每段失败后重试一次：配置了 `fallback_model` 就用它，否则用主模型再试；
- 仍然失败时，在段落空白处（不在代码块内）对半拆开再各试一次；
- 单条仍失败则标记 `翻译失败`，可以用 `重试失败项` / `/zh-retry` 重新排队。

经验上，带推理的模型（如 DeepSeek 的 v4.1 flash）一段 4000 字符可能要 15 秒以上且波动大；同端点上的非推理 flash 模型（如 GLM 5.3 flash）通常 2–6 秒。把 `fallback_model` 设为后者能显著降低超时率。

## 行为细节

- **翻译时机**：每个回合结束后一次性翻译，避免流式过程中重复翻译同一条消息。
- **代码保护**：提示词强制保留代码围栏、行内代码、路径、命令、标识符、URL 和数字。
- **失败降级**：翻译失败时**一律不发送**。侧栏发送失败会把中文放回侧栏输入框；主输入框翻译失败会拒绝这条 prompt、把中文放回主输入框，并显示原因。只有把 `send_original_on_failure` 设为 true，才会退回「按原文发送」。
- **AskUserQuestion**：对话框里的问题与选项也会被翻译成中文（失败时保持引擎原文）。
- **不做的事**：不翻译工具输出正文、不翻译系统提示、不改变会话模型。

## 开发

```bash
claude plugin validate .
claude plugin test .
```

## 隐私

- 侧栏内容与待翻译文本会发送到你配置的端点，不会发送到 Anthropic。
- 最终发送给 Claude 的英文 prompt 本身仍是一次正常对话（这是它的用途，不是额外流量）。
- mod 运行在你的权限下：它能读到会话内容和本机文件，请只安装你信任的代码。
