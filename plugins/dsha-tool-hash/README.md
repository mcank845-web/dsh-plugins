# dsha-tool-hash

给 DSHA 加一个 `hash` 工具：算文件的 MD5 / SHA1 / SHA256（流式读取，大文件安全）。

```
hash(path: "/sdcard/Download/x.zip", algorithm: "sha256")   # 默认 sha256
hash(path: "...", algorithm: "all")                         # 三种都算
```

用途：下载/传输后校验完整性；比"看起来没坏"可靠。

- 纯 JS，无原生依赖（PC 与手机通用）
- 安装：profile `package.json` 加依赖 `link:` 或 `github:`，并把 `dsha-tool-hash` 加进 `dsh.profile.bundles`
