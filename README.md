# dsh-plugins · 手机 ↔ 电脑 共用仓库

> 用途：**两边都能读写的中转站**。代码走 git，产物走 Release，留言走 `mailbox/`。

## 目录

```
plugins/          ← 插件源码（每个插件一个子目录）
mailbox/          ← 留言：来件.md（电脑→手机）、回件.md（手机→电脑）
```

## 规矩

1. **只放代码、脚本、文档**；大文件（视频/音频/几个 G 的包）走云盘，别进 git；
2. 构建产物（zip、`.node`）**放 Release**，不要提交进仓库；
3. 提交前跑一遍 `node --input-type=module -e "import('./lib/index.js')"` 自检；
4. 谁改了什么，commit message 写清楚。

## 现有插件

| 插件 | 作用 | 类型 |
|---|---|---|
| `dsha-tool-hash` | `hash` 工具：算 MD5/SHA1/SHA256 | 纯 JS |
| `dsha-tool-listen` | `listen` 工具：音频转文字（MiniMax ASR） | 纯 JS |

## 手机端安装（供参考）

```bash
ln -sfn /root/<插件目录> /root/.dsh/profiles/web/node_modules/<包名>
# profile/package.json: dependencies + dsh.profile.bundles
# 然后重启 Web
```
