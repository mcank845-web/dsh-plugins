/**
 * dsha-tool-hash — 给 agent 加一个 `hash` 工具：算文件的 MD5/SHA1/SHA256。
 *
 * 用途：下载或传输完文件后校验完整性（比"看起来没坏"可靠）。
 * 流式读取，不会把大文件读进内存。
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsha-tool-hash'
export const inject = ['tools']

const ALL_ALGOS = ['md5', 'sha1', 'sha256']

/** 流式计算若干算法；返回字节数与 [{algorithm, digest}] */
function digestFile(path, algos) {
  return new Promise((resolve, reject) => {
    const hashes = algos.map((a) => [a, createHash(a)])
    let bytes = 0
    const rs = createReadStream(path)
    rs.on('data', (chunk) => {
      bytes += chunk.length
      for (const [, h] of hashes) h.update(chunk)
    })
    rs.on('error', reject)
    rs.on('end', () => resolve({
      bytes,
      digests: hashes.map(([a, h]) => ({ algorithm: a, digest: h.digest('hex') })),
    }))
  })
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'hash',
    description: '计算本地文件的摘要（默认 sha256），用于校验下载或传输后的文件完整性。流式读取，大文件也安全。',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: '文件的绝对路径。⚠️ 相对路径按进程 cwd 解析（不是会话工作区），请一律传绝对路径。',
      },
      algorithm: {
        type: 'string',
        enum: ['md5', 'sha1', 'sha256', 'all'],
        description: '默认 sha256；all = 三种都算',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
          seconds: { type: 'number', required: true },
          digests: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                algorithm: { type: 'string', required: true },
                digest: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render(_args, value) {
        const lines = value.digests.map((d) => `${d.algorithm}: ${d.digest}`)
        const mb = (value.bytes / 1048576).toFixed(1)
        return [{
          type: 'text',
          text: `${value.path}\n${mb} MB, ${value.seconds.toFixed(2)}s\n${lines.join('\n')}`,
        }]
      },
    },
    async execute(args) {
      const algos = !args.algorithm || args.algorithm === 'sha256'
        ? ['sha256']
        : args.algorithm === 'all' ? ALL_ALGOS : [args.algorithm]

      const st = await stat(args.path).catch((e) => {
        throw new Error(`无法访问 ${args.path}: ${e.code || e.message}`)
      })
      if (!st.isFile()) throw new Error(`${args.path} 不是普通文件（目录/设备/FIFO 都不行）`)

      const t0 = Date.now()
      const { bytes, digests } = await digestFile(args.path, algos)
      return { path: args.path, bytes, seconds: (Date.now() - t0) / 1000, digests }
    },
  }))
}
