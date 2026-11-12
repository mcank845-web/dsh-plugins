/**
 * dsha-tool-listen — 给 agent 加一个 `listen` 工具：把音频转成文字（带时间戳/说话人）。
 * 后端：MiniMax ASR（asr-1.0），key 读 /root/.minimax_key。
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsha-tool-listen'
export const inject = ['tools']

const KEY_ENV = 'MINIMAX_API_KEY'
const KEY_FILES = [join(homedir(), '.minimax_key'), '/root/.minimax_key']
const API = 'https://api.minimax.cn/v1/speech_to_text'
const MAX_MB = 50

const MIME = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.aiff': 'audio/aiff',
  '.alac': 'audio/mp4',
}

async function apiKey() {
  const fromEnv = (process.env[KEY_ENV] || '').trim()
  if (fromEnv) return fromEnv
  const errs = []
  for (const p of KEY_FILES) {
    try { return (await readFile(p, 'utf8')).trim() } catch (e) { errs.push(`${p}(${e.code || e.message})`) }
  }
  throw new Error(`读不到 API key：先设环境变量 ${KEY_ENV}，或放到 ${KEY_FILES[0]}。已试：${errs.join(' / ')}`)
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'listen',
    description: '把音频文件转成文字（带时间戳与说话人）。用于“听懂”录音、语音、视频音轨；≤500 秒、≤50MB。',
    parameters: {
      path: { type: 'string', required: true, description: '音频文件绝对路径（支持 wav/mp3/m4a/flac/aac/opus/ogg）' },
      detail: { type: 'string', enum: ['text', 'verbose'], description: '默认 text（只给全文）；verbose 给分段+时间戳+说话人' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          duration: { type: 'number', required: true },
          segments: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                start: { type: 'number', required: true },
                end: { type: 'number', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          speakers: { type: 'number', required: true },
        },
      },
      render(_a, v) {
        const bits = [`时长 ${v.duration.toFixed(1)}s`]
        if (v.segments.length) bits.push(`${v.segments.length} 段`)
        if (v.speakers > 0) bits.push(`说话人 ${v.speakers}`)
        const head = bits.join('｜')
        if (!v.segments.length) return [{ type: 'text', text: `${head}\n\n${v.text}` }]
        const body = v.segments.slice(0, 40).map((s) =>
          `[${s.start.toFixed(1)}–${s.end.toFixed(1)}] ${s.text}`).join('\n')
        return [{ type: 'text', text: `${head}\n\n${body}` }]
      },
    },
    async execute(args) {
      const st = await stat(args.path).catch((e) => {
        throw new Error(`无法访问 ${args.path}（${e.code || e.message}）`)
      })
      if (!st.isFile()) throw new Error(`${args.path} 不是普通文件`)
      const key = await apiKey()
      if (st.size > MAX_MB * 1024 * 1024) throw new Error(`文件 ${(st.size/1048576).toFixed(1)} MB，超过 ${MAX_MB} MB 上限`)

      const buf = await readFile(args.path)
      const form = new FormData()
      form.append('model', 'asr-1.0')
      form.append('response_format', args.detail === 'verbose' ? 'verbose_json' : 'json')
      const mime = MIME[extname(args.path).toLowerCase()] || 'application/octet-stream'
      form.append('file', new Blob([buf], { type: mime }), basename(args.path))

      const res = await fetch(API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(300000),
      })
      const raw = await res.text()
      if (!res.ok) throw new Error(`ASR ${res.status}: ${raw.slice(0, 300)}`)

      let data
      try { data = JSON.parse(raw) } catch { throw new Error(`返回不是 JSON：${raw.slice(0, 200)}`) }
      const br = data && data.base_resp
      if (br && Number(br.status_code) !== 0) {
        throw new Error(`ASR 业务错误：${br.status_code} ${br.status_msg || ''}`.trim())
      }
      const segs = (data.segments || []).map((s) => ({
        start: Number(s.start ?? s.start_time ?? 0),
        end: Number(s.end ?? s.end_time ?? 0),
        text: String(s.text ?? '').trim(),
      })).filter((s) => s.text)

      return {
        text: String(data.text || '').trim(),
        duration: Number(data.duration || 0),
        segments: segs,
        speakers: Number(data.n_speakers ?? data.speakers ?? 0),
      }
    },
  }))
}
