const CONFIG = {
  SPREADSHEET_ID: '1Vw0rBiUT_I19f1rzkFxPPw5wLuIY0zD3Im04t42NKtM',
};

// ───────────────────── КОЛОНКИ (порядок как просил) ─────────────────────
// source: точное имя колонки в raw_договоры, либо auto:ключ — ищется по заголовкам
const COLUMNS = [
  { key: 'object',     label: 'Объект',     source: 'объект' },
  { key: 'id',         label: 'ID',         source: 'id A' },
  { key: 'work',       label: 'Работа',     source: 'работа' },
  { key: 'contractor', label: 'Подрядчик',  source: 'подрядчик' },
  { key: 'contract',   label: 'Договор',    source: 'auto:договор' },
  { key: 'date',       label: 'Дата',       source: 'auto:дата',     isDate: true },
  { key: 'cost',       label: 'Стоимость',  source: 'стоимость',     isMoney: true },
  { key: 'paid',       label: 'Оплачено',   source: 'оплачено',      isMoney: true },
  { key: 'ksSum',      label: 'Сумма КС',   computed: true,          isMoney: true },
];

const state = {
  raw: { contracts: [], ks2: [] },
  ks2ByContract: new Map(),
  resolvedCols: {},          // { contract: 'настоящее_имя', date: '...' }
  filtered: [],
  filters: {
    contractor: new Set(),
    object:     new Set(),
    work:       new Set(),
    status:     new Set(),   // по умолчанию: только 'законтрактован'
  },
  search: '',
  sort: { key: 'cost', dir: 'desc' },
};

// ───────────────────── УТИЛИТЫ ─────────────────────
function toNum(v) {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  const s = String(v).replace(/\s/g, '').replace(',', '.').replace(/[^\d.\-]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function parseDate(v) {
  if (v instanceof Date) return v;
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
const fmtMoney = n => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(n || 0);
const fmtInt   = n => new Intl.NumberFormat('ru-RU').format(n || 0);
const fmtPct   = n => Number(n || 0).toFixed(1) + '%';

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const k in props) {
    const v = props[k];
    if (k === 'dataset') { if (v) Object.assign(e.dataset, v); }
    else if (k === 'style' && v && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else e[k] = v;
  }
  children.forEach(c => e.appendChild(c));
  return e;
}
function showFatal(msg, details) {
  console.error('[FATAL]', msg, details || '');
  document.getElementById('content').innerHTML =
    `<div class="error">Ошибка: ${msg}${details ? '\n\n' + details : ''}</div>`;
  document.getElementById('last-update').textContent = 'Ошибка';
}

// ───────────────────── ЗАГРУЗКА ─────────────────────
function csvUrl(sheet) {
  return `https://docs.google.com/spreadsheets/d/${CONFIG.SPREADSHEET_ID}` +
         `/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheet)}`;
}
async function loadSheet(sheet) {
  const url = csvUrl(sheet);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} для "${sheet}"`);
  const text = await res.text();
  if (/^\s*<\s*html/i.test(text) || /accounts\.google\.com/.test(text)) {
    throw new Error(`Лист "${sheet}": Google вернул HTML вместо CSV. Расшарь таблицу "Всем, у кого есть ссылка → Читатель".`);
  }
  const rows = Papa.parse(text, { header: true, skipEmptyLines: true }).data;
  return rows.map(r => {
    const o = {};
    for (const k in r) o[String(k).trim()] = r[k];
    return o;
  });
}

// Ищем "договор" и "дата" в заголовках, если нет точного совпадения
function resolveAutoColumns(headers) {
  const find = (re, exclude = []) => {
    for (const h of headers) {
      const low = h.toLowerCase();
      if (exclude.some(ex => low.includes(ex))) continue;
      if (re.test(low)) return h;
    }
    return null;
  };
  return {
    contract: find(/договор|контракт/i, ['статус', 'оплачено', 'сумма', 'стоимость']),
    date:     find(/дата/i,             ['кс', 'кs', 'платеж', 'оплат']),
  };
}

async function loadAll() {
  console.log('SPREADSHEET_ID =', CONFIG.SPREADSHEET_ID);
  const [contracts, ks2] = await Promise.all([
    loadSheet('raw_договоры'),
    loadSheet('raw_КС2'),
  ]);
  if (!contracts.length) throw new Error('raw_договоры пустой');

  state.raw.contracts = contracts;
  state.raw.ks2 = ks2;

  // Индекс сумм КС2 по договору (только строки с номером КС)
  const idx = new Map();
  ks2.forEach(k => {
    const id = String(k['id A'] || '').trim();
    if (!id) return;
    const ksNum = String(k['КС №'] ?? '').trim();
    if (!ksNum || ksNum === '0') return;
    const s = toNum(k['стоимость КС']);
    idx.set(id, (idx.get(id) || 0) + s);
  });
  state.ks2ByContract = idx;

  // Резолвим auto-колонки
  const headers = Object.keys(contracts[0] || {});
  const auto = resolveAutoColumns(headers);
  state.resolvedCols = auto;
  console.log('Auto columns:', auto);
  console.log(`Загружено: договоров ${contracts.length}, КС2 ${ks2.length}`);
}

// ───────────────────── ФИЛЬТРЫ ─────────────────────
function collectUnique(field) {
  const s = new Set();
  state.raw.contracts.forEach(c => {
    const v = String(c[field] || '').trim();
    if (v) s.add(v);
  });
  return [...s].sort((a, b) => a.localeCompare(b, 'ru'));
}

function initFilters() {
  // По умолчанию: только "законтрактован"
  const statuses = collectUnique('статус договора');
  const contracted = statuses.filter(s => s.toLowerCase() === 'законтрактован');
  state.filters.status = new Set(contracted.length ? contracted : statuses.slice(0, 1));

  renderSidebar();
}

function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.innerHTML = '';

  const FILTERS = [
    { key: 'contractor', title: 'Подрядчик', source: 'подрядчик' },
    { key: 'object',     title: 'Объект',    source: 'объект' },
    { key: 'work',       title: 'Работа',    source: 'работа' },
    { key: 'status',     title: 'Статус',    source: 'статус договора' },
  ];

  FILTERS.forEach(f => {
    const items = collectUnique(f.source);
    const isOpen = f.key === 'status' ? true : false; // статус открыт по умолчанию
    const selected = state.filters[f.key];

    const group = el('div', { className: 'filter-group' + (isOpen ? ' open' : '') });
    const header = el('div', { className: 'filter-header' });
    const titleWrap = el('div', { style: 'display:flex;align-items:center;gap:6px;flex:1;' });
    titleWrap.appendChild(el('span', { className: 'filter-title', textContent: f.title }));
    titleWrap.appendChild(el('span', { className: 'filter-count', textContent: `(${selected.size}/${items.length})` }));
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('class', 'filter-arrow');
    arrow.setAttribute('viewBox', '0 0 24 24');
    arrow.setAttribute('fill', 'none');
    arrow.setAttribute('stroke', 'currentColor');
    arrow.setAttribute('stroke-width', '2');
    arrow.innerHTML = '<polyline points="6 9 12 15 18 9"></polyline>';
    titleWrap.appendChild(arrow);
    header.appendChild(titleWrap);
    header.onclick = (e) => {
      if (e.target.closest('.filter-actions')) return;
      group.classList.toggle('open');
    };
    group.appendChild(header);

    const content = el('div', { className: 'filter-content' });
    const actionsWrap = el('div', { className: 'filter-actions-wrap' });
    const allBtn = el('span', { className: 'filter-actions', textContent: 'Все' });
    const noneBtn = el('span', { className: 'filter-actions', textContent: 'Ничего' });
    allBtn.onclick = () => { items.forEach(i => selected.add(i)); renderSidebar(); applyFilters(); };
    noneBtn.onclick = () => { selected.clear(); renderSidebar(); applyFilters(); };
    actionsWrap.appendChild(allBtn);
    actionsWrap.appendChild(noneBtn);
    content.appendChild(actionsWrap);

    const list = el('div', { className: 'checkbox-list' });
    items.forEach(item => {
      const lbl = el('label', { className: 'checkbox-item' });
      const cb = el('input', { type: 'checkbox' });
      cb.checked = selected.has(item);
      cb.onchange = () => {
        if (cb.checked) selected.add(item); else selected.delete(item);
        applyFilters();
        // обновляем счётчик
        const cnt = titleWrap.querySelector('.filter-count');
        if (cnt) cnt.textContent = `(${selected.size}/${items.length})`;
      };
      lbl.appendChild(cb);
      lbl.appendChild(el('span', { textContent: item, title: item }));
      list.appendChild(lbl);
    });
    content.appendChild(list);
    group.appendChild(content);
    sidebar.appendChild(group);
  });
}

// ───────────────────── ПРИМЕНЕНИЕ ФИЛЬТРОВ ─────────────────────
function applyFilters() {
  const f = state.filters;
  const q = state.search.toLowerCase().trim();

  state.filtered = state.raw.contracts.filter(c => {
    const status = String(c['статус договора'] || '').trim();
    if (!f.status.has(status)) return false;
    const cont = String(c['подрядчик'] || '').trim();
    if (f.contractor.size && !f.contractor.has(cont)) return false;
    const obj = String(c['объект'] || '').trim();
    if (f.object.size && !f.object.has(obj)) return false;
    const work = String(c['работа'] || '').trim();
    if (f.work.size && !f.work.has(work)) return false;
    if (q) {
      const hay = [
        c['id A'], c['объект'], c['работа'], c['подрядчик'],
        state.resolvedCols.contract ? c[state.resolvedCols.contract] : '',
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Сортировка
  const { key, dir } = state.sort;
  const mul = dir === 'desc' ? -1 : 1;
  state.filtered.sort((a, b) => {
    const va = getCellValue(a, key);
    const vb = getCellValue(b, key);
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
    return String(va).localeCompare(String(vb), 'ru') * mul;
  });

  renderTable();
  renderKPI();
  renderSubtitle();
}

function getCellValue(row, key) {
  const col = COLUMNS.find(c => c.key === key);
  if (!col) return '';
  if (col.key === 'ksSum') {
    const id = String(row['id A'] || '').trim();
    return state.ks2ByContract.get(id) || 0;
  }
  if (col.key === 'contract' && state.resolvedCols.contract) {
    return String(row[state.resolvedCols.contract] || '');
  }
  if (col.key === 'date' && state.resolvedCols.date) {
    return String(row[state.resolvedCols.date] || '');
  }
  return row[col.source] ?? '';
}

// ───────────────────── РЕНДЕР ─────────────────────
function renderSubtitle() {
  const total = state.raw.contracts.length;
  const shown = state.filtered.length;
  document.getElementById('table-subtitle').textContent =
    `Показано ${fmtInt(shown)} из ${fmtInt(total)} · статус: ${[...state.filters.status].join(', ') || '—'}`;
}

function renderKPI() {
  const grid = document.getElementById('kpi-grid');
  const totalCost = state.filtered.reduce((s, r) => s + toNum(r['стоимость']), 0);
  const totalPaid = state.filtered.reduce((s, r) => s + toNum(r['оплачено']), 0);
  const totalKS = state.filtered.reduce((s, r) => {
    const id = String(r['id A'] || '').trim();
    return s + (state.ks2ByContract.get(id) || 0);
  }, 0);
  const closePct = totalCost ? (totalKS / totalCost * 100).toFixed(1) : '0';

  grid.innerHTML = '';
  [
    { label: 'Договоров',      value: fmtInt(state.filtered.length) },
    { label: 'Стоимость',      value: fmtMoney(totalCost) + ' ₽' },
    { label: 'Оплачено',       value: fmtMoney(totalPaid) + ' ₽' },
    { label: 'Сумма КС',       value: fmtMoney(totalKS) + ' ₽', sub: `закрытие ${closePct}%` },
  ].forEach(item => {
    const card = el('div', { className: 'kpi-card' });
    card.appendChild(el('div', { className: 'kpi-label', textContent: item.label }));
    card.appendChild(el('div', { className: 'kpi-value', textContent: item.value }));
    if (item.sub) card.appendChild(el('div', { className: 'kpi-label', textContent: item.sub, style: 'margin-top:4px;color:var(--success);text-transform:none;' }));
    grid.appendChild(card);
  });
}

function renderTable() {
  const thead = document.getElementById('thead');
  const tbody = document.getElementById('tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  // Заголовок
  const tr = document.createElement('tr');
  COLUMNS.forEach(col => {
    const isSorted = state.sort.key === col.key;
    const mark = isSorted ? (state.sort.dir === 'desc' ? ' ▼' : ' ▲') : ' ⇅';
    const th = el('th', {
      textContent: col.label,
      className: 'sortable' + (isSorted ? ' sorted' : ''),
    });
    const m = el('span', { className: 'sort-mark', textContent: mark });
    th.appendChild(m);
    th.onclick = () => {
      if (state.sort.key === col.key) state.sort.dir = state.sort.dir === 'desc' ? 'asc' : 'desc';
      else { state.sort.key = col.key; state.sort.dir = 'desc'; }
      applyFilters();
    };
    tr.appendChild(th);
  });
  thead.appendChild(tr);

  // Тело
  if (!state.filtered.length) {
    tbody.innerHTML = '<tr><td colspan="' + COLUMNS.length + '" class="note">Нет договоров под текущие фильтры</td></tr>';
    return;
  }

  const frag = document.createDocumentFragment();
  state.filtered.forEach(row => {
    const tr = document.createElement('tr');
    COLUMNS.forEach(col => {
      const val = getCellValue(row, col.key);
      let display = '', cls = '';
      if (col.key === 'id') { display = String(val || '—'); cls = 'id-cell'; }
      else if (col.isMoney) { display = fmtMoney(val); cls = 'num'; }
      else if (col.isDate) {
        const d = parseDate(val);
        display = d ? `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}` : (val || '—');
      } else {
        display = String(val || '—');
        if (!val) cls = 'muted';
      }
      const td = el('td', { textContent: display, className: cls });
      tr.appendChild(td);
    });
    frag.appendChild(tr);
  });
  tbody.appendChild(frag);
}

// ───────────────────── ЭКСПОРТ (CSV) ─────────────────────
document.getElementById('btn-export').onclick = () => {
  if (!state.filtered.length) return;
  const rows = [COLUMNS.map(c => c.label)];
  state.filtered.forEach(r => {
    rows.push(COLUMNS.map(c => {
      const v = getCellValue(r, c.key);
      if (c.isMoney) return toNum(v);
      return String(v ?? '');
    }));
  });
  const csv = rows.map(row => row.map(cell => {
    const s = String(cell);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(';')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `договоры_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

// ───────────────────── ПОИСК ─────────────────────
document.getElementById('search').addEventListener('input', e => {
  state.search = e.target.value;
  applyFilters();
});

// ───────────────────── СТАРТ ─────────────────────
(async function init() {
  try {
    if (typeof Papa === 'undefined') throw new Error('PapaParse не загрузился (CDN заблокирован)');
    if (!CONFIG.SPREADSHEET_ID || CONFIG.SPREADSHEET_ID === 'PASTE_DEST_SPREADSHEET_ID_HERE') {
      throw new Error('Задай SPREADSHEET_ID в app.js');
    }
    document.getElementById('last-update').textContent = 'Загрузка данных…';
    await loadAll();
    initFilters();
    applyFilters();
    document.getElementById('btn-export').disabled = false;
    document.getElementById('last-update').textContent =
      'Обновлено: ' + new Date().toLocaleString('ru-RU');
  } catch (e) {
    showFatal(e.message, e.stack);
  }
})();
