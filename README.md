# dsh-plugins · 手机 ↔ 电脑 共用仓库

> 用途：**两边都能读写的中转站**。代码走 git，产物走 Release，留言走 `mailbox/`。

## 目录

```
plugins/          ← 插件源码（每个插件一个子目录）
packages/         ← 交接包 / 任务包（文档合集 + 小体积 zip）
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

## 包（交接包 / 任务包）怎么放

> 用户 2026-11-12 定的规矩：**以后这类包一律往上推，不再手动搬文件。**

| 体积 | 放哪 | 说明 |
|---|---|---|
| **文档包**（md 合集，<20 MB） | `packages/<名称>-<YYYYMMDD>/` | 直接 push 目录 |
| **小压缩包**（<20 MB） | `packages/<名称>-<YYYYMMDD>.zip` | 手机端用 python 打 zip（容器无 zip 命令） |
| **大包**（>20 MB） | **Release 附件** 或云盘 | 不进 git（单文件 100 MB 硬上限） |

**命名**：`插件编译交接-20261112`、`仓库使用说明-给电脑`（能一眼看出内容与日期）。

**手机端打 zip 的做法**（没有 `zip` 命令）：

```python
import zipfile, os
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
    for root,_,files in os.walk(src):
        for f in files: z.write(os.path.join(root,f))
```
