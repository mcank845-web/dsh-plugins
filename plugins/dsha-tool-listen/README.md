# dsha-tool-listen

给 DSHA 加一个 `listen` 工具：把音频转成文字（带时间戳/说话人），后端用 MiniMax ASR。

```
listen(path: "/sdcard/xxx.mp3", detail: "verbose")
```

- `detail: "text"`（默认）只给全文；`"verbose"` 给分段 + 时间戳 + 说话人
- 上限：≤500 秒、≤50 MB（服务端限制）
- API key 来源：环境变量 `MINIMAX_API_KEY` → `~/.minimax_key` → `/root/.minimax_key`
- 纯 JS，无原生依赖；手机与电脑通用
