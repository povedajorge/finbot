'use strict'

const WS_URL = `ws://${location.host}`
let socket
let allTransactions = []
let months6 = []
let monthStats = { ingresos: 0, egresos: 0, balance: 0, count: 0 }
let activePeriod = null

// ── WebSocket ──────────────────────────────────────────────

function connect() {
  socket = new WebSocket(WS_URL)

  socket.addEventListener('open', () => console.log('[WS] Conectado'))

  socket.addEventListener('message', ({ data }) => {
    try {
      const { type, payload } = (() => {
        const p = JSON.parse(data)
        return { type: p.type, payload: p.data }
      })()

      switch (type) {
        case 'init':        handleInit(payload);        break
        case 'qr':          handleQR(payload);          break
        case 'connected':   handleConnected();          break
        case 'status':      handleStatus(payload);      break
        case 'transaction': handleTransaction(payload); break
      }
    } catch (e) { console.error('[WS] Parse error', e) }
  })

  socket.addEventListener('close', () => {
    setStatus('disconnected')
    setTimeout(connect, 3000)
  })

  socket.addEventListener('error', () => socket.close())
}

// ── Handlers ───────────────────────────────────────────────

function handleInit({ transactions, monthStats: ms, months6: m6 }) {
  allTransactions = transactions || []
  monthStats = ms || monthStats
  months6 = m6 || []

  renderStats(monthStats)
  renderChart(months6)
  renderTable(activePeriod ? filterByPeriod(allTransactions, activePeriod) : allTransactions)
  updateHeaderBalance()
}

function handleQR({ qrDataUrl }) {
  const img = document.getElementById('qrImage')
  const ph  = document.getElementById('qrPlaceholder')
  img.src = qrDataUrl
  img.classList.add('visible')
  ph.classList.add('hidden')
  setStatus('scanning')
}

function handleConnected() {
  document.getElementById('qrImage').classList.remove('visible')
  document.getElementById('qrPlaceholder').classList.add('hidden')
  const ok = document.getElementById('qrOk')
  ok.style.display = 'flex'
  document.getElementById('qrHint').textContent = 'WhatsApp conectado. Envía facturas o comandos al bot.'
  setStatus('connected')
  toast('WhatsApp conectado correctamente')
}

function handleStatus({ connected }) {
  if (!connected) setStatus('disconnected')
}

function handleTransaction(tx) {
  allTransactions.unshift(tx)

  // Update month stats live
  const todayMonth = new Date().toISOString().slice(0, 7)
  const txMonth = (tx.date || tx.created_at || '').slice(0, 7)
  if (txMonth === todayMonth) {
    if (tx.type === 'ingreso') monthStats.ingresos += (tx.amount ?? 0)
    else                       monthStats.egresos  += (tx.amount ?? 0)
    monthStats.balance = monthStats.ingresos - monthStats.egresos
    monthStats.count++
    renderStats(monthStats)
    updateHeaderBalance()
  }

  // Prepend to table if no period filter, or if within filter
  const display = activePeriod ? filterByPeriod([tx], activePeriod) : [tx]
  if (display.length > 0) {
    const tbody = document.getElementById('tableBody')
    const row = buildRow(tx)
    row.classList.add('new-row')
    hideEmpty()
    tbody.insertBefore(row, tbody.firstChild)
    row.addEventListener('animationend', () => row.classList.remove('new-row'), { once: true })
  }

  const label = tx.type === 'ingreso' ? '[+] INGRESO' : '[-] EGRESO'
  toast(`${label}: ${tx.provider || 'Sin nombre'} — ${fmtCurrency(tx.amount, tx.currency)}`)
}

// ── Render ─────────────────────────────────────────────────

function renderStats(s) {
  setText('statIngresos', fmtCurrency(s.ingresos))
  setText('statEgresos',  fmtCurrency(s.egresos))

  const balEl = document.getElementById('statBalance')
  balEl.textContent = fmtCurrency(s.balance)
  balEl.className = `bento-value bento-value-mono ${s.balance >= 0 ? 'positive' : 'negative'}`

  const last = allTransactions[0]
  setText('statLast', last
    ? `${last.type === 'ingreso' ? '+' : '-'} ${last.provider || 'Sin nombre'} · ${fmtCurrency(last.amount, last.currency)}`
    : '—')
}

function updateHeaderBalance() {
  const total = allTransactions.reduce((s, t) => {
    return s + (t.type === 'ingreso' ? (t.amount ?? 0) : -(t.amount ?? 0))
  }, 0)
  const el = document.getElementById('headerBalance')
  el.textContent = fmtCurrency(total)
  el.className = `header-balance-value ${total >= 0 ? 'positive' : 'negative'}`
}

function renderChart(data) {
  const body = document.getElementById('chartBody')
  if (!data || data.length === 0) { body.innerHTML = ''; return }

  const maxVal = Math.max(...data.map(m => Math.max(m.ingresos, m.egresos)), 1)

  body.innerHTML = data.map(m => {
    const incH = Math.round((m.ingresos / maxVal) * 86)
    const expH = Math.round((m.egresos  / maxVal) * 86)
    const label = m.month ? m.month.slice(2).replace('-', '/') : '?'
    return `<div class="chart-group">
      <div class="chart-bars">
        <div class="chart-bar chart-bar-income"  style="height:${incH}px" title="Ingresos: ${fmtCurrency(m.ingresos)}"></div>
        <div class="chart-bar chart-bar-expense" style="height:${expH}px" title="Egresos: ${fmtCurrency(m.egresos)}"></div>
      </div>
      <div class="chart-month-label">${label}</div>
    </div>`
  }).join('')
}

function renderTable(transactions) {
  const tbody = document.getElementById('tableBody')
  tbody.innerHTML = ''

  if (!transactions || transactions.length === 0) {
    showEmpty()
    return
  }

  hideEmpty()
  transactions.forEach(tx => tbody.appendChild(buildRow(tx)))
}

function buildRow(tx) {
  const tr = document.createElement('tr')

  const typeBadge = tx.type === 'ingreso'
    ? `<span class="badge badge-income">Ingreso</span>`
    : `<span class="badge badge-expense">Egreso</span>`

  const catBadge = tx.category
    ? `<span class="badge badge-category">${esc(tx.category)}</span>`
    : '—'

  const amountClass = tx.type === 'ingreso' ? 'color:var(--income-text)' : 'color:var(--expense-text)'
  const amountSign  = tx.type === 'ingreso' ? '+' : '-'

  tr.innerHTML = `
    <td>${typeBadge}</td>
    <td class="td-img"></td>
    <td class="td-date">${fmtDate(tx.date || tx.created_at)}</td>
    <td class="td-provider">${esc(tx.provider || 'Sin nombre')}</td>
    <td>${catBadge}</td>
    <td class="td-amount" style="${amountClass}">${amountSign}${fmtCurrency(tx.amount, tx.currency)}</td>
    <td class="td-time">${fmtRelative(tx.created_at)}</td>
  `

  tr.querySelector('.td-img').appendChild(buildThumb(tx))
  return tr
}

function buildThumb(tx) {
  if (!tx.image_file) {
    const s = document.createElement('span')
    s.style.color = 'var(--text-3)'
    s.style.fontSize = '11px'
    s.textContent = '—'
    return s
  }

  const url = `/images/${tx.image_file}`
  const wrap = document.createElement('div')
  wrap.className = 'thumb-wrap'

  const img = document.createElement('img')
  img.className = 'thumb'
  img.src = url
  img.alt = 'doc'
  img.addEventListener('click', () => openImageModal(url, tx.image_file))

  const dl = document.createElement('a')
  dl.className = 'thumb-dl'
  dl.href = url
  dl.download = tx.image_file
  dl.title = 'Descargar'
  dl.textContent = '↓'
  dl.addEventListener('click', e => e.stopPropagation())

  wrap.appendChild(img)
  wrap.appendChild(dl)
  return wrap
}

// ── Period Filter ──────────────────────────────────────────

function filterByPeriod(txs, { start, end }) {
  const s = new Date(start)
  const e = new Date(end + 'T23:59:59')
  return txs.filter(tx => {
    const d = new Date(tx.created_at)
    return d >= s && d <= e
  })
}

document.getElementById('btnFilter').addEventListener('click', () => {
  const start = document.getElementById('periodStart').value
  const end   = document.getElementById('periodEnd').value
  if (!start || !end) return toast('Selecciona fecha inicio y fin')
  activePeriod = { start, end }
  const filtered = filterByPeriod(allTransactions, activePeriod)
  const ingresos = filtered.filter(t => t.type === 'ingreso').reduce((s, t) => s + (t.amount ?? 0), 0)
  const egresos  = filtered.filter(t => t.type === 'egreso').reduce((s, t) => s + (t.amount ?? 0), 0)
  renderStats({ ingresos, egresos, balance: ingresos - egresos, count: filtered.length })
  renderTable(filtered)
  setText('tableSubtitle', `${start} — ${end}`)
})

document.getElementById('btnClear').addEventListener('click', () => {
  activePeriod = null
  document.getElementById('periodStart').value = ''
  document.getElementById('periodEnd').value   = ''
  renderStats(monthStats)
  renderTable(allTransactions)
  setText('tableSubtitle', 'Todas las transacciones')
  updateHeaderBalance()
})

// ── Report Modal ───────────────────────────────────────────

document.getElementById('btnReport').addEventListener('click', async () => {
  const btn = document.getElementById('btnReport')
  btn.disabled = true
  btn.textContent = 'Generando...'

  openModal('reportModal')
  document.getElementById('reportBody').textContent = 'Analizando sus finanzas con IA...'

  try {
    const body = activePeriod
      ? { start: activePeriod.start, end: activePeriod.end }
      : {}

    const res = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const { report } = await res.json()
    document.getElementById('reportBody').textContent = report || 'No se pudo generar el informe.'
  } catch {
    document.getElementById('reportBody').textContent = 'Error generando el informe. Verifica que haya transacciones registradas.'
  } finally {
    btn.disabled = false
    btn.textContent = 'Generar informe'
  }
})

document.getElementById('btnCopyReport').addEventListener('click', () => {
  const text = document.getElementById('reportBody').textContent
  navigator.clipboard.writeText(text).then(() => toast('Informe copiado al portapapeles'))
})

document.getElementById('reportModalClose').addEventListener('click', () => closeModal('reportModal'))

// ── Image Modal ────────────────────────────────────────────

function openImageModal(url, filename) {
  document.getElementById('modalImage').src = url
  document.getElementById('btnDownload').href = url
  document.getElementById('btnDownload').download = filename
  openModal('imageModal')
}

document.getElementById('imageModalClose').addEventListener('click', () => closeModal('imageModal'))

// ── Modal helpers ──────────────────────────────────────────

function openModal(id)  { document.getElementById(id).classList.add('open') }
function closeModal(id) {
  document.getElementById(id).classList.remove('open')
  if (id === 'imageModal') document.getElementById('modalImage').src = ''
}

document.querySelectorAll('.modal-backdrop').forEach(el => {
  el.addEventListener('click', e => { if (e.target === el) closeModal(el.id) })
})

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-backdrop.open').forEach(el => closeModal(el.id))
  }
})

// ── Status ─────────────────────────────────────────────────

function setStatus(state) {
  const dot   = document.getElementById('statusDot')
  const label = document.getElementById('statusLabel')
  const map = {
    disconnected: ['',          'Desconectado'],
    scanning:     ['scanning',  'Esperando escaneo'],
    connected:    ['connected', 'Conectado']
  }
  const [cls, text] = map[state] || map.disconnected
  dot.className   = `status-dot ${cls}`.trim()
  label.textContent = text
}

// ── Empty state ─────────────────────────────────────────────

function showEmpty() { document.getElementById('emptyState').style.display = 'block' }
function hideEmpty() { document.getElementById('emptyState').style.display = 'none'  }

// ── Toast ──────────────────────────────────────────────────

let toastTimer = null
function toast(msg) {
  const el = document.getElementById('toast')
  el.textContent = msg
  el.classList.add('show')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000)
}

// ── Formatters ─────────────────────────────────────────────

function fmtCurrency(amount, currency = 'COP') {
  if (amount == null) return 'N/D'
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: currency || 'COP',
      maximumFractionDigits: 0
    }).format(amount)
  } catch {
    return `${amount} ${currency}`
  }
}

function fmtDate(str) {
  if (!str) return '—'
  try {
    const d = new Date(str.includes('T') ? str : str + 'T00:00:00')
    return new Intl.DateTimeFormat('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }).format(d)
  } catch { return str }
}

function fmtRelative(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    const diff = Math.floor((Date.now() - d) / 1000)
    if (diff < 60)    return 'Ahora'
    if (diff < 3600)  return `Hace ${Math.floor(diff / 60)} min`
    if (diff < 86400) return `Hace ${Math.floor(diff / 3600)} h`
    return fmtDate(iso)
  } catch { return iso }
}

function esc(str) {
  const d = document.createElement('div')
  d.textContent = str
  return d.innerHTML
}

function setText(id, val) {
  const el = document.getElementById(id)
  if (el) el.textContent = val
}

// ── Init ───────────────────────────────────────────────────

connect()
