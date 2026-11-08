// 遗忘曲线 · 量具（measure）
//
// 只干三件事：读那两份文件、量字节、把它们切成「段」和「条目」。
//
// 为什么要切两刀：
//   · 段（section）= 报告里给人看的单位（`AGENTS.md` 现在正好 15 段，就是这个粒度）；
//   · 条目（item）  = 判档的单位 —— 一条记忆一条命。
//   段只用来分组；会不会被删、被压，全看条目。
//
// 为什么段要按 `##`/`###` 切：这两份文件的作者一行行在维护它，标题就是他自己划的边界。
// 按标题切，改动永远落在他看得懂的格里；按字节硬切，会把一句话劈成两半。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 注入预算：DSH 的硬上限，超了不是截断，是整份被丢出去。 */
export const BUDGET_BYTES = 65536

/** 85% 触底线：65536 × 0.85 = 55705.6 → 55,705 B（和本人定的那个数一致）。 */
export const ALERT_BYTES = 55705

/** 它只管这两份 —— `_handover\` / `_memory\` 一根手指都不碰。 */
export const SOURCE_FILES = ['AGENTS.md', 'AGENTS.local.md']

/** UTF-8 字节数（不是字符数：中文一个字 3 字节，按字数算会少算一半）。 */
export function byteLength(text = '') {
  return Buffer.byteLength(String(text), 'utf8')
}

/** 占比：保留一位小数。 */
export function pct(bytes) {
  return Math.round((bytes / BUDGET_BYTES) * 1000) / 10
}

/** 中文显示宽度 = 2 列；报告要靠它对齐。 */
export function strWidth(text) {
  let w = 0
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0)
    w += (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6))) ? 2 : 1
  }
  return w
}

/** 按显示宽度右补空格（中文两列，用它才不歪）。 */
export function padEndWidth(text, width) {
  const s = String(text)
  return s + ' '.repeat(Math.max(0, width - strWidth(s)))
}

/** 读源文件；缺了就记下来，不抛 —— 少一份也能出报告。 */
export function readSources(root) {
  const files = []
  const missing = []
  for (const name of SOURCE_FILES) {
    const path = join(root, name)
    try {
      const text = readFileSync(path, 'utf8')
      files.push({ name, path, text, bytes: byteLength(text) })
    } catch (error) {
      missing.push({ name, path, error: error && error.message ? error.message : String(error) })
    }
  }
  const total = files.reduce((sum, f) => sum + f.bytes, 0)
  return {
    root,
    files,
    missing,
    total,
    pct: pct(total),
    alert: total >= ALERT_BYTES,
    headroom: BUDGET_BYTES - total,
  }
}

const HEADING_RE = /^(#{1,3})\s+(.*)$/

/**
 * 切段：一张 h1/h2/h3 标题就是一段（正文前的开场白单算一段，level 0）。
 * 返回的 `text` 含标题行本身 —— 字节要算真的，标题也在占预算。
 */
export function splitSections(text) {
  const lines = String(text).split(/\r?\n/)
  const heads = []
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i])
    if (m) heads.push({ line: i, level: m[1].length, title: m[2].trim() })
  }
  const bounds = []
  if (!heads.length || heads[0].line > 0) {
    bounds.push({ line: 0, level: 0, title: '（前言）' })
  }
  for (const h of heads) bounds.push(h)
  const sections = []
  for (let i = 0; i < bounds.length; i++) {
    const start = bounds[i].line
    const end = i + 1 < bounds.length ? bounds[i + 1].line : lines.length
    const slice = lines.slice(start, end).join('\n')
    if (!slice.trim()) continue
    sections.push({
      index: sections.length + 1,
      level: bounds[i].level,
      title: bounds[i].title || '（前言）',
      lineStart: start + 1,
      lineEnd: end,
      text: slice,
      bytes: byteLength(slice),
      body: level0Body(slice, bounds[i].level),
    })
  }
  return sections
}

/** 段正文（去掉标题行本身；level 0 的前言没有标题行可去）。 */
function level0Body(slice, level) {
  if (!level) return slice
  const nl = slice.indexOf('\n')
  return nl === -1 ? '' : slice.slice(nl + 1)
}

const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+/
const TABLE_RE = /^\s*\|/

/**
 * 切条目：段里一个列表项 / 一行表格 / 一个自然段 = 一个条目。
 *
 * 为什么列表项和表格行要单拆：那两份文件里最要紧的东西都是这么写的
 * （「- 别往 C 盘写」「| 65536 上限 | ★重 |」），一条是一件事，不能并成一个条目判。
 */
export function splitItems(section) {
  const body = section && section.body ? section.body : ''
  const bodyStart = section && section.lineStart ? section.lineStart + (section.level ? 1 : 0) - 1 : 0
  const lines = body.split(/\r?\n/)
  const items = []
  let buf = []
  let bufLine = 0
  const flush = () => {
    if (!buf.length) return
    const text = buf.join('\n').trim()
    if (text) items.push({ text, line: bufLine })
    buf = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) { flush(); continue }
    const isUnit = BULLET_RE.test(line) || TABLE_RE.test(line)
    if (isUnit) {
      flush()
      bufLine = bodyStart + i + 1
      buf = [line]
      continue
    }
    if (!buf.length) { bufLine = bodyStart + i + 1 }
    buf.push(line)
  }
  flush()
  return items.map((it) => ({
    ...it,
    section: section ? section.index : 0,
    sectionTitle: section ? section.title : '',
    bytes: byteLength(it.text),
    flat: it.text.replace(/\s+/g, ' ').trim(),
  }))
}

/** 两份文件里所有条目（带段信息）。 */
export function collectItems(sources) {
  const out = []
  for (const file of sources.files) {
    const sections = splitSections(file.text)
    for (const section of sections) {
      for (const item of splitItems(section)) {
        out.push({ ...item, file: file.name })
      }
    }
  }
  return out
}

/** 一个数在预算里的位置：给报告用。 */
export function budgetLine(total) {
  return `${total.toLocaleString('en-US')} B / ${BUDGET_BYTES.toLocaleString('en-US')}（${pct(total)}%）`
}

// ---------------------------------------------------------------------------
// 组块：从标题里的 `[B3]` 认块
// ---------------------------------------------------------------------------

const BLOCK_MARK_RE = /\[\s*(B\d)\s*\]/

/** 段标题里的块标：`## [B6] DSH 桌面版` → 'B6'；没打就 null（不许瞎猜）。 */
export function blockOf(section) {
  const m = BLOCK_MARK_RE.exec(String(section && section.title ? section.title : ''))
  return m ? m[1].toUpperCase() : null
}

/** 段标题去掉块标，剩下可读的名字。 */
export function stripMark(title) {
  return String(title || '').replace(BLOCK_MARK_RE, '').trim()
}

/**
 * 给段原地打块标（只对 `AGENTS.md` 用；`AGENTS.local.md` 是自动层，不拆块）。
 *
 * 规矩：**h3 没打块标时，跟最近一个打了块标的 h2 走。**
 * 为什么：`### 为什么会分成两个` 本来就是 `## [B1] 先分清你是哪一个渊` 的小节，
 * 不是独立一块。它自立门户之后，B1 少算 4.4 KB、B0 虚高，两块都不准。
 *
 * 只有 h3 这样继承 —— h2 没打标还是该进 B0，那是真的没分类。
 * 注意：h3 自己也打了标的（`### [B4] 两条已定的事`）不改变"母块"，
 * 它后面那些没打标的 h3 仍然跟最近的 h2 走。
 */
export function assignBlocks(sections) {
  let lastMarkedH2 = null
  for (const section of sections) {
    const own = blockOf(section)
    if (own) {
      section.block = own
      if (section.level <= 2) lastMarkedH2 = own
      continue
    }
    section.block = section.level >= 3 && lastMarkedH2 ? lastMarkedH2 : null
  }
  return sections
}

/**
 * 按块归并段（段上必须已经有 `.block`，见 `assignBlocks`）。
 *
 * 注意：**不跨标题偷块**。`[B6] DSH 桌面版` 那一段末尾有几条其实是"怎么装插件"（B7 的内容），
 * 插件不替它搬 —— 只在报告里标出来（`mixed`），因为"分错块的代价比判错轻重小"，但得让人看见。
 */
export function groupIntoBlocks(sections, blockMeta, unmarkedMeta) {
  const map = new Map()
  for (const section of sections) {
    const id = section.block || unmarkedMeta.id
    if (!map.has(id)) {
      const meta = blockMeta(id)
      map.set(id, { id, name: meta.name, quota: meta.quota, gist: meta.gist, bytes: 0, sections: [], mixed: [] })
    }
    const block = map.get(id)
    block.bytes += section.bytes
    block.sections.push(section)
  }
  return [...map.values()]
}

/** 真正"没打块标"的段：`AGENTS.md` 里 h2/h1 没标、且没有母块可跟的。 */
export function unmarkedSections(sections) {
  return sections.filter((s) => !s.block)
}
