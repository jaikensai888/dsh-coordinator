/*
 * The usage console: overview, per-node table, node detail, and the call ledger.
 *
 * It talks to exactly one API — `/api/usage/*` — and renders what the server
 * aggregated. No total is computed in the browser: the summary, the trend points and
 * the model distribution all come from the same numbers the node table does, which
 * is what keeps the chart, the table and the detail page consistent.
 *
 * Three display rules come straight from the contract:
 *
 * - A null token bucket is "—" with a note, never "0". "The provider did not report
 *   it" and "it was zero" are different facts, and only one of them is a measurement.
 * - `knownTokens` is labelled as a known subtotal whenever any call lacks a total.
 *   The number is still useful; presenting it as complete would not be.
 * - Coverage (did sync deliver everything?) and usage completeness (did the provider
 *   report usage?) are shown separately, because they fail for unrelated reasons.
 *
 * Rendering uses `textContent` for every server-supplied value. provider/model are
 * arbitrary strings from another machine, and this page must not be a scripting
 * surface.
 */
(function () {
  'use strict'

  // ---------------------------------------------------------------- constants

  const TZ_OFFSET = { 'Asia/Shanghai': 8 * 60 * 60 * 1000, UTC: 0 }
  const TZ_SUFFIX = { 'Asia/Shanghai': '+08:00', UTC: '+00:00' }
  const DAY = 24 * 60 * 60 * 1000
  const REFRESH_MS = 15_000

  const STATE_LABEL = {
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    process_interrupted: '进程中断',
  }

  const PURPOSE_LABEL = {
    conversation: '会话',
    compaction: '压缩',
    'session-title': '标题生成',
    other: '其他',
  }

  const COLLECTOR_LABEL = {
    disabled: '采集已关闭',
    unsupported: '不支持采集',
    degraded: '采集异常',
    initializing: '首次同步',
    synced: '已同步',
    pending: '待补传',
  }

  const COLLECTOR_TONE = {
    disabled: 'bad',
    unsupported: 'bad',
    degraded: 'bad',
    initializing: 'warn',
    synced: 'ok',
    pending: 'warn',
  }

  // ------------------------------------------------------------------- state

  const state = {
    active: false,
    busy: false,
    range: '7d',
    from: '',
    to: '',
    timezone: 'Asia/Shanghai',
    grain: 'day',
    metric: 'tokens',
    sort: 'knownTokens',
    order: 'desc',
    page: 1,
    pageSize: 20,
    detail: null,
    filters: { provider: '', model: '', state: '', usage: 'all' },
    cursor: null,
    cursorStack: [],
    summary: null,
    series: null,
    nodes: null,
    status: null,
    requests: null,
    abort: null,
    requestSeq: 0,
    lastLoadedAt: null,
  }

  let root = null
  let poll = null

  // ----------------------------------------------------------------- helpers

  /** Create an element with optional props and children. */
  function h (tag, props, ...children) {
    const node = document.createElement(tag)
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null) continue
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = value
        else if (key === 'html') node.innerHTML = value
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
        else if (key === 'dataset') Object.assign(node.dataset, value)
        else node.setAttribute(key, String(value))
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue
      node.append(child instanceof Node ? child : document.createTextNode(String(child)))
    }
    return node
  }

  /** Group a decimal string in threes, without converting it to a number. */
  function group (decimal) {
    if (typeof decimal !== 'string') return '—'
    return decimal.replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009')
  }

  /** A short display value for an axis label. Display-only rounding. */
  function compact (decimal) {
    const text = String(decimal)
    if (text.length <= 6) return group(text)
    const value = Number(text)
    if (!Number.isFinite(value)) return group(text)
    if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
    return group(text)
  }

  /** Parse a contract decimal to a number, for geometry only. */
  function asNumber (decimal) {
    const value = Number(decimal)
    return Number.isFinite(value) && value >= 0 ? value : 0
  }

  /** ISO-8601 with the selected zone's explicit offset. */
  function isoAt (ms, timezone) {
    const shifted = new Date(ms + TZ_OFFSET[timezone])
    return `${shifted.toISOString().slice(0, 19)}${TZ_SUFFIX[timezone]}`
  }

  /** The UTC instant at which the local day containing `ms` starts. */
  function startOfDay (ms, timezone) {
    const offset = TZ_OFFSET[timezone]
    return Math.floor((ms + offset) / DAY) * DAY - offset
  }

  /** The [from, to) pair for the current range selection. */
  function windowFor (range, timezone) {
    const now = Date.now()
    if (range === 'today') {
      const start = startOfDay(now, timezone)
      return { from: start, to: start + DAY }
    }
    if (range === '30d') {
      const start = startOfDay(now - 29 * DAY, timezone)
      return { from: start, to: startOfDay(now, timezone) + DAY }
    }
    if (range === 'custom' && state.from !== '' && state.to !== '') {
      const from = Date.parse(`${state.from}T00:00:00${TZ_SUFFIX[timezone]}`)
      const to = Date.parse(`${state.to}T00:00:00${TZ_SUFFIX[timezone]}`) + DAY
      if (Number.isFinite(from) && Number.isFinite(to) && from < to) return { from, to }
      return null
    }
    const start = startOfDay(now - 6 * DAY, timezone)
    return { from: start, to: startOfDay(now, timezone) + DAY }
  }

  /** Build the query string for one window. */
  function queryFor (window, timezone, extra) {
    const params = new URLSearchParams()
    params.set('from', isoAt(window.from, timezone))
    params.set('to', isoAt(window.to, timezone))
    params.set('timezone', timezone)
    for (const [key, value] of Object.entries(extra || {})) {
      if (value === undefined || value === null || value === '') continue
      params.set(key, String(value))
    }
    return params.toString()
  }

  /** Render one timestamp in the selected zone. */
  function formatTime (iso, timezone) {
    if (typeof iso !== 'string') return '—'
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms)) return '—'
    const date = new Date(ms + TZ_OFFSET[timezone])
    const pad = (value) => String(value).padStart(2, '0')
    const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    if (timezone === 'UTC') return `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
    return `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  }

  /** One decimal cell, or an em dash with an explanation. */
  function decimalCell (value, unknownCount, label) {
    if (value === null || value === undefined) {
      return h('td', { class: 'u-num u-unknown', title: `${label}：供应商未返回，不能当作 0` }, '—')
    }
    const cell = h('td', { class: 'u-num' }, group(value))
    if (unknownCount !== undefined && unknownCount !== null && unknownCount !== '0') {
      cell.append(h('div', { class: 'u-faint u-unknown', title: `${label}：${unknownCount} 次调用缺少该字段` }, `缺 ${group(unknownCount)}`))
    }
    return cell
  }

  /** A pill for one collector state. */
  function collectorPill (collectorState, connectionState) {
    const label = COLLECTOR_LABEL[collectorState] || collectorState || '未知'
    const tone = COLLECTOR_TONE[collectorState] || 'info'
    const offline = connectionState !== undefined && connectionState !== 'ready'
      ? ' · 离线'
      : ''
    return h('span', { class: `u-pill u-${tone}` }, `${label}${offline}`)
  }

  /** The rate of terminated calls that reported usage. */
  function reportedRate (totals) {
    const terminated = ['completedCount', 'failedCount', 'cancelledCount', 'interruptedCount']
      .reduce((sum, key) => sum + asNumber(totals[key] || '0'), 0)
    const reported = asNumber(totals.usageReportedCount || '0')
    if (terminated === 0) return '—'
    return `${((reported / terminated) * 100).toFixed(1)}%`
  }

  /** Whether any call in this window lacks a total. */
  function hasUnknownTotal (totals) {
    return asNumber(totals.totalUnknownCount || '0') > 0
  }

  // ------------------------------------------------------------------- fetch

  /** One API call, with the redirect-on-401 rule the console shares. */
  async function api (path) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' })
    if (response.status === 401) {
      window.location.replace('/login')
      throw new Error('会话已失效')
    }
    let body
    try {
      body = await response.json()
    } catch {
      throw new Error(`服务器返回了无法解析的响应（HTTP ${response.status}）`)
    }
    if (body.ok !== true) {
      const message = body.error && typeof body.error.message === 'string' ? body.error.message : '请求失败'
      throw new Error(message)
    }
    return body.value
  }

  // ---------------------------------------------------------------- controls

  /** Build the page once. */
  function build () {
    root.textContent = ''
    const bar = h('div', { class: 'u-topbar' },
      h('h2', { text: '用量统计' }),
      h('div', { class: 'u-seg', role: 'group', 'aria-label': '时间范围' },
        ...['today', '7d', '30d', 'custom'].map(range => h('button', {
          type: 'button',
          'aria-pressed': String(state.range === range),
          onclick: () => {
            state.range = range
            if (range !== 'custom') state.from = state.to = ''
            build()
            void load()
          },
        }, { today: '今天', '7d': '近 7 天', '30d': '近 30 天', custom: '自定义' }[range]))),
      h('div', { class: 'u-range' },
        h('input', {
          class: 'u-input',
          type: 'date',
          'aria-label': '开始日期',
          value: state.from,
          disabled: state.range !== 'custom' ? '' : null,
          onchange: event => { state.from = event.target.value; void load() },
        }),
        h('span', { class: 'u-faint' }, '至'),
        h('input', {
          class: 'u-input',
          type: 'date',
          'aria-label': '结束日期',
          value: state.to,
          disabled: state.range !== 'custom' ? '' : null,
          onchange: event => { state.to = event.target.value; void load() },
        })),
      h('label', { class: 'u-faint', for: 'usage-tz' }, '时区'),
      h('select', {
        class: 'u-select',
        id: 'usage-tz',
        style: 'width:auto',
        onchange: event => { state.timezone = event.target.value; build(); void load() },
      },
      h('option', { value: 'Asia/Shanghai', selected: state.timezone === 'Asia/Shanghai' ? '' : null }, 'Asia/Shanghai (UTC+8)'),
      h('option', { value: 'UTC', selected: state.timezone === 'UTC' ? '' : null }, 'UTC')),
      h('span', { class: 'u-spacer' }),
      h('span', { class: 'u-faint', id: 'usage-asof' }, state.lastLoadedAt === null ? '尚未加载' : `数据截至 ${formatTime(new Date(state.lastLoadedAt).toISOString(), state.timezone)}`),
      h('button', { class: 'u-button', type: 'button', onclick: () => { void load() } }, '刷新'))

    const banner = h('div', { class: 'u-banner', id: 'usage-banner', role: 'status' })
    const body = h('div', { id: 'usage-body' })
    root.append(bar, banner, body)

    if (state.detail === null) renderOverview(body)
    else renderDetail(body)
  }

  // ---------------------------------------------------------------- overview

  /** The four summary cards. */
  function cards (totals) {
    const box = h('div', { class: 'u-cards' })
    box.append(
      h('div', { class: 'u-card' },
        h('div', { class: 'u-k' }, '模型调用'),
        h('div', { class: 'u-v' }, group(totals.requestCount)),
        h('div', { class: 'u-s' }, `已完成 ${group(totals.completedCount)} · 失败 ${group(totals.failedCount)} · 运行中 ${group(totals.runningCount)}`)),
      h('div', { class: 'u-card' },
        h('div', { class: 'u-k' }, hasUnknownTotal(totals) ? '已知 Token 合计（不完整）' : '已知 Token 合计'),
        h('div', { class: 'u-v' }, group(totals.knownTokens)),
        h('div', { class: 'u-s' }, hasUnknownTotal(totals)
          ? `${group(totals.totalUnknownCount)} 次调用没有完整总量`
          : '每次调用都有完整总量')),
      h('div', { class: 'u-card' },
        h('div', { class: 'u-k' }, 'usage 完整率'),
        h('div', { class: 'u-v' }, reportedRate(totals)),
        h('div', { class: 'u-s' }, `未返回 usage ${group(totals.unknownUsageCount)} 次（已终止调用）`)),
      h('div', { class: 'u-card' },
        h('div', { class: 'u-k' }, '缓存读 / 写'),
        h('div', { class: 'u-v' }, group(totals.cacheReadTokens)),
        h('div', { class: 'u-s' }, `缓存写 ${group(totals.cacheWriteTokens)} · 未缓存输入 ${group(totals.uncachedInputTokens)} · 输出 ${group(totals.outputTokens)}`)),
    )
    return box
  }

  /** The coverage banner, which is not the same question as usage completeness. */
  function updateBanner (summary) {
    const banner = document.getElementById('usage-banner')
    if (!banner) return
    const notes = []
    banner.classList.remove('u-on', 'u-bad')
    if (summary.coverage === 'incomplete') {
      banner.classList.add('u-on')
      notes.push('存在采集缺口：某些时段的调用没有被完整同步，这段时间的合计只是已知下界。')
    } else if (summary.coverage === 'unknown') {
      banner.classList.add('u-on')
      notes.push('覆盖状态未知：还没有任何节点完成同步，或节点报告了采集故障。')
    }
    if (summary.gapCount > 0) notes.push(`已记录 ${summary.gapCount} 个缺口区间，详情见节点「采集状态」。`)
    if (summary.supportedNodeCount === 0) {
      banner.classList.add('u-on', 'u-bad')
      notes.push('还没有节点支持用量采集：请升级节点插件，或在节点上启用 usage。')
    }
    if (summary.lastSyncedAt === null) {
      notes.push('尚未成功同步任何节点。')
    }
    banner.textContent = notes.join(' ')
  }

  /** One SVG trend chart. */
  function chart (points, metric) {
    const width = 900
    const height = 190
    const padLeft = 46
    const padBottom = 22
    const padTop = 10
    const innerW = width - padLeft - 8
    const innerH = height - padBottom - padTop
    const values = points.map(point => metric === 'calls'
      ? asNumber(point.totals.requestCount)
      : asNumber(point.totals.knownTokens))
    const max = Math.max(1, ...values)
    const slot = points.length === 0 ? innerW : innerW / points.length
    const barWidth = Math.max(2, Math.min(28, slot * 0.62))

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'u-chart')
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', metric === 'calls' ? '调用次数趋势' : 'Token 趋势')

    const axis = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    axis.setAttribute('x1', String(padLeft))
    axis.setAttribute('x2', String(width - 8))
    axis.setAttribute('y1', String(padTop + innerH))
    axis.setAttribute('y2', String(padTop + innerH))
    axis.setAttribute('class', 'u-chart-axis')
    svg.append(axis)

    const labelEvery = Math.max(1, Math.ceil(points.length / (window.innerWidth < 620 ? 3 : 8)))
    points.forEach((point, index) => {
      const value = values[index]
      const barHeight = Math.round((value / max) * innerH)
      const x = padLeft + index * slot + (slot - barWidth) / 2
      const y = padTop + innerH - barHeight
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('x', String(x))
      rect.setAttribute('y', String(y))
      rect.setAttribute('width', String(barWidth))
      rect.setAttribute('height', String(Math.max(0, barHeight)))
      rect.setAttribute('rx', '2')
      rect.setAttribute('class', 'u-chart-bar')
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
      title.textContent = `${formatTime(point.from, state.timezone)} — ${metric === 'calls' ? `${group(point.totals.requestCount)} 次调用` : `${group(point.totals.knownTokens)} Token`}`
      rect.append(title)
      svg.append(rect)
      if (index % labelEvery === 0) {
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        label.setAttribute('x', String(padLeft + index * slot + slot / 2))
        label.setAttribute('y', String(height - 6))
        label.setAttribute('text-anchor', 'middle')
        label.setAttribute('class', 'u-chart-label')
        label.textContent = formatTime(point.from, state.timezone).slice(0, -6)
        svg.append(label)
      }
    })

    const top = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    top.setAttribute('x', String(padLeft - 6))
    top.setAttribute('y', String(padTop + 8))
    top.setAttribute('text-anchor', 'end')
    top.setAttribute('class', 'u-chart-label')
    top.textContent = compact(String(max))
    svg.append(top)
    return svg
  }

  /** The node table. */
  function nodeTable (page) {
    const box = h('div', { class: 'u-scroll' })
    const table = h('table', { class: 'u-table' })
    const head = h('tr')
    const sortHeader = (label, key, numeric) => h('th', {
      class: numeric === true ? 'u-num' : null,
      scope: 'col',
      tabindex: '0',
      title: '点击排序',
      onclick: () => { toggleSort(key) },
      onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleSort(key) } },
    }, `${label}${state.sort === key ? (state.order === 'desc' ? ' ↓' : ' ↑') : ''}`)
    head.append(
      sortHeader('节点', 'nodeName', false),
      h('th', { scope: 'col' }, '连接 / 采集'),
      sortHeader('调用', 'requestCount', true),
      h('th', { class: 'u-num', scope: 'col' }, '未缓存输入'),
      h('th', { class: 'u-num', scope: 'col' }, '缓存读'),
      h('th', { class: 'u-num', scope: 'col' }, '缓存写'),
      h('th', { class: 'u-num', scope: 'col' }, '输出'),
      sortHeader('已知合计', 'knownTokens', true),
      h('th', { class: 'u-num', scope: 'col' }, '未知用量'),
      h('th', { scope: 'col' }, '最近同步'))
    table.append(h('thead', null, head))

    const body = h('tbody')
    if (page.items.length === 0) {
      body.append(h('tr', null, h('td', { colspan: '10' }, h('div', { class: 'u-empty' }, '没有节点数据'))))
    }
    for (const node of page.items) {
      const totals = node.totals
      const row = h('tr', {
        class: 'u-row',
        tabindex: '0',
        title: `查看 ${node.nodeName || node.nodeId} 的详情`,
        onclick: () => { void openDetail(node.nodeId) },
        onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void openDetail(node.nodeId) } },
      })
      row.append(
        h('td', null,
          h('div', null, node.nodeName || '未命名节点'),
          h('div', { class: 'u-faint u-mono' }, node.nodeId)),
        h('td', null, collectorPill(node.collectorState, node.connectionState)),
        totals === null ? h('td', { class: 'u-num u-unknown', title: '该节点不支持采集，没有可用统计' }, '—') : h('td', { class: 'u-num' }, group(totals.requestCount)),
        totals === null ? h('td', { class: 'u-num u-unknown' }, '—') : decimalCell(totals.uncachedInputTokens, totals.bucketUnknownCounts.input, '未缓存输入'),
        totals === null ? h('td', { class: 'u-num u-unknown' }, '—') : decimalCell(totals.cacheReadTokens, totals.bucketUnknownCounts.cacheRead, '缓存读'),
        totals === null ? h('td', { class: 'u-num u-unknown' }, '—') : decimalCell(totals.cacheWriteTokens, totals.bucketUnknownCounts.cacheWrite, '缓存写'),
        totals === null ? h('td', { class: 'u-num u-unknown' }, '—') : decimalCell(totals.outputTokens, totals.bucketUnknownCounts.output, '输出'),
        totals === null
          ? h('td', { class: 'u-num u-unknown' }, '—')
          : h('td', { class: 'u-num' },
            group(totals.knownTokens),
            hasUnknownTotal(totals) ? h('div', { class: 'u-faint u-unknown' }, `不完整 · 缺 ${group(totals.totalUnknownCount)}`) : null),
        totals === null ? h('td', { class: 'u-num u-unknown' }, '—') : h('td', { class: 'u-num' }, group(totals.unknownUsageCount)),
        h('td', { class: 'u-faint' }, formatTime(node.lastSyncedAt, state.timezone)))
      body.append(row)
    }
    table.append(body)
    box.append(table)

    const pager = h('div', { class: 'u-pager' },
      h('span', { class: 'u-faint' }, `共 ${page.totalItems} 个节点`),
      h('span', { class: 'u-spacer' }),
      h('button', {
        class: 'u-button', type: 'button', disabled: page.page <= 1 ? '' : null,
        onclick: () => { state.page = Math.max(1, state.page - 1); void load() },
      }, '上一页'),
      h('span', { class: 'u-faint' }, `第 ${page.page} 页`),
      h('button', {
        class: 'u-button', type: 'button',
        disabled: page.page * page.pageSize >= page.totalItems ? '' : null,
        onclick: () => { state.page += 1; void load() },
      }, '下一页'))
    return [box, pager]
  }

  /** Toggle one sort key. */
  function toggleSort (key) {
    if (state.sort === key) state.order = state.order === 'desc' ? 'asc' : 'desc'
    else { state.sort = key; state.order = 'desc' }
    state.page = 1
    void load()
  }

  /** Render the overview. */
  function renderOverview (container) {
    container.textContent = ''
    if (state.summary === null) {
      container.append(h('div', { class: 'u-panel' }, h('div', { class: 'u-empty' }, '加载中…')))
      return
    }
    container.append(cards(state.summary.totals))

    const trendPanel = h('div', { class: 'u-panel' },
      h('div', { class: 'u-panel-head' },
        h('h3', null, '趋势'),
        h('span', { class: 'u-spacer' }),
        h('div', { class: 'u-seg', role: 'group', 'aria-label': '趋势指标' },
          h('button', { type: 'button', 'aria-pressed': String(state.metric === 'tokens'), onclick: () => { state.metric = 'tokens'; void load() } }, 'Token'),
          h('button', { type: 'button', 'aria-pressed': String(state.metric === 'calls'), onclick: () => { state.metric = 'calls'; void load() } }, '调用次数'))))
    if (state.series !== null && state.series.points.length > 0) {
      trendPanel.append(chart(state.series.points, state.metric))
    } else {
      trendPanel.append(h('div', { class: 'u-empty' }, '这个时间范围内没有调用'))
    }
    trendPanel.append(h('div', { class: 'u-faint', style: 'margin-top:8px' },
      `每个桶按 ${state.timezone} 的${state.series && state.series.grain === 'hour' ? '小时' : '自然日'}划分；缺口不会被画成 0。`))
    container.append(trendPanel)

    if (state.nodes !== null) {
      const tablePanel = h('div', { class: 'u-panel' },
        h('div', { class: 'u-panel-head' },
          h('h3', null, '节点用量'),
          h('span', { class: 'u-spacer' }),
          h('span', { class: 'u-faint' }, '点击一行查看详情')))
      tablePanel.append(...nodeTable(state.nodes))
      container.append(tablePanel)
    }
  }

  // ------------------------------------------------------------------ detail

  /** Open one node's detail view. */
  async function openDetail (nodeId) {
    state.detail = nodeId
    state.cursor = null
    state.cursorStack = []
    state.filters = { provider: '', model: '', state: '', usage: 'all' }
    state.requests = null
    build()
    await load()
  }

  /** Render the node detail. */
  function renderDetail (container) {
    const node = state.nodes === null ? undefined : state.nodes.items.find(item => item.nodeId === state.detail)
    const summary = state.summary
    container.textContent = ''
    const head = h('div', { class: 'u-detail-head' },
      h('button', { class: 'u-button', type: 'button', onclick: () => { state.detail = null; state.summary = null; state.series = null; state.nodes = null; state.requests = null; build(); void load() } }, '← 返回概览'),
      h('h2', null, node ? (node.nodeName || '未命名节点') : state.detail),
      h('span', { class: 'u-faint u-mono' }, state.detail || ''),
      node ? collectorPill(node.collectorState, node.connectionState) : null,
      node ? h('span', { class: 'u-faint' }, `覆盖：${node.coverage === 'complete' ? '完整' : node.coverage === 'incomplete' ? '存在缺口' : '未知'}`) : null,
      node ? h('span', { class: 'u-faint' }, `最近同步 ${formatTime(node.lastSyncedAt, state.timezone)}`) : null)
    container.append(head)

    if (summary !== null && summary.totals !== undefined) {
      container.append(cards(summary.totals))
    }
    if (summary !== null && (summary.coverage !== 'complete' || summary.gapCount > 0)) {
      container.append(h('div', { class: 'u-banner u-on' },
        summary.coverage === 'incomplete'
          ? '该节点的采集存在缺口：表格和趋势都是已知下界，缺口时段无法补出精确值。'
          : '该节点的覆盖状态不是“完整”；合计可能缺少部分时段的调用。'))
    }

    const trendPanel = h('div', { class: 'u-panel' },
      h('div', { class: 'u-panel-head' }, h('h3', null, '该节点趋势'), h('span', { class: 'u-spacer' })))
    if (state.series !== null && state.series.points.length > 0) trendPanel.append(chart(state.series.points, state.metric))
    else trendPanel.append(h('div', { class: 'u-empty' }, '这个时间范围内没有调用'))
    container.append(trendPanel)

    const modelPanel = h('div', { class: 'u-panel' },
      h('div', { class: 'u-panel-head' }, h('h3', null, '模型分布'), h('span', { class: 'u-spacer' }), h('span', { class: 'u-faint' }, '服务端聚合全部筛选结果')))
    const models = summary === null ? [] : summary.byModel
    if (models.length === 0) {
      modelPanel.append(h('div', { class: 'u-empty' }, '没有模型调用'))
    } else {
      const scroll = h('div', { class: 'u-scroll' })
      const table = h('table', { class: 'u-table', style: 'min-width:520px' })
      table.append(h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, 'Provider'),
        h('th', { scope: 'col' }, '模型'),
        h('th', { class: 'u-num', scope: 'col' }, '调用'),
        h('th', { class: 'u-num', scope: 'col' }, '已知 Token'))))
      const body = h('tbody')
      for (const entry of models) {
        body.append(h('tr', null,
          h('td', { class: 'u-mono' }, entry.isOther ? '其他' : (entry.provider || '未知')),
          h('td', { class: 'u-mono' }, entry.isOther ? '其余模型合计' : (entry.model || '未知')),
          h('td', { class: 'u-num' }, group(entry.requestCount)),
          h('td', { class: 'u-num' }, group(entry.knownTokens))))
      }
      table.append(body)
      scroll.append(table)
      modelPanel.append(scroll)
    }
    container.append(modelPanel)

    const requestPanel = h('div', { class: 'u-panel' },
      h('div', { class: 'u-panel-head' },
        h('h3', null, '调用明细'),
        h('span', { class: 'u-spacer' }),
        h('div', { class: 'u-filters' },
          filterInput('provider', 'Provider', '如 deepseek-official'),
          filterInput('model', '模型', '如 deepseek-v4-flash'),
          filterSelect('state', '终态', [['', '全部'], ['completed', '已完成'], ['failed', '失败'], ['cancelled', '已取消'], ['running', '运行中'], ['process_interrupted', '进程中断']]),
          filterSelect('usage', 'usage', [['all', '全部'], ['reported', '已返回'], ['missing', '未返回']]))))
    requestPanel.append(h('div', { id: 'usage-requests' }))
    container.append(requestPanel)
    renderRequests()
  }

  /** One text filter input. */
  function filterInput (key, label, placeholder) {
    return h('input', {
      class: 'u-input',
      'aria-label': label,
      placeholder,
      value: state.filters[key],
      onchange: (event) => { state.filters[key] = event.target.value.trim(); resetAndLoad() },
    })
  }

  /** One select filter. */
  function filterSelect (key, label, options) {
    const select = h('select', {
      class: 'u-select',
      'aria-label': label,
      onchange: (event) => { state.filters[key] = event.target.value; resetAndLoad() },
    })
    for (const [value, text] of options) {
      select.append(h('option', { value, selected: state.filters[key] === value ? '' : null }, text))
    }
    return select
  }

  /** Reset paging and reload. */
  function resetAndLoad () {
    state.cursor = null
    state.cursorStack = []
    void load()
  }

  /** Render the request ledger. */
  function renderRequests () {
    const host = document.getElementById('usage-requests')
    if (!host) return
    host.textContent = ''
    const page = state.requests
    if (page === null) {
      host.append(h('div', { class: 'u-empty' }, '加载中…'))
      return
    }
    if (page.items.length === 0) {
      host.append(h('div', { class: 'u-empty' }, '没有符合筛选条件的调用'))
    } else {
      const scroll = h('div', { class: 'u-scroll' })
      const table = h('table', { class: 'u-table' })
      table.append(h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, '开始时间'),
        h('th', { scope: 'col' }, 'Provider / 模型'),
        h('th', { scope: 'col' }, '用途'),
        h('th', { scope: 'col' }, '终态'),
        h('th', { class: 'u-num', scope: 'col' }, '输入'),
        h('th', { class: 'u-num', scope: 'col' }, '缓存读'),
        h('th', { class: 'u-num', scope: 'col' }, '缓存写'),
        h('th', { class: 'u-num', scope: 'col' }, '输出'),
        h('th', { class: 'u-num', scope: 'col' }, '已知合计'),
        h('th', { scope: 'col' }, 'usage'))))
      const body = h('tbody')
      for (const item of page.items) {
        const unknownTitle = item.usageReported ? undefined : '供应商没有返回 usage；显示为缺失，不是 0'
        const row = h('tr', { title: item.sessionId ? `会话：${item.sessionId}` : undefined })
        const cell = (value) => value === null
          ? h('td', { class: 'u-num u-unknown', title: unknownTitle }, '—')
          : h('td', { class: 'u-num' }, group(value))
        row.append(
          h('td', { class: 'u-mono' }, formatTime(item.startedAt, state.timezone)),
          h('td', null,
            h('div', null, item.provider || '未知'),
            h('div', { class: 'u-faint u-mono' }, item.model || '未知')),
          h('td', { class: 'u-faint' }, PURPOSE_LABEL[item.purpose] || item.purpose),
          h('td', null, h('span', {
            class: `u-pill ${item.state === 'completed' ? 'u-ok' : item.state === 'failed' ? 'u-bad' : item.state === 'running' ? 'u-info' : 'u-warn'}`,
          }, STATE_LABEL[item.state] || item.state)),
          cell(item.usage.uncachedInputTokens),
          cell(item.usage.cacheReadTokens),
          cell(item.usage.cacheWriteTokens),
          cell(item.usage.outputTokens),
          h('td', { class: 'u-num' },
            group(item.knownTokens),
            item.usage.totalTokens === null ? h('div', { class: 'u-faint u-unknown' }, '已知下界') : null),
          h('td', { class: 'u-faint' }, item.usageReported ? '已返回' : '未返回'))
        body.append(row)
      }
      table.append(body)
      scroll.append(table)
      host.append(scroll)
    }

    const pager = h('div', { class: 'u-pager' },
      h('span', { class: 'u-faint' }, `第 ${state.cursorStack.length + 1} 页`),
      h('span', { class: 'u-spacer' }),
      h('button', {
        class: 'u-button', type: 'button', disabled: state.cursorStack.length === 0 ? '' : null,
        onclick: () => {
          state.cursor = state.cursorStack.pop() ?? null
          void load()
        },
      }, '上一页'),
      h('button', {
        class: 'u-button', type: 'button',
        disabled: page.nextCursor === null,
        onclick: () => {
          state.cursorStack.push(state.cursor)
          state.cursor = page.nextCursor
          void load()
        },
      }, '下一页'))
    host.append(pager)
  }

  // -------------------------------------------------------------------- load

  /** Load whatever the current view needs. */
  async function load () {
    if (!state.active || root === null) return
    const window = windowFor(state.range, state.timezone)
    if (window === null) {
      const banner = document.getElementById('usage-banner')
      if (banner) {
        banner.textContent = '自定义范围无效：请选择开始日期不晚于结束日期，且跨度不超过 90 天。'
        banner.classList.add('u-on', 'u-bad')
      }
      return
    }
    // Abort the previous request so a slow response cannot overwrite a newer filter.
    state.abort?.abort()
    const controller = new AbortController()
    state.abort = controller
    const nodeId = state.detail
    const extra = nodeId === null ? {} : { nodeId }

    try {
      const summaryPath = `/api/usage/summary?${queryFor(window, state.timezone, extra)}`
      const seriesPath = `/api/usage/series?${queryFor(window, state.timezone, { ...extra, grain: state.grain })}`
      const nodesPath = `/api/usage/nodes?${queryFor(window, state.timezone, { ...extra, sort: state.sort, order: state.order, page: String(state.page), pageSize: String(state.pageSize) })}`
      const requestsPath = nodeId === null
        ? null
        : `/api/usage/requests?${queryFor(window, state.timezone, { ...extra, ...state.filters, limit: '20', cursor: state.cursor || '' })}`

      const [summary, series, nodes] = await Promise.all([
        api(summaryPath),
        api(seriesPath),
        api(nodesPath),
      ])
      if (controller.signal.aborted) return
      state.summary = summary
      state.series = series
      state.nodes = nodes
      if (requestsPath !== null) {
        state.requests = await api(requestsPath)
        if (controller.signal.aborted) return
      }
      state.lastLoadedAt = Date.now()
      const body = document.getElementById('usage-body')
      if (body === null) { build(); return }
      if (state.detail === null) renderOverview(body)
      else renderDetail(body)
      updateBanner(summary)
      const asof = document.getElementById('usage-asof')
      if (asof !== null) asof.textContent = `数据截至 ${formatTime(new Date(state.lastLoadedAt).toISOString(), state.timezone)}`
    } catch (error) {
      if (controller.signal.aborted) return
      const banner = document.getElementById('usage-banner')
      if (banner !== null) {
        banner.textContent = `加载用量失败：${error && error.message ? error.message : String(error)}`
        banner.classList.add('u-on', 'u-bad')
      }
    }
  }

  // ------------------------------------------------------------------ public

  /** Show the usage view and start its refresh timer. */
  function activate () {
    state.active = true
    if (root === null) root = document.getElementById('usage-view')
    if (root === null) return
    build()
    void load()
    if (poll === null) {
      poll = window.setInterval(() => {
        // A background refresh is a passive read: it deliberately does not call
        // /api/auth/activity, so it cannot keep an idle session alive.
        if (state.active && document.visibilityState === 'visible') void load()
      }, REFRESH_MS)
    }
  }

  /** Hide the usage view and stop polling. */
  function deactivate () {
    state.active = false
    state.abort?.abort()
    if (poll !== null) {
      window.clearInterval(poll)
      poll = null
    }
  }

  window.DshUsage = {
    activate,
    deactivate,
    refresh: () => { void load() },
    isActive: () => state.active,
  }
})()
