/**
 * dsha-tool-docx — 给 agent 加一个 `docx_probe` 工具：
 * 探测 Word (.docx) 文件的真实结构（真假目录、页码域、正文/表格/图片数、字体字号与结构问题）。
 *
 * 纯 JS 实现：原生 Buffer + node:zlib 解析 ZIP 容器与 OpenXML，零原生依赖，零网络调用。
 */
import { readFile, stat } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsha-tool-docx'
export const inject = ['tools']

// --- 纯 JS ZIP 解压器（基于 EOCD + central directory） ---
function readZipEntries(buffer) {
  if (buffer.length < 22) {
    throw new Error('不是合法的 docx 文件（文件体积过小）')
  }

  // 1. 定位 End of Central Directory (EOCD): 0x06054b50
  let eocdOffset = -1
  const maxSearch = Math.min(buffer.length, 65535 + 22)
  for (let i = buffer.length - 22; i >= buffer.length - maxSearch; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }

  if (eocdOffset === -1) {
    throw new Error('不是合法的 docx 文件（未找到 ZIP 目录签名）')
  }

  const cdTotal = buffer.readUInt16LE(eocdOffset + 10)
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16)

  const entries = new Map()
  let curr = cdOffset

  for (let i = 0; i < cdTotal; i++) {
    if (curr + 46 > buffer.length) break
    const sig = buffer.readUInt32LE(curr)
    if (sig !== 0x02014b50) break

    const method = buffer.readUInt16LE(curr + 10)
    const compressedSize = buffer.readUInt32LE(curr + 20)
    const fileNameLen = buffer.readUInt16LE(curr + 28)
    const extraLen = buffer.readUInt16LE(curr + 30)
    const commentLen = buffer.readUInt16LE(curr + 32)
    const localHeaderOffset = buffer.readUInt32LE(curr + 42)

    const fileName = buffer.toString('utf8', curr + 46, curr + 46 + fileNameLen)
    curr += 46 + fileNameLen + extraLen + commentLen

    entries.set(fileName, { method, compressedSize, localHeaderOffset })
  }

  function readText(fileName) {
    const entry = entries.get(fileName)
    if (!entry) return null

    const lho = entry.localHeaderOffset
    if (lho + 30 > buffer.length) {
      throw new Error(`读取 ${fileName} 失败：文件损坏`)
    }
    const localSig = buffer.readUInt32LE(lho)
    if (localSig !== 0x04034b50) {
      throw new Error(`读取 ${fileName} 失败：Local Header 损坏`)
    }

    const localFnLen = buffer.readUInt16LE(lho + 26)
    const localExtraLen = buffer.readUInt16LE(lho + 28)
    const dataStart = lho + 30 + localFnLen + localExtraLen
    const dataEnd = dataStart + entry.compressedSize

    if (dataEnd > buffer.length) {
      throw new Error(`读取 ${fileName} 失败：数据段超出文件末尾`)
    }

    const compressedBuf = buffer.subarray(dataStart, dataEnd)
    let decompressed
    if (entry.method === 0) {
      decompressed = compressedBuf
    } else if (entry.method === 8) {
      decompressed = inflateRawSync(compressedBuf)
    } else {
      throw new Error(`不支持的压缩方式 (method=${entry.method})：${fileName}`)
    }

    return decompressed.toString('utf8')
  }

  return { entries, readText }
}

function parseDocx(buffer) {
  const zip = readZipEntries(buffer)

  // 校验关键条目
  if (!zip.entries.has('word/document.xml') && !zip.entries.has('[Content_Types].xml')) {
    throw new Error('不是合法的 docx 文件（缺少 word/document.xml 核心文档）')
  }

  const docXml = zip.readText('word/document.xml') || ''
  const stylesXml = zip.readText('word/styles.xml') || ''

  // 1. 结构与元素计数
  const paragraphMatches = docXml.match(/<w:p\b[^>]*>/g) || []
  const paragraphCount = paragraphMatches.length

  const tableMatches = docXml.match(/<w:tbl\b[^>]*>/g) || []
  const tableCount = tableMatches.length

  const blipMatches = docXml.match(/<a:blip\b[^>]*>/g) || []
  const vmlImgMatches = docXml.match(/<v:imagedata\b[^>]*>/g) || []
  const imageCount = blipMatches.length + vmlImgMatches.length

  // 2. 检查目录 (TOC 域) 与提取目录项
  const hasTocFldSimple = /<w:fldSimple[^>]*w:instr="[^"]*\bTOC\b[^"]*"[^>]*>/i.test(docXml)
  const hasTocInstrText = /<w:instrText\b[^>]*>\s*TOC\b/i.test(docXml)
  const hasTrueToc = hasTocFldSimple || hasTocInstrText

  const tocItems = extractTocItems(docXml)

  // 3. 页眉与页脚检查，以及 PAGE / NUMPAGES 域
  let hasHeader = false
  let hasFooter = false
  let hasPageField = false
  let hasNumPagesField = false

  for (const name of zip.entries.keys()) {
    if (/^word\/header\d+\.xml$/i.test(name)) {
      hasHeader = true
    } else if (/^word\/footer\d+\.xml$/i.test(name)) {
      hasFooter = true
      const footerXml = zip.readText(name) || ''
      if (/\bPAGE\b/.test(footerXml)) hasPageField = true
      if (/\bNUMPAGES\b/.test(footerXml)) hasNumPagesField = true
    }
  }

  // 4. 字体与正文字号提取 (styles.xml)
  let chineseFont = '未指定'
  let bodyFontSize = '未指定'

  if (stylesXml) {
    const rPrMatch = stylesXml.match(/<w:docDefaults>[\s\S]*?<w:rPrDefault>[\s\S]*?<w:rPr>([\s\S]*?)<\/w:rPr>/)
    const defaultRPr = rPrMatch ? rPrMatch[1] : ''

    const rFontsMatch = defaultRPr.match(/<w:rFonts\b([^>]*)\/>/) || stylesXml.match(/<w:style\b[^>]*w:styleId="Normal"[\s\S]*?<w:rFonts\b([^>]*)\/>/)
    if (rFontsMatch) {
      const attrs = rFontsMatch[1]
      const eastAsiaMatch = attrs.match(/w:eastAsia="([^"]+)"/)
      const asciiMatch = attrs.match(/w:ascii="([^"]+)"/)
      if (eastAsiaMatch) {
        chineseFont = eastAsiaMatch[1]
      } else if (asciiMatch) {
        chineseFont = asciiMatch[1]
      }
    }

    const szMatch = defaultRPr.match(/<w:sz\b[^>]*w:val="(\d+)"[^>]*\/>/) || stylesXml.match(/<w:style\b[^>]*w:styleId="Normal"[\s\S]*?<w:sz\b[^>]*w:val="(\d+)"[^>]*\/>/)
    if (szMatch) {
      const halfPt = parseInt(szMatch[1], 10)
      const pt = halfPt / 2
      let ptName = ''
      if (halfPt === 21) ptName = ' (五号)'
      else if (halfPt === 24) ptName = ' (小四)'
      else if (halfPt === 28) ptName = ' (四号)'
      else if (halfPt === 32) ptName = ' (三号)'
      bodyFontSize = `${pt} pt${ptName}`
    }
  }

  // 5. 结构性问题检查
  const structuralIssues = []
  if (hasTrueToc && !hasPageField) {
    structuralIssues.push('文档包含真目录域，但页脚中未检测到 PAGE 页码域')
  }
  if (hasHeader && paragraphCount === 0) {
    structuralIssues.push('文档存在页眉，但正文未包含任何段落')
  }
  if (!hasTrueToc && tocItems.length > 0) {
    structuralIssues.push('检测到类似目录样式的段落，但未发现标准 TOC 域（可能为伪静态目录）')
  }
  if (paragraphCount > 50 && !hasFooter) {
    structuralIssues.push('长篇文档（>50段落）未设置页脚')
  }

  return {
    hasTrueToc,
    hasHeader,
    hasFooter,
    hasPageField,
    hasNumPagesField,
    paragraphCount,
    tableCount,
    imageCount,
    chineseFont,
    bodyFontSize,
    tocItems,
    structuralIssues,
  }
}


/**
 * 从 document.xml 提取目录条目。
 * 优先：定位 TOC 域的 instrText → separate → 按 begin/end 深度收集域结果段落；
 * 兜底：解析带 TOC1~TOC9 样式的段落。
 */
function extractTocItems(docXml) {
  const items = []

  // ---- 路径 A：域结果（fldChar begin … separate … [结果段落] … end）----
  const instrRe = /<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/g
  let m
  let tocInstrEnd = -1
  while ((m = instrRe.exec(docXml)) !== null) {
    if (/\bTOC\b/.test(m[1])) {
      tocInstrEnd = m.index + m[0].length
      break
    }
  }

  if (tocInstrEnd !== -1) {
    const sepIdx = docXml.indexOf('w:fldCharType="separate"', tocInstrEnd)
    if (sepIdx !== -1) {
      const bodyStart = docXml.indexOf('>', sepIdx) + 1
      const pRe = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
      pRe.lastIndex = bodyStart
      let depth = 1
      let pm
      while ((pm = pRe.exec(docXml)) !== null) {
        const chunk = pm[0]
        const begins = (chunk.match(/w:fldCharType="begin"/g) || []).length
        const ends = (chunk.match(/w:fldCharType="end"/g) || []).length
        const text = (chunk.match(/<w:t\b[^>]*>([^<]*)<\/w:t>/g) || [])
          .map((x) => x.replace(/<[^>]*>/g, ''))
          .join('')
          .trim()
        if (text) items.push(formatTocItem(text))
        depth += begins - ends
        if (depth <= 0) break
        if (items.length >= 20) break
      }
      if (items.length > 0) return items
    }
  }

  // ---- 路径 B：TOC1~TOC9 样式段落 ----
  const pRe2 = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g
  let pm2
  while ((pm2 = pRe2.exec(docXml)) !== null) {
    const chunk = pm2[1]
    if (!/<w:pStyle\b[^>]*w:val="TOC[1-9]"/i.test(chunk)) continue
    const text = (chunk.match(/<w:t\b[^>]*>([^<]*)<\/w:t>/g) || [])
      .map((x) => x.replace(/<[^>]*>/g, ''))
      .join('')
      .trim()
    if (text) items.push(formatTocItem(text))
    if (items.length >= 20) break
  }
  return items
}


/** 目录条目「标题+页码」之间补分隔（域结果里 tab 不是文本，会粘在一起） */
function formatTocItem(text) {
  const m = /^(.+?)(\d{1,3})$/.exec(text)
  if (m && m[1] && !/\d$/.test(m[1])) return `${m[1]} …… ${m[2]}`
  return text
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'docx_probe',
    description: '探测 Word (.docx) 文件的内部真实结构，包括真假目录域、页眉页脚、页码域、段落/表格/图片数、中文字体字号及常见排版结构问题。',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: '待探测的 docx 文件绝对路径。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          hasTrueToc: { type: 'boolean', required: true },
          hasHeader: { type: 'boolean', required: true },
          hasFooter: { type: 'boolean', required: true },
          hasPageField: { type: 'boolean', required: true },
          hasNumPagesField: { type: 'boolean', required: true },
          paragraphCount: { type: 'number', required: true },
          tableCount: { type: 'number', required: true },
          imageCount: { type: 'number', required: true },
          chineseFont: { type: 'string', required: true },
          bodyFontSize: { type: 'string', required: true },
          tocItems: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
          structuralIssues: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
        },
      },
      render(_args, value) {
        const tocInfo = value.hasTrueToc
          ? `存在真目录 (TOC 域)`
          : `无真目录域`
        const pageInfo = `页眉: ${value.hasHeader ? '有' : '无'} | 页脚: ${value.hasFooter ? '有' : '无'} | 页码域(PAGE): ${value.hasPageField ? '有' : '无'} | 总页数域(NUMPAGES): ${value.hasNumPagesField ? '有' : '无'}`
        const counts = `段落数: ${value.paragraphCount} | 表格数: ${value.tableCount} | 图片数: ${value.imageCount}`
        const styleInfo = `中文字体: ${value.chineseFont} | 正文字号: ${value.bodyFontSize}`

        const lines = [
          `文件: ${value.path}`,
          `[目录探测] ${tocInfo}`,
          `[页眉页脚] ${pageInfo}`,
          `[元素统计] ${counts}`,
          `[默认样式] ${styleInfo}`,
        ]

        if (value.tocItems.length > 0) {
          lines.push(`[目录项预览 (前 ${value.tocItems.length} 条)]`)
          value.tocItems.forEach((item, idx) => {
            lines.push(`  ${idx + 1}. ${item}`)
          })
        }

        if (value.structuralIssues.length > 0) {
          lines.push(`[⚠️ 结构问题提醒]`)
          value.structuralIssues.forEach((issue) => {
            lines.push(`  - ${issue}`)
          })
        } else {
          lines.push(`[结构问题提醒] 未发现明显排版结构问题`)
        }

        return [{
          type: 'text',
          text: lines.join('\n'),
        }]
      },
    },
    async execute({ path }) {
      // 1. 路径与存在性校验
      let st
      try {
        st = await stat(path)
      } catch (e) {
        throw new Error(`路径不存在或无法访问：${path}`)
      }

      if (!st.isFile()) {
        throw new Error(`指定路径不是文件：${path}`)
      }

      // 2. 读取并探测
      let buf
      try {
        buf = await readFile(path)
      } catch (e) {
        throw new Error(`读取文件失败：${e.message}`)
      }

      const result = parseDocx(buf)
      return {
        path,
        ...result,
      }
    },
  }))
}
