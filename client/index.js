// 遗忘曲线 · 客户端半边（Web 面板 · 第二版：接真数据）
//
// 一、数据从哪来（2026-11-07 查到的，不是猜的）
//     宿主 index.js 注册了两条 webServer 路由（Host Service `webServer`）：
//       GET  /dsh-forgetting-curve/snapshot   ← 纯只读快照，不接受任何参数
//       POST /dsh-forgetting-curve/action     ← { op: 'scan' | 'report' | 'backup' }
//     同一个 origin，所以这里直接相对路径 fetch —— 不需要端口、不需要 CORS、不需要凭证。
//
//     为什么不用 slot props：查过 `settings.section` 的用法（dsh-nekowhale-stickers 是这个
//     slot 的真实住户），这个 slot 给面板的 props 是注册时 `inject: () => face` 传进去的那份
//     settingsScope 面板（useScope / useDescribe / mutate / unset / rehydrate），
//     **它只通向"本插件自己的设置项"，没有通往任意宿主数据的口子**。所以数据走路由。
//
// 二、规矩（上一版崩过一次，这几条别再踩）
//     · id 必须严格等于包名 `dsh-forgetting-curve`，否则 __DSH_BOOT__ 的模块表配不上；
//     · 本文件按普通 <script> 执行，不能出现 import / export；
//     · 不往 document.body 追加节点、不替换 app 根、不读别的插件的 DOM；
//     · 定时器只活在组件里（useEffect + clearInterval），卸载就停；
//     · 资源只在 apply 里注册，组件卸载由 React 自己收拾。
//
// 三、这一版面板里没有写死的数
//     九块的名字 / 额度 / 用量 / 差 / 三二一 / 折删 全部来自快照；
//     读不到就明说"读不到"并给回退办法，**不拿"—"假装有数**。

window.__ModuleLoader__.load({
  id: 'dsh-forgetting-curve',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // ── 路由（跟宿主 index.js 的常量一一对应）──────────────────────────────
    const SNAPSHOT_URL = '/dsh-forgetting-curve/snapshot'
    const ACTION_URL = '/dsh-forgetting-curve/action'
    // 60 秒轮询一次：定时器最长 6 小时才跑一轮，轮询再好也快不过它；
    // 这里只是让"另一个人刚跑过报告"能自己出现，不用手点。
    const POLL_MS = 60 * 1000

    // ── 样式（只用主题 token，取不到就退回中性灰；不写死深色/浅色）──────────
    const T = {
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
      border: 'var(--dsw-alias-border-weak, rgba(128, 128, 128, 0.35))',
      panel: 'var(--dsw-alias-bg-elevated, rgba(128, 128, 128, 0.10))',
      danger: 'var(--dsw-alias-text-danger, #e5534b)',
      ok: 'var(--dsw-alias-text-success, #3fb950)',
    }

    const nf = (n) => {
      const v = Number(n)
      if (!Number.isFinite(v)) return '0'
      return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    const cell = { padding: '2px 0', fontSize: 12, lineHeight: '18px' }
    const num = { ...cell, fontFamily: T.mono, textAlign: 'right', width: '72px', flex: '0 0 auto' }
    const rowStyle = {
      display: 'flex', alignItems: 'baseline', gap: '8px',
      padding: '3px 6px', borderBottom: `1px solid ${T.border}`,
    }

    const btnStyle = {
      font: 'inherit', fontSize: 12, lineHeight: '20px',
      padding: '3px 10px', borderRadius: 6, cursor: 'pointer',
      color: 'inherit', background: 'transparent',
      border: `1px solid ${T.border}`,
    }

    /** ISO → 本地 `YYYY-MM-DD HH:mm`。没有就明说没有，不留 "—" 糊过去。 */
    function fmtTime(iso) {
      if (!iso) return '从没跑过'
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return String(iso)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    // ── 一行块 ────────────────────────────────────────────────────────────
    function BlockRow(props) {
      // over 由宿主算好（超出容差才算超）。没有这个字段时退回老规矩：diff > 0 就算超。
      const over = props.overLimit == null ? Number(props.over) > 0 : props.overLimit === true
      // 容差内的小超：不是"超"，是"波动"，灰着显示，别标红。
      const inTolerance = !over && Number(props.diff) > 0
      const tiers = props.tiers || {}
      return h('div', { style: rowStyle },
        h('span', { style: { ...cell, width: '3.2em', flex: '0 0 auto', opacity: 0.6, fontFamily: T.mono } }, props.id),
        h('span', { style: { ...cell, flex: '1 1 auto', color: over ? T.danger : 'inherit', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.name),
        h('span', { style: num }, nf(props.bytes)),
        h('span', { style: { ...num, opacity: 0.75 } }, props.quota > 0 ? nf(props.quota) : '无额度'),
        h('span', {
          style: { ...num, color: over ? T.danger : 'inherit', opacity: over ? 1 : inTolerance ? 0.6 : 0.75 },
        }, props.diff === null
          ? '无可减'
          : over
            ? `超 ${nf(props.diff)}`
            : inTolerance ? `波动 +${nf(props.diff)}` : `余 ${nf(-props.diff)}`),
        h('span', { style: { ...num, width: '62px', opacity: 0.75 } },
          `${tiers[3] || 0}/${tiers[2] || 0}/${tiers[1] || 0}`),
        h('span', { style: { ...num, width: '52px', opacity: 0.75 } },
          `${props.fold || 0}/${props.remove || 0}`),
      )
    }

    // ── 面板 ──────────────────────────────────────────────────────────────
    function Panel() {
      const [snap, setSnap] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [lines, setLines] = React.useState([])
      // 切「自动模式」要二次确认 —— 但不用 window.confirm：
      // Electron 的渲染进程里它不弹窗、直接返回 false（2026-11-08 实测，点了没反应）。
      // 改成"点一下先变成'再点一次确认'，3 秒内有效"。
      const [armed, setArmed] = React.useState(false)
      // 「给选项去删减和更改」：候选清单 + 勾选（2026-11-08 他提的第二件事）。
      const [preview, setPreview] = React.useState(null)   // { kind: 'fold'|'remove', items: [] }
      const [picked, setPicked] = React.useState({})       // { 序号: true }
      // 折叠必须由人写一句"留成什么"（机器写出来是占位符）—— 所以每条一个摘要框。
      const [summaries, setSummaries] = React.useState({})  // { 序号: '他写的那句' }

      const push = React.useCallback((text) => {
        const t = new Date()
        const pad = (n) => String(n).padStart(2, '0')
        const stamp = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`
        setLines((prev) => prev.concat(`[${stamp}] ${text}`).slice(-40))
      }, [])

      /** 拉一次快照。why 非空 = 是用户主动点的，要回一句话。 */
      const load = React.useCallback(async (why) => {
        try {
          const res = await fetch(SNAPSHOT_URL, { cache: 'no-store', headers: { Accept: 'application/json' } })
          if (!res.ok) {
            let detail = ''
            try {
              const j = await res.json()
              detail = (j && (j.error || j.message)) || ''
            } catch { /* 不是 JSON 就别硬解 */ }
            throw new Error(`HTTP ${res.status}${detail ? ` · ${detail}` : ''}`)
          }
          const data = await res.json()
          if (!data || typeof data.totalBytes !== 'number') throw new Error('返回的不是快照（缺 totalBytes）')
          setSnap(data)
          setErr('')
          if (why) push(`${why}：${nf(data.totalBytes)} / ${nf(data.limitBytes)} B（${(Number(data.ratio) * 100).toFixed(1)}%）`)
          return data
        } catch (e) {
          const msg = e && e.message ? e.message : String(e)
          setErr(msg)
          if (why) push(`${why}失败：${msg}`)
          return null
        }
      }, [push])

      React.useEffect(() => {
        load('')
        const iv = setInterval(() => { load('') }, POLL_MS)
        return () => clearInterval(iv) // 卸载就停：不留后台轮询
      }, [load])

      /** 按钮唯一的路。op 只能落进宿主白名单（scan / report / backup / setMode）。 */
      const act = React.useCallback(async (op, label, extra) => {
        setBusy(op)
        push(`${label}…`)
        try {
          const res = await fetch(ACTION_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ op, ...(extra || {}) }),
          })
          let data = null
          try { data = await res.json() } catch { /* 非 JSON = 走下面的失败分支 */ }
          if (data && data.snapshot) {
            setSnap(data.snapshot)
            setErr('')
          }
          if (res.ok && data && data.ok) push(`${label}完成：${data.message || 'ok'}`)
          else push(`${label}失败：${(data && (data.error || data.message)) || `HTTP ${res.status}`}`)
        } catch (e) {
          push(`${label}失败：${e && e.message ? e.message : '网络错误'}`)
        } finally {
          setBusy('')
        }
      }, [push])

      const hot = Boolean(snap && snap.alert)
      const headline = hot ? T.danger : 'inherit'
      const suggestion = (snap && snap.suggestions) || {}
      const blocks = (snap && Array.isArray(snap.blocks)) ? snap.blocks : []
      const quotaTotal = blocks.reduce((n, b) => n + (Number(b.quota) || 0), 0)

      // 模式切换（2026-11-08 他提的：只读提案模式少一个可选选项）。
      // 切到自动要二次确认（不用 window.confirm —— Electron 里它不弹窗）。
      // 这个版本不会改信，但"它会自己动手"这件事值得让人按住一次。
      const isAuto = Boolean(snap && snap.mode === 'auto')
      const toggleMode = React.useCallback(() => {
        if (isAuto) {
          setArmed(false)
          act('setMode', '切回提案模式', { mode: 'proposal' })
          return
        }
        if (!armed) {
          setArmed(true)
          push('再点一次，切到自动模式（3 秒内有效）。它只自动备份 + 出报告，不改 AGENTS.md。')
          setTimeout(() => setArmed(false), 3000)
          return
        }
        setArmed(false)
        act('setMode', '切到自动模式', { mode: 'auto' })
      }, [isAuto, armed, act, push])

      /**
       * 读候选明细（2026-11-08 他提的：「光有统计，没给选项去删减和更改」）。
       * 只读 —— 宿主那边 op=items 只跑 analyze()，一个字节都不写盘。
       */
      const loadItems = React.useCallback(function (kind) {
        setBusy('items')
        push(kind === 'fold' ? '读折叠候选…' : '读删除候选…')
        fetch(ACTION_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: 'items', kind }),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            if (d && d.ok) {
              setPreview({ kind: kind, items: d.items || [] })
              setPicked({})
              push((kind === 'fold' ? '折叠候选 ' : '删除候选 ') + (d.total || 0) + ' 条')
            } else {
              push('读候选失败：' + ((d && (d.error || d.message)) || '未知'))
            }
          })
          .catch(function (e) { push('读候选失败：' + (e && e.message ? e.message : '网络错误')) })
          .then(function () { setBusy('') })
      }, [push])

      /**
       * 确认改动（2026-11-08 他要的「点一下确认键才删掉」）。
       * 宿主那边会：先备份 → 再改 → 返回备份路径和改动记录；这里只把勾选的序号送过去。
       */
      const applyPicks = React.useCallback(function () {
        if (!preview) return
        const picks = Object.keys(picked).map(Number).filter((n) => Number.isInteger(n) && n > 0)
        if (!picks.length) { push('先勾几条再确认'); return }
        // 折叠时每条都得有摘要 —— 没写的直接拦下来，别让它变成占位符。
        if (preview.kind === 'fold') {
          const missing = picks.filter((n) => !String(summaries[n] || '').trim())
          if (missing.length) {
            push('这几条还没写「留成什么」：' + missing.map((n) => '#' + n).join('、'))
            return
          }
        }
        const payload = { kind: preview.kind, picks: picks }
        if (preview.kind === 'fold') {
          payload.summaries = {}
          for (const n of picks) payload.summaries[n] = String(summaries[n] || '').trim()
        }
        act(
          'apply',
          (preview.kind === 'fold' ? '确认折叠 ' : '确认删除 ') + picks.length + ' 条',
          payload,
        )
      }, [preview, picked, summaries, act, push])

      return h('div', {
        style: {
          border: `1px solid ${T.border}`, borderRadius: 8,
          padding: '10px 12px', margin: '6px 0', background: T.panel,
          fontSize: 12, lineHeight: '18px', color: 'inherit',
        },
      },
        // ── 标题 ──
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: 13 } }, '遗忘曲线 · 调试面板'),
          h('span', { style: { opacity: 0.6 } },
            snap ? `实时 · 算于 ${fmtTime(snap.generatedAt)}` : (err ? '读不到宿主' : '正在读取…')),
          // 模式标签（只显示；开关在下面按钮那一排 —— 标题行的容器会吃掉点击）
          snap
            ? h('span', {
              style: {
                fontSize: 11, padding: '1px 6px', borderRadius: 999,
                border: `1px solid ${isAuto ? T.danger : T.border}`,
                color: isAuto ? T.danger : 'inherit',
                opacity: 0.85,
              },
            }, isAuto ? '自动模式' : '只读 · 提案模式')
            : null,
        ),

        // ── 读不到时：说清楚 + 给回退办法（不拿 "—" 糊）──
        err && !snap
          ? h('div', {
            style: {
              margin: '8px 0 4px', padding: '8px 10px', borderRadius: 6,
              border: `1px solid ${T.danger}`, color: T.danger,
            },
          },
            h('div', null, `宿主那条只读路由没通：${err}`),
            h('div', { style: { marginTop: 4, opacity: 0.85 } },
              '回退办法：报告目录里的 snapshot.json（默认 _handover\\_记忆备份\\_报告\\snapshot.json），'),
            h('div', { style: { opacity: 0.85 } }, '或者命令行 node index.js --snapshot。'),
          )
          : null,

        !snap && !err ? h('div', { style: { margin: '8px 0', opacity: 0.7 } }, '正在读取宿主快照…') : null,

        // ── 总量 ──
        snap ? h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, margin: '8px 0 4px', flexWrap: 'wrap' } },
          h('span', { style: { fontFamily: T.mono, fontSize: 16, fontWeight: 600, color: headline } },
            `${nf(snap.totalBytes)} / ${nf(snap.limitBytes)}`),
          h('span', { style: { fontFamily: T.mono, color: headline, opacity: hot ? 1 : 0.8 } },
            `${(Number(snap.ratio) * 100).toFixed(1)}%`),
          h('span', { style: { opacity: 0.65 } },
            hot
              ? `已踩 85% 红线（${nf(snap.alertBytes)} B）`
              : `距 85%（${nf(snap.alertBytes)} B）还有 ${nf(snap.alertBytes - snap.totalBytes)} B`),
        ) : null,

        // ── 九块 ──
        snap ? h('div', { style: { margin: '6px 0 2px' } },
          h('div', { style: { ...rowStyle, borderBottom: 'none', opacity: 0.6, fontSize: 11 } },
            h('span', { style: { ...cell, width: '3.2em', flex: '0 0 auto' } }, '块'),
            h('span', { style: { ...cell, flex: '1 1 auto' } }, '叫什么'),
            h('span', { style: num }, '用量'),
            h('span', { style: num }, '额度'),
            h('span', { style: num }, '差'),
            h('span', { style: { ...num, width: '62px' } }, '三/二/一'),
            h('span', { style: { ...num, width: '52px' } }, '折/删'),
          ),
          blocks.map((b) => h(BlockRow, {
            key: b.id,
            id: b.id,
            name: b.name,
            bytes: b.bytes,
            quota: b.quota,
            diff: b.diff,
            tiers: b.tiers,
            fold: b.fold,
            remove: b.remove,
            // overLimit 由宿主按 ±10% 容差算好；老快照没这个字段时退回 diff>0。
            overLimit: b.overLimit,
            over: b.diff === null ? 0 : b.diff,
          })),
        ) : null,

        // ── 建议 + 结构 ──
        snap ? h('div', { style: { marginTop: 6, opacity: 0.8, display: 'flex', gap: 14, flexWrap: 'wrap' } },
          h('span', null, `建议折叠 ${nf(suggestion.fold)} 条（约省 ${nf(suggestion.foldBytes)} B）`),
          h('span', null, `建议删 ${nf(suggestion.remove)} 条（约省 ${nf(suggestion.removeBytes)} B）`),
          h('span', null, `三级封印 ${nf(suggestion.sealed)} 条`),
          h('span', null, `候选遗忘 ${nf(suggestion.candidates)} 条`),
          h('span', null, `没来由 ${nf(suggestion.noCause)} 条`),
        ) : null,

        // ── 三个按钮 ──
        h('div', { style: { display: 'flex', gap: 8, margin: '10px 0 8px', flexWrap: 'wrap' } },
          h('button', {
            type: 'button', style: btnStyle, disabled: busy === 'scan',
            // 走 POST（op=scan）而不是 GET：GET 那份有 30 秒缓存，
            // 手点"重新扫描"要的是**绕过缓存、当场重算**。
            onClick: () => act('scan', '重新扫描'),
          }, busy === 'scan' ? '扫描中…' : '重新扫描'),
          h('button', {
            type: 'button', style: btnStyle, disabled: busy === 'report',
            onClick: () => act('report', '出报告'),
          }, busy === 'report' ? '写报告中…' : '出报告'),
          h('button', {
            type: 'button', style: btnStyle, disabled: busy === 'backup',
            onClick: () => act('backup', '备份'),
          }, busy === 'backup' ? '备份中…' : '备份'),
          // 模式开关放这儿（2026-11-08）：标题行那个位置点了没反应 ——
          // 标题行的容器把点击吃了。这里用和旁边按钮一模一样的内联写法。
          // auto 不做二次确认：它只会自动备份 + 出报告，不会改信，误点也没事。
          h('button', {
            type: 'button',
            style: btnStyle,
            disabled: busy === 'setMode',
            onClick: () => {
              const cur = (snap && snap.mode) === 'auto' ? 'auto' : 'proposal'
              const next = cur === 'auto' ? 'proposal' : 'auto'
              act('setMode', next === 'auto' ? '切到自动模式' : '切回提案模式', { mode: next })
            },
          }, busy === 'setMode'
            ? '切换中…'
            : ((snap && snap.mode) === 'auto' ? '自动模式：开（点一下切回只读）' : '切到自动模式')),
          // 「给选项」两个入口（2026-11-08）。
          // 折叠：**必须你写一句"留成什么"**（机器写出来是占位符，实测两次都把原文换成了废话）。
          h('button', {
            type: 'button', style: btnStyle, disabled: busy === 'items',
            onClick: () => loadItems('fold'),
          }, '看折叠候选（' + nf(suggestion.fold) + '）'),
          h('button', {
            type: 'button', style: btnStyle, disabled: busy === 'items',
            onClick: () => loadItems('remove'),
          }, '看删除候选（' + nf(suggestion.remove) + '）'),
          // 误删的退路（2026-11-08）：恢复最近一份完整备份。
          h('button', {
            type: 'button', style: btnStyle, disabled: busy === 'restore',
            onClick: () => act('restore', '恢复最近备份', {}),
          }, busy === 'restore' ? '恢复中…' : '恢复最近备份'),
        ),

        // ── 候选清单：勾了就记着，改由人（或下一轮的我）来做 ──
        preview ? h('div', {
          style: {
            margin: '0 0 8px', padding: '8px 10px', borderRadius: 6,
            border: `1px solid ${T.border}`, background: T.panel,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 } },
            h('strong', null, (preview.kind === 'fold' ? '可折叠' : '可删') + ' ' + preview.items.length + ' 条'),
            h('span', { style: { opacity: 0.6, fontSize: 11 } },
              '勾完了告诉我，我来改；这个版本不会自己动 AGENTS.md。'),
            h('span', {
              style: { marginLeft: 'auto', cursor: 'pointer', opacity: 0.7, fontSize: 11 },
              onClick: () => { setPreview(null); setPicked({}) },
            }, '收起'),
          ),
          h('div', { style: { maxHeight: 300, overflow: 'auto' } },
            preview.items.map((it) => h('div', {
              key: it.n,
              style: {
                display: 'block', padding: '4px 0',
                borderTop: `1px solid ${T.border}`,
              },
            },
              h('label', { style: { cursor: 'pointer', display: 'flex', alignItems: 'flex-start', gap: 6 } },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(picked[it.n]),
                  onChange: () => {
                    setPicked((prev) => {
                      const next = Object.assign({}, prev)
                      if (next[it.n]) delete next[it.n]
                      else next[it.n] = true
                      return next
                    })
                  },
                  style: { marginTop: 3 },
                }),
                h('span', { style: { fontFamily: T.mono, opacity: 0.65, fontSize: 11, whiteSpace: 'nowrap' } },
                  '[' + it.block + '] ' + nf(it.bytes) + 'B'),
                h('span', null, it.text.length > 140 ? it.text.slice(0, 140) + '…' : it.text),
              ),
              // 折叠才要摘要：勾上以后这里出现一个输入框，写"这条留成什么"。
              (picked[it.n] && preview.kind === 'fold')
                ? h('div', { style: { margin: '4px 0 0 26px' } },
                  h('input', {
                    type: 'text',
                    value: summaries[it.n] || '',
                    placeholder: '这条留成什么？写一句（折叠后文件里就是这句）',
                    onChange: (e) => {
                      const v = e.target.value
                      setSummaries((prev) => Object.assign({}, prev, { [it.n]: v }))
                    },
                    style: {
                      width: '100%', boxSizing: 'border-box',
                      padding: '3px 6px', borderRadius: 4,
                      border: `1px solid ${String(summaries[it.n] || '').trim() ? T.border : T.danger}`,
                      background: 'transparent', color: 'inherit',
                      fontSize: 12, fontFamily: 'inherit',
                    },
                  }),
                )
                : null,
            )),
          ),
          h('div', { style: { marginTop: 6, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 11, opacity: 0.75 } },
              '已勾 ' + Object.keys(picked).length + ' 条（' +
              nf(preview.items.filter((x) => picked[x.n]).reduce((n, x) => n + x.bytes, 0)) + ' B）'),
            h('button', {
              type: 'button',
              style: btnStyle,
              disabled: busy === 'apply' || !Object.keys(picked).length,
              onClick: applyPicks,
            }, busy === 'apply'
              ? '改…'
              : (preview.kind === 'fold'
                ? '确认折叠这 ' + Object.keys(picked).length + ' 条'
                : '确认删掉这 ' + Object.keys(picked).length + ' 条')),
            h('span', { style: { fontSize: 11, opacity: 0.6 } },
              '动手前会自动备份；改完刷新一下页面就能看到真少了没有。'),
          ),
        ) : null,

        // ── 结果区 ──
        h('pre', {
          style: {
            margin: 0, padding: '8px 10px', borderRadius: 6,
            border: `1px solid ${T.border}`,
            fontFamily: T.mono, fontSize: 11, lineHeight: '17px',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 180, overflow: 'auto', color: 'inherit',
            minHeight: 34,
          },
        }, lines.length ? lines.join('\n') : '点上面三个按钮试一下（都会真跑，路径会打在这里）。'),

        // ── 脚注：这一屏的数都是从哪来的 ──
        h('div', { style: { marginTop: 8, opacity: 0.55, fontSize: 11, display: 'flex', gap: 14, flexWrap: 'wrap' } },
          h('span', null, `上次跑：${snap ? fmtTime(snap.lastRunAt) : '未知'}`),
          h('span', null, `周期：${snap ? nf(snap.periodDays) : '未知'} 天`),
          h('span', null, `块额度合计 ${nf(quotaTotal)} B / 预算 ${snap ? nf(snap.limitBytes) : '未知'} B`),
          h('span', null, `工作区 ${snap ? snap.workspace : '未知'}`),
        ),
        snap && snap.reportPath
          ? h('div', { style: { marginTop: 4, opacity: 0.55, fontSize: 11, wordBreak: 'break-all' } },
            `最近报告：${snap.reportPath}`)
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // slot 不变：settings.section 是这个面板已经住着的屋子（dsh-nekowhale-stickers 同款）。
        // 换屋子 = 换 props 契约，没必要冒这个险；数据本来也不靠 props。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'forgetting-curve-panel',
          order: 10,
          label: '遗忘曲线',
        }, Panel))
      },
    }
  },
})
