const CONFIG = {
  // ⚠️ ID таблицы-приёмника (где лежат raw_* и agg_*). Не источника!
  SPREADSHEET_ID: '1Vw0rBiUT_I19f1rzkFxPPw5wLuIY0zD3Im04t42NKtM',
};

const state = {
  raw: { contracts: [], ks2: [], payments: [] },
  serverAgg: {},
  agg: { contractors: [], objects: [], works: [], months: [], statuses: [] },
  filteredRaw: { contracts: [], ks2: [], payments: [] },
  filters: { contractor: '', object: '', status: '', dateFrom: '', dateTo: '' },
  charts: {},
  sort: {},
  currentTab: 'overview',
  paymentLinkMode: 'none',
  contractById: new Map(),
};

// ==================== ВИДИМЫЕ ОШИБКИ ====================
function logStage(stage) {
  console.log('[stage]', stage);
  const lu = document.getElementById('last-update');
  if (lu) lu.textContent = 'Загрузка: ' + stage + '…';
}

function showFatal(msg, details) {
  console.error('[FATAL]', msg, details || '');
  const content = document.getElementById('content');
  if (content) {
    content.innerHTML = '';
    const container = document.createElement('div');
    container.className = 'container';
    const box = document.createElement('div');
    box.className = 'error';
    box.textContent = 'Ошибка: ' + msg + (details ? '\n\n' + details : '');
    container.appendChild(box);
    content.appendChild(container);
  }
  const lu = document.getElementById('last-update');
  if (lu) lu.textContent = 'Ошибка';
}

// ==================== UTILS ====================
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
function hasKSNumber(ks) {
  if (ks === '' || ks === null || ks === undefined) return false;
  if (typeof ks === 'number') return ks !== 0;
  const s = String(ks).trim();
  return s !== '' && s !== '0';
}
const fmtMoney = n => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(n || 0) + ' ₽';
const fmtInt   = n => new Intl.NumberFormat('ru-RU').format(n || 0);
const fmtPct   = n => Number(n || 0).toFixed(1) + '%';

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const k in props) {
    const v = props[k];
    if (k === 'dataset') {
      if (v) Object.assign(e.dataset, v);
    } else if (k === 'style' && v && typeof v === 'object') {
      Object.assign(e.style, v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      e.addEventListener(k.slice(2).toLowerCase(), v);
    } else {
      e[k] = v;
    }
  }
  children.forEach(c => e.appendChild(c));
  return e;
}
function chartCanvas(id, h) {
  const wrap = el('div', { className: 'chart-wrap' });
  if (h) wrap.style.height = h;
  const cv = el('canvas'); cv.id = id;
  wrap.appendChild(cv);
  return wrap;
}

// ==================== LOADING ====================
function csvUrl(sheet) {
  return `https://docs.google.com/spreadsheets/d/${CONFIG.SPREADSHEET_ID}` +
         `/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheet)}`;
}
async function loadSheet(sheet) {
  const url = csvUrl(sheet);
  console.log('→ fetch', url);
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (e) {
    throw new Error(`Сеть не отвечает для листа "${sheet}": ${e.message}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} для листа "${sheet}" (${url})`);
  const text = await res.text();
  if (/^\s*<\s*html/i.test(text) || /accounts\.google\.com/.test(text)) {
    throw new Error(`Лист "${sheet}": Google вернул HTML вместо CSV.\n` +
                    `Скорее всего таблица не расшарена «Всем, у кого есть ссылка → Читатель».\n` +
                    `Проверь: ${url}`);
  }
  const rows = Papa.parse(text, { header: true, skipEmptyLines: true }).data;
  if (!rows.length) throw new Error(`Лист "${sheet}": 0 строк данных`);
  return rows.map(r => {
    const o = {};
    for (const k in r) o[String(k).trim()] = r[k];
    return o;
  });
}
async function loadAll() {
  logStage('загрузка листов');
  const [contracts, ks2, payments,
         sContractors, sObjects, sWorks, sMonths, sStatuses] = await Promise.all([
    loadSheet('raw_договоры'), loadSheet('raw_КС2'), loadSheet('raw_оплаты'),
    loadSheet('agg_подрядчики'), loadSheet('agg_объекты'),
    loadSheet('agg_работы'), loadSheet('agg_по_месяцам'), loadSheet('agg_статусы'),
  ]);
  state.raw = { contracts, ks2, payments };
  state.serverAgg = {
    contractors: sContractors, objects: sObjects, works: sWorks,
    months: sMonths, statuses: sStatuses,
  };
  contracts.forEach(c => {
    const id = String(c['id A'] || '').trim();
    if (id) state.contractById.set(id, c);
  });
  detectPaymentLinkMode();
  console.log('✓ данные загружены:', {
    договоры: contracts.length, КС2: ks2.length, оплаты: payments.length,
  });
}

// ==================== СВЯЗЬ ОПЛАТ ====================
function getPaymentContractId(p) {
  return String(p['id A'] || p['id договора'] || p['договор'] || p['ID'] || '').trim();
}
function getPaymentContractor(p) {
  return String(p['подрядчик'] || p['контрагент'] || '').trim();
}
function getPaymentObject(p) {
  return String(p['объект'] || '').trim();
}
function detectPaymentLinkMode() {
  if (!state.raw.payments.length) { state.paymentLinkMode = 'none'; return; }
  const p = state.raw.payments[0];
  if (p['id A'] !== undefined || p['id договора'] !== undefined || p['договор'] !== undefined) {
    state.paymentLinkMode = 'idA'; return;
  }
  if (p['подрядчик'] !== undefined || p['контрагент'] !== undefined) {
    state.paymentLinkMode = 'contractor'; return;
  }
  state.paymentLinkMode = 'none';
}

// ==================== АГРЕГАЦИЯ ====================
function aggByContractor(contracts, ks2) {
  const map = new Map();
  const init = name => ({
    подрядчик: name, договоров_всего: 0, законтрактовано: 0, переподписано: 0, отменено: 0,
    сумма_договоров: 0, сумма_оплат: 0, процент_переподписанных: 0, отчетов_кол: 0,
    отчетов_процент: 0, кс2_кол: 0, кс2_сумма: 0, оплачено_кол: 0, оплачено_сумма: 0,
    в_работе_кол: 0, в_работе_сумма: 0, площадка_кол: 0, офис_кол: 0, закрытие_кс2: 0,
    объектов_шт: 0, работ_шт: 0, _objects: {}, _works: {},
  });
  const get = n => { if (!map.has(n)) map.set(n, init(n)); return map.get(n); };
  contracts.forEach(c => {
    if (!String(c['id A'] || '').trim()) return;
    const name = String(c['подрядчик'] || '').trim();
    if (!name) return;
    const m = get(name);
    const status = String(c['статус договора'] || '').trim();
    const stLower = status.toLowerCase();
    const cost = toNum(c['стоимость']);
    const hasCost = cost !== 0;
    if (status && hasCost) m.договоров_всего++;
    if (stLower === 'законтрактован' && hasCost) {
      m.законтрактовано++;
      m.сумма_договоров += cost;
      m.сумма_оплат += toNum(c['оплачено']);
      if (c['отчет']) m.отчетов_кол++;
      if (c['объект']) m._objects[String(c['объект'])] = 1;
      if (c['работа']) m._works[String(c['работа'])] = 1;
    } else if (stLower === 'переподписан' && hasCost) {
      m.переподписано++;
    }
  });
  const SITE = ['инженер ск', 'подрядчик', 'ск рвб', 'площадка пто'];
  const OFFICE = ['офис пто', 'площадка рс', 'рп заявка', 'фск', 'фск оплата'];
  ks2.forEach(k => {
    if (!String(k['id A'] || '').trim()) return;
    const name = String(k['подрядчик'] || '').trim();
    if (!name) return;
    if (!hasKSNumber(k['КС №'])) return;
    const m = get(name);
    const cost = toNum(k['стоимость КС']);
    const stLower = String(k['статус'] || '').trim().toLowerCase();
    m.кс2_кол++; m.кс2_сумма += cost;
    if (stLower === 'оплачено') { m.оплачено_кол++; m.оплачено_сумма += cost; }
    else { m.в_работе_кол++; m.в_работе_сумма += cost; }
    if (SITE.indexOf(stLower) !== -1) m.площадка_кол++;
    if (OFFICE.indexOf(stLower) !== -1) m.офис_кол++;
  });
  const result = [];
  map.forEach(m => {
    m.отменено = m.договоров_всего - m.законтрактовано - m.переподписано;
    m.процент_переподписанных = m.договоров_всего > 0 ? +(m.переподписано / m.договоров_всего * 100).toFixed(1) : 0;
    m.отчетов_процент = m.законтрактовано > 0 ? +(m.отчетов_кол / m.законтрактовано * 100).toFixed(1) : 0;
    m.закрытие_кс2 = m.сумма_договоров > 0 ? +(m.кс2_сумма / m.сумма_договоров * 100).toFixed(1) : 0;
    m.объектов_шт = Object.keys(m._objects).length;
    m.работ_шт = Object.keys(m._works).length;
    delete m._objects; delete m._works;
    result.push(m);
  });
  result.sort((a, b) => b.сумма_договоров - a.сумма_договоров);
  return result;
}

function aggByObject(contracts, ks2) {
  const map = new Map();
  const get = name => {
    if (!map.has(name)) map.set(name, {
      объект: name, договоров_всего: 0, законтрактовано: 0, сумма_договоров: 0,
      сумма_оплат: 0, кс2_кол: 0, кс2_сумма: 0, закрытие_кс2: 0,
      подрядчиков_шт: 0, работ_шт: 0, _contractors: {}, _works: {},
    });
    return map.get(name);
  };
  contracts.forEach(c => {
    if (!String(c['id A'] || '').trim()) return;
    const obj = String(c['объект'] || '').trim();
    if (!obj) return;
    const m = get(obj);
    const status = String(c['статус договора'] || '').trim().toLowerCase();
    const cost = toNum(c['стоимость']);
    const hasCost = cost !== 0;
    if (!status || !hasCost) return;
    m.договоров_всего++;
    if (status === 'законтрактован') {
      m.законтрактовано++;
      m.сумма_договоров += cost;
      m.сумма_оплат += toNum(c['оплачено']);
      if (c['подрядчик']) m._contractors[String(c['подрядчик'])] = 1;
      if (c['работа']) m._works[String(c['работа'])] = 1;
    }
  });
  ks2.forEach(k => {
    if (!String(k['id A'] || '').trim()) return;
    if (!hasKSNumber(k['КС №'])) return;
    const obj = String(k['объект'] || '').trim();
    if (!obj) return;
    const m = get(obj);
    m.кс2_кол++; m.кс2_сумма += toNum(k['стоимость КС']);
  });
  const result = [];
  map.forEach(m => {
    m.закрытие_кс2 = m.сумма_договоров > 0 ? +(m.кс2_сумма / m.сумма_договоров * 100).toFixed(1) : 0;
    m.подрядчиков_шт = Object.keys(m._contractors).length;
    m.работ_шт = Object.keys(m._works).length;
    delete m._contractors; delete m._works;
    result.push(m);
  });
  result.sort((a, b) => b.сумма_договоров - a.сумма_договоров);
  return result;
}

function aggByWork(contracts) {
  const map = new Map();
  contracts.forEach(c => {
    if (!String(c['id A'] || '').trim()) return;
    const work = String(c['работа'] || '').trim();
    if (!work) return;
    if (!map.has(work)) map.set(work, {
      работа: work, договоров_всего: 0, сумма_договоров: 0,
      подрядчиков_шт: 0, объектов_шт: 0, _contractors: {}, _objects: {},
    });
    const m = map.get(work);
    const status = String(c['статус договора'] || '').trim().toLowerCase();
    const cost = toNum(c['стоимость']);
    if (!status || cost === 0) return;
    m.договоров_всего++;
    if (status === 'законтрактован') {
      m.сумма_договоров += cost;
      if (c['подрядчик']) m._contractors[String(c['подрядчик'])] = 1;
      if (c['объект']) m._objects[String(c['объект'])] = 1;
    }
  });
  const result = [];
  map.forEach(m => {
    m.подрядчиков_шт = Object.keys(m._contractors).length;
    m.объектов_шт = Object.keys(m._objects).length;
    delete m._contractors; delete m._objects;
    result.push(m);
  });
  result.sort((a, b) => b.сумма_договоров - a.сумма_договоров);
  return result;
}

function aggByMonth(ks2, payments) {
  const map = new Map();
  const get = (y, mo) => {
    const key = `${y}-${String(mo).padStart(2, '0')}`;
    if (!map.has(key)) map.set(key, {
      период: key, год: y, месяц: mo,
      кс2_кол: 0, кс2_сумма: 0, оплат_кол: 0, оплат_сумма: 0,
    });
    return map.get(key);
  };
  ks2.forEach(k => {
    if (!hasKSNumber(k['КС №'])) return;
    const d = parseDate(k['дата КС']);
    if (!d) return;
    const m = get(d.getFullYear(), d.getMonth() + 1);
    m.кс2_кол++; m.кс2_сумма += toNum(k['стоимость КС']);
  });
  payments.forEach(p => {
    const d = parseDate(p['дата']);
    if (!d) return;
    const m = get(d.getFullYear(), d.getMonth() + 1);
    m.оплат_кол++; m.оплат_сумма += toNum(p['сумма']);
  });
  const result = [];
  map.forEach(m => result.push(m));
  result.sort((a, b) => a.период.localeCompare(b.период));
  return result;
}

function aggByStatus(contracts, ks2) {
  const sd = new Map(), sk = new Map();
  contracts.forEach(c => {
    if (!String(c['id A'] || '').trim()) return;
    const st = String(c['статус договора'] || '').trim();
    if (!st) return;
    sd.set(st, (sd.get(st) || 0) + 1);
  });
  ks2.forEach(k => {
    if (!String(k['id A'] || '').trim()) return;
    if (!hasKSNumber(k['КС №'])) return;
    const st = String(k['статус'] || '').trim() || '(пусто)';
    sk.set(st, (sk.get(st) || 0) + 1);
  });
  const result = [];
  sd.forEach((cnt, st) => result.push({ источник: 'договоры', статус: st, количество: cnt }));
  sk.forEach((cnt, st) => result.push({ источник: 'КС2', статус: st, количество: cnt }));
  return result;
}

// ==================== ФИЛЬТРЫ ====================
function collectUnique(arr, field) {
  const s = new Set();
  arr.forEach(r => {
    const v = String(r[field] || '').trim();
    if (v) s.add(v);
  });
  return [...s];
}
function populateFilters() {
  const selC = document.getElementById('f-contractor');
  const selO = document.getElementById('f-object');
  const selS = document.getElementById('f-status');
  const allContractors = new Set([
    ...collectUnique(state.raw.contracts, 'подрядчик'),
    ...collectUnique(state.raw.ks2, 'подрядчик'),
  ]);
  state.raw.payments.forEach(p => { if (getPaymentContractor(p)) allContractors.add(getPaymentContractor(p)); });
  const objects = [...new Set([
    ...collectUnique(state.raw.contracts, 'объект'),
    ...collectUnique(state.raw.ks2, 'объект'),
    ...state.raw.payments.map(getPaymentObject).filter(Boolean),
  ])].sort((a, b) => a.localeCompare(b, 'ru'));
  const statuses = collectUnique(state.raw.contracts, 'статус договора')
    .sort((a, b) => a.localeCompare(b, 'ru'));

  [...allContractors].sort((a, b) => a.localeCompare(b, 'ru'))
    .forEach(v => selC.appendChild(el('option', { value: v, textContent: v })));
  objects.forEach(v => selO.appendChild(el('option', { value: v, textContent: v })));
  statuses.forEach(v => selS.appendChild(el('option', { value: v, textContent: v })));
}
function readFiltersFromUI() {
  state.filters = {
    contractor: document.getElementById('f-contractor').value,
    object:     document.getElementById('f-object').value,
    status:     document.getElementById('f-status').value,
    dateFrom:   document.getElementById('f-date-from').value,
    dateTo:     document.getElementById('f-date-to').value,
  };
}
function applyFilters() {
  const f = state.filters;
  const filterContract = c => {
    if (!String(c['id A'] || '').trim()) return false;
    if (f.contractor && String(c['подрядчик'] || '').trim() !== f.contractor) return false;
    if (f.object     && String(c['объект']    || '').trim() !== f.object)     return false;
    if (f.status     && String(c['статус договора'] || '').trim() !== f.status) return false;
    return true;
  };
  const filterKS2 = k => {
    if (!String(k['id A'] || '').trim()) return false;
    if (!hasKSNumber(k['КС №'])) return false;
    if (f.contractor && String(k['подрядчик'] || '').trim() !== f.contractor) return false;
    if (f.object     && String(k['объект']    || '').trim() !== f.object)     return false;
    if (f.dateFrom || f.dateTo) {
      const d = parseDate(k['дата КС']);
      if (!d) return false;
      if (f.dateFrom && d < new Date(f.dateFrom)) return false;
      if (f.dateTo   && d > new Date(f.dateTo))   return false;
    }
    return true;
  };
  const filterPayment = p => {
    if (f.contractor && getPaymentContractor(p) && getPaymentContractor(p) !== f.contractor) return false;
    if (f.object     && getPaymentObject(p)     && getPaymentObject(p)     !== f.object)     return false;
    if (f.dateFrom || f.dateTo) {
      const d = parseDate(p['дата']);
      if (!d) return false;
      if (f.dateFrom && d < new Date(f.dateFrom)) return false;
      if (f.dateTo   && d > new Date(f.dateTo))   return false;
    }
    return true;
  };

  state.filteredRaw = {
    contracts: state.raw.contracts.filter(filterContract),
    ks2:       state.raw.ks2.filter(filterKS2),
    payments:  state.raw.payments.filter(filterPayment),
  };
  state.agg = {
    contractors: aggByContractor(state.filteredRaw.contracts, state.filteredRaw.ks2),
    objects:     aggByObject(state.filteredRaw.contracts, state.filteredRaw.ks2),
    works:       aggByWork(state.filteredRaw.contracts),
    months:      aggByMonth(state.filteredRaw.ks2, state.filteredRaw.payments),
    statuses:    aggByStatus(state.filteredRaw.contracts, state.filteredRaw.ks2),
  };

  const st = document.getElementById('filter-status');
  const active = Object.values(f).filter(Boolean).length;
  st.textContent = active
    ? `Фильтров: ${active} · договоров ${state.filteredRaw.contracts.length} · КС2 ${state.filteredRaw.ks2.length} · оплат ${state.filteredRaw.payments.length}`
    : '';
}

function validateAgainstServer() {
  const srvSum = state.serverAgg.contractors.reduce((s, r) => s + toNum(r.сумма_договоров), 0);
  const cliSum = state.agg.contractors.reduce((s, r) => s + r.сумма_договоров, 0);
  const diff = Math.abs(srvSum - cliSum);
  if (diff > 1) {
    console.warn(`⚠️ Клиентская агрегация расходится с серверной: сервер=${srvSum}, клиент=${cliSum}, разница=${diff}`);
  } else {
    console.log(`✓ Агрегация совпадает с сервером (${srvSum})`);
  }
  console.log(`Режим связи оплат: ${state.paymentLinkMode}`);
}

// ==================== ТАБЛИЦЫ ====================
function detectNumeric(rows, key) {
  return rows.slice(0, Math.min(50, rows.length)).every(v => {
    const x = v[key];
    if (x === '' || x == null) return true;
    return !isNaN(parseFloat(String(x).replace(/\s/g, '').replace(',', '.')));
  });
}
function sortRows(rows, key, dir) {
  if (!key) return rows;
  const numeric = detectNumeric(rows, key);
  const mul = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (numeric) return (toNum(a[key]) - toNum(b[key])) * mul;
    return String(a[key] ?? '').localeCompare(String(b[key] ?? ''), 'ru') * mul;
  });
}
function renderTable(rows, cols, parent, opts = {}) {
  const { onRowClick, onSort, sortKey, sortDir } = opts;
  if (!rows.length) {
    parent.appendChild(el('div', { className: 'note', textContent: 'Нет данных' }));
    return;
  }
  const t = el('table', { className: 'data-table' });
  const hr = t.createTHead().insertRow();
  cols.forEach(c => {
    let label = c.label;
    if (onSort && c.sortable !== false) {
      const mark = sortKey === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      label = c.label + mark;
    }
    const th = el('th', { textContent: label });
    if (onSort && c.sortable !== false) {
      th.classList.add('sortable');
      th.onclick = () => onSort(c.key);
    }
    hr.appendChild(th);
  });
  const tb = t.createTBody();
  rows.forEach(r => {
    const tr = tb.insertRow();
    if (onRowClick) {
      tr.classList.add('clickable');
      tr.onclick = () => onRowClick(r);
    }
    cols.forEach(c => {
      const td = tr.insertCell();
      const v = r[c.key];
      td.textContent = c.format ? c.format(v) : (v ?? '');
    });
  });
  parent.appendChild(t);
}
function autoColumns(rows, moneyRe = /сумм|стоим|оплач|цена|итог/i) {
  if (!rows.length) return [];
  const keys = Object.keys(rows[0]).filter(k => k && !k.startsWith('_'));
  return keys.map(k => ({
    key: k,
    label: k,
    format: moneyRe.test(k) ? fmtMoney : undefined,
  }));
}
function kpiGrid(items) {
  const g = el('div', { className: 'kpi-grid' });
  items.forEach(({ label, value, sub }) => {
    const card = el('div', { className: 'kpi-card' });
    card.appendChild(el('div', { className: 'kpi-label', textContent: label }));
    card.appendChild(el('div', { className: 'kpi-value', textContent: value }));
    if (sub) card.appendChild(el('div', { className: 'kpi-sub', textContent: sub }));
    g.appendChild(card);
  });
  return g;
}

// ==================== ВКЛАДКИ ====================
const TABS = [
  { id: 'overview',    title: 'Обзор',       render: renderOverview },
  { id: 'contractors', title: 'Подрядчики',  render: renderContractors },
  { id: 'objects',     title: 'Объекты',     render: renderObjects },
  { id: 'contracts',   title: 'Договоры',    render: renderContracts },
  { id: 'payments',    title: 'Оплаты',      render: renderPayments },
  { id: 'works',       title: 'Работы',      render: renderWorks },
  { id: 'months',      title: 'По месяцам',  render: renderMonths },
  { id: 'statuses',    title: 'Статусы',     render: renderStatuses },
];
function buildTabs() {
  const nav = document.getElementById('tabs');
  nav.innerHTML = '';
  TABS.forEach((tab, i) => {
    const b = el('button', {
      className: 'nav-btn' + (i === 0 ? ' active' : ''),
      textContent: tab.title,
      dataset: { tab: tab.id },
    });
    b.onclick = () => activate(tab.id);
    nav.appendChild(b);
  });
}
function activate(id) {
  state.currentTab = id;
  document.querySelectorAll('#tabs button')
    .forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  Object.values(state.charts).forEach(c => {
    try { c.destroy(); } catch (e) {}
  });
  state.charts = {};
  const content = document.getElementById('content');
  content.innerHTML = '';
  const container = el('div', { className: 'container' });
  content.appendChild(container);
  TABS.find(t => t.id === id).render(container);
}

// ==================== OVERVIEW ====================
function renderOverview(root) {
  const c = state.agg.contractors;
  const sumDog  = c.reduce((s, r) => s + r.сумма_договоров, 0);
  const sumKS2  = c.reduce((s, r) => s + r.кс2_сумма, 0);
  const sumPaid = state.filteredRaw.payments.reduce((s, p) => s + toNum(p['сумма']), 0);
  const close   = sumDog ? (sumKS2 / sumDog * 100).toFixed(1) : 0;

  root.appendChild(kpiGrid([
    { label: 'Подрядчиков',     value: fmtInt(c.length) },
    { label: 'Сумма договоров', value: fmtMoney(sumDog) },
    { label: 'Сумма КС2',       value: fmtMoney(sumKS2), sub: `закрытие ${close}%` },
    { label: 'Оплат (факт)',    value: fmtMoney(sumPaid) },
  ]));

  const grid = el('div', { className: 'charts-grid' });
  const top = [...c].slice(0, 10);
  const m = [...state.agg.months];
  const st = state.agg.statuses.filter(r => r.источник === 'договоры');

  grid.append(
    el('div', { className: 'card' },
      [el('h3', { textContent: 'Топ-10 подрядчиков по сумме договоров' }), chartCanvas('ch-top')]),
    el('div', { className: 'card' },
      [el('h3', { textContent: 'КС2 и оплаты по месяцам' }), chartCanvas('ch-months')]),
    el('div', { className: 'card' },
      [el('h3', { textContent: 'Статусы договоров' }), chartCanvas('ch-statuses')]),
  );
  root.appendChild(grid);

  state.charts['ch-top'] = new Chart(document.getElementById('ch-top'), {
    type: 'bar',
    data: { labels: top.map(r => r.подрядчик),
            datasets: [{ label: 'Сумма договоров',
                         data: top.map(r => r.сумма_договоров),
                         backgroundColor: '#3b82f6' }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
               plugins: { legend: { display: false } } },
  });
  state.charts['ch-months'] = new Chart(document.getElementById('ch-months'), {
    type: 'line',
    data: { labels: m.map(r => r.период),
            datasets: [
              { label: 'КС2',    data: m.map(r => r.кс2_сумма),   borderColor: '#3b82f6', backgroundColor: '#3b82f633', fill: true, tension: .3 },
              { label: 'Оплаты', data: m.map(r => r.оплат_сумма), borderColor: '#10b981', backgroundColor: '#10b98133', fill: true, tension: .3 },
            ] },
    options: { responsive: true, maintainAspectRatio: false },
  });
  state.charts['ch-statuses'] = new Chart(document.getElementById('ch-statuses'), {
    type: 'doughnut',
    data: { labels: st.map(r => r.статус),
            datasets: [{ data: st.map(r => r.количество),
                         backgroundColor: ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899'] }] },
    options: { responsive: true, maintainAspectRatio: false },
  });
}

// ==================== ПОДРЯДЧИКИ ====================
function renderContractors(root) {
  const cols = [
    { key: 'подрядчик',         label: 'Подрядчик' },
    { key: 'договоров_всего',   label: 'Договоров',       format: fmtInt },
    { key: 'законтрактовано',   label: 'Законтракт.',     format: fmtInt },
    { key: 'переподписано',     label: 'Переподписано',   format: fmtInt },
    { key: 'отменено',          label: 'Отменено',        format: fmtInt },
    { key: 'сумма_договоров',   label: 'Сумма договоров', format: fmtMoney },
    { key: 'сумма_оплат',       label: 'Оплачено (дог.)', format: fmtMoney },
    { key: 'отчетов_кол',       label: 'Отчётов',         format: fmtInt },
    { key: 'кс2_кол',           label: 'КС2 (шт)',        format: fmtInt },
    { key: 'кс2_сумма',         label: 'КС2 (сумма)',     format: fmtMoney },
    { key: 'оплачено_сумма',    label: 'Оплачено КС2',    format: fmtMoney },
    { key: 'закрытие_кс2',      label: 'Закрытие',        format: fmtPct },
    { key: 'объектов_шт',       label: 'Объектов',        format: fmtInt },
    { key: 'работ_шт',          label: 'Работ',           format: fmtInt },
  ];
  root.appendChild(el('p', { className: 'muted', textContent: 'Клик по строке — карточка подрядчика.' }));
  const s = state.sort['contractors'] || { key: 'сумма_договоров', dir: 'desc' };
  const rows = sortRows(state.agg.contractors, s.key, s.dir);
  const wrap = el('div', { className: 'table-wrap' });
  renderTable(rows, cols, wrap, {
    sortKey: s.key, sortDir: s.dir,
    onSort: key => {
      const cur = state.sort['contractors'] || {};
      state.sort['contractors'] = { key, dir: cur.key === key && cur.dir === 'desc' ? 'asc' : 'desc' };
      activate('contractors');
    },
    onRowClick: r => showContractorDetail(r.подрядчик),
  });
  root.appendChild(wrap);
}

// ==================== ОБЪЕКТЫ ====================
function renderObjects(root) {
  const cols = [
    { key: 'объект',            label: 'Объект' },
    { key: 'договоров_всего',   label: 'Договоров',       format: fmtInt },
    { key: 'законтрактовано',   label: 'Законтракт.',     format: fmtInt },
    { key: 'сумма_договоров',   label: 'Сумма договоров', format: fmtMoney },
    { key: 'сумма_оплат',       label: 'Оплачено (дог.)', format: fmtMoney },
    { key: 'кс2_кол',           label: 'КС2 (шт)',        format: fmtInt },
    { key: 'кс2_сумма',         label: 'КС2 (сумма)',     format: fmtMoney },
    { key: 'закрытие_кс2',      label: 'Закрытие',        format: fmtPct },
    { key: 'подрядчиков_шт',    label: 'Подрядчиков',     format: fmtInt },
    { key: 'работ_шт',          label: 'Работ',           format: fmtInt },
  ];
  root.appendChild(el('p', { className: 'muted', textContent: 'Клик по строке — карточка объекта.' }));
  const s = state.sort['objects'] || { key: 'сумма_договоров', dir: 'desc' };
  const rows = sortRows(state.agg.objects, s.key, s.dir);
  const wrap = el('div', { className: 'table-wrap' });
  renderTable(rows, cols, wrap, {
    sortKey: s.key, sortDir: s.dir,
    onSort: key => {
      const cur = state.sort['objects'] || {};
      state.sort['objects'] = { key, dir: cur.key === key && cur.dir === 'desc' ? 'asc' : 'desc' };
      activate('objects');
    },
    onRowClick: r => showObjectDetail(r.объект),
  });
  root.appendChild(wrap);
}

// ==================== ДОГОВОРЫ ====================
function renderContracts(root) {
  const cols = [
    { key: 'id A',            label: 'ID' },
    { key: 'подрядчик',       label: 'Подрядчик' },
    { key: 'объект',          label: 'Объект' },
    { key: 'работа',          label: 'Работа' },
    { key: 'статус договора', label: 'Статус' },
    { key: 'стоимость',       label: 'Стоимость', format: fmtMoney },
    { key: 'оплачено',        label: 'Оплачено',  format: fmtMoney },
  ];
  root.appendChild(el('p', { className: 'muted', textContent: 'Клик по строке — карточка договора (КС2 и оплаты).' }));
  const s = state.sort['contracts'] || { key: 'стоимость', dir: 'desc' };
  const rows = sortRows(state.filteredRaw.contracts, s.key, s.dir);
  const wrap = el('div', { className: 'table-wrap' });
  renderTable(rows, cols, wrap, {
    sortKey: s.key, sortDir: s.dir,
    onSort: key => {
      const cur = state.sort['contracts'] || {};
      state.sort['contracts'] = { key, dir: cur.key === key && cur.dir === 'desc' ? 'asc' : 'desc' };
      activate('contracts');
    },
    onRowClick: r => showContractDetail(String(r['id A'] || '').trim()),
  });
  root.appendChild(wrap);
}

// ==================== ОПЛАТЫ ====================
function renderPayments(root) {
  const cols = autoColumns(state.filteredRaw.payments);
  if (!cols.length) {
    root.appendChild(el('div', { className: 'note', textContent: 'Нет данных об оплатах' }));
    return;
  }
  const s = state.sort['payments'] || { key: 'дата', dir: 'desc' };
  const rows = sortRows(state.filteredRaw.payments, s.key, s.dir);
  const wrap = el('div', { className: 'table-wrap' });
  renderTable(rows, cols, wrap, {
    sortKey: s.key, sortDir: s.dir,
    onSort: key => {
      const cur = state.sort['payments'] || {};
      state.sort['payments'] = { key, dir: cur.key === key && cur.dir === 'desc' ? 'asc' : 'desc' };
      activate('payments');
    },
  });
  root.appendChild(wrap);
}

// ==================== РАБОТЫ ====================
function renderWorks(root) {
  const cols = [
    { key: 'работа',            label: 'Работа' },
    { key: 'договоров_всего',   label: 'Договоров',       format: fmtInt },
    { key: 'сумма_договоров',   label: 'Сумма договоров', format: fmtMoney },
    { key: 'подрядчиков_шт',    label: 'Подрядчиков',     format: fmtInt },
    { key: 'объектов_шт',       label: 'Объектов',        format: fmtInt },
  ];
  const s = state.sort['works'] || { key: 'сумма_договоров', dir: 'desc' };
  const rows = sortRows(state.agg.works, s.key, s.dir);
  const wrap = el('div', { className: 'table-wrap' });
  renderTable(rows, cols, wrap, {
    sortKey: s.key, sortDir: s.dir,
    onSort: key => {
      const cur = state.sort['works'] || {};
      state.sort['works'] = { key, dir: cur.key === key && cur.dir === 'desc' ? 'asc' : 'desc' };
      activate('works');
    },
  });
  root.appendChild(wrap);
}

// ==================== МЕСЯЦЫ ====================
function renderMonths(root) {
  const s = state.sort['months'] || { key: 'период', dir: 'asc' };
  const rows = sortRows(state.agg.months, s.key, s.dir);

  root.appendChild(el('div', { className: 'card' },
    [el('h3', { textContent: 'КС2 и оплаты по месяцам' }), chartCanvas('ch-months2')]));

  const cols = [
    { key: 'период',      label: 'Период' },
    { key: 'кс2_кол',     label: 'КС2 (шт)',      format: fmtInt },
    { key: 'кс2_сумма',   label: 'КС2 (сумма)',   format: fmtMoney },
    { key: 'оплат_кол',   label: 'Оплат (шт)',    format: fmtInt },
    { key: 'оплат_сумма', label: 'Оплат (сумма)', format: fmtMoney },
  ];
  const wrap = el('div', { className: 'table-wrap', style: 'margin-top:20px' });
  renderTable(rows, cols, wrap, {
    sortKey: s.key, sortDir: s.dir,
    onSort: key => {
      const cur = state.sort['months'] || {};
      state.sort['months'] = { key, dir: cur.key === key && cur.dir === 'asc' ? 'desc' : 'asc' };
      activate('months');
    },
  });
  root.appendChild(wrap);

  state.charts['ch-months2'] = new Chart(document.getElementById('ch-months2'), {
    type: 'bar',
    data: { labels: rows.map(r => r.период),
            datasets: [
              { label: 'КС2',    data: rows.map(r => r.кс2_сумма),   backgroundColor: '#3b82f6' },
              { label: 'Оплаты', data: rows.map(r => r.оплат_сумма), backgroundColor: '#10b981' },
            ] },
    options: { responsive: true, maintainAspectRatio: false },
  });
}

// ==================== СТАТУСЫ ====================
function renderStatuses(root) {
  const cols = [
    { key: 'источник',   label: 'Источник' },
    { key: 'статус',     label: 'Статус' },
    { key: 'количество', label: 'Кол-во', format: fmtInt },
  ];
  const s = state.sort['statuses'] || { key: 'количество', dir: 'desc' };
  const rows = sortRows(state.agg.statuses, s.key, s.dir);
  const wrap = el('div', { className: 'table-wrap' });
  renderTable(rows, cols, wrap, {
    sortKey: s.key, sortDir: s.dir,
    onSort: key => {
      const cur = state.sort['statuses'] || {};
      state.sort['statuses'] = { key, dir: cur.key === key && cur.dir === 'desc' ? 'asc' : 'desc' };
      activate('statuses');
    },
  });
  root.appendChild(wrap);
}

// ==================== СВЯЗИ ОПЛАТ ====================
function paymentsForContract(contractId) {
  if (!contractId) return [];
  if (state.paymentLinkMode === 'idA') {
    return state.filteredRaw.payments.filter(p => getPaymentContractId(p) === contractId);
  }
  const c = state.contractById.get(contractId);
  if (!c) return [];
  const name = String(c['подрядчик'] || '').trim();
  const obj  = String(c['объект'] || '').trim();
  return state.filteredRaw.payments.filter(p => {
    const pc = getPaymentContractor(p), po = getPaymentObject(p);
    if (name && pc === name && (!obj || !po || po === obj)) return true;
    return false;
  });
}
function paymentsForContractor(name) {
  if (!name) return [];
  if (state.paymentLinkMode === 'idA') {
    const ids = new Set(state.raw.contracts
      .filter(c => String(c['подрядчик']||'').trim() === name)
      .map(c => String(c['id A']||'').trim()).filter(Boolean));
    return state.filteredRaw.payments.filter(p => {
      const pid = getPaymentContractId(p);
      return (pid && ids.has(pid)) || getPaymentContractor(p) === name;
    });
  }
  return state.filteredRaw.payments.filter(p => getPaymentContractor(p) === name);
}
function paymentsForObject(name) {
  if (!name) return [];
  if (state.paymentLinkMode === 'idA') {
    const ids = new Set(state.raw.contracts
      .filter(c => String(c['объект']||'').trim() === name)
      .map(c => String(c['id A']||'').trim()).filter(Boolean));
    return state.filteredRaw.payments.filter(p => {
      const pid = getPaymentContractId(p);
      return (pid && ids.has(pid)) || getPaymentObject(p) === name;
    });
  }
  return state.filteredRaw.payments.filter(p => getPaymentObject(p) === name);
}

// ==================== КАРТОЧКА ПОДРЯДЧИКА ====================
function showContractorDetail(name) {
  const aggRow = state.agg.contractors.find(r => r.подрядчик === name);
  if (!aggRow) return;
  const contracts = state.filteredRaw.contracts
    .filter(c => String(c['подрядчик'] || '').trim() === name);
  const ks2 = state.filteredRaw.ks2
    .filter(k => String(k['подрядчик'] || '').trim() === name);
  const payments = paymentsForContractor(name);
  const months = aggByMonth(ks2, payments);

  openModal(`Подрядчик: ${name}`, body => {
    body.appendChild(kpiGrid([
      { label: 'Договоров',       value: fmtInt(aggRow.договоров_всего) },
      { label: 'Законтрактовано', value: fmtInt(aggRow.законтрактовано) },
      { label: 'Сумма договоров', value: fmtMoney(aggRow.сумма_договоров) },
      { label: 'КС2 сумма',       value: fmtMoney(aggRow.кс2_сумма), sub: `закрытие ${aggRow.закрытие_кс2}%` },
      { label: 'Оплат (факт)',    value: fmtMoney(payments.reduce((s,p)=>s+toNum(p['сумма']),0)) },
    ]));

    body.appendChild(el('h3', { textContent: `Договоры (${contracts.length})` }));
    const cCols = [
      { key: 'id A',            label: 'ID' },
      { key: 'объект',          label: 'Объект' },
      { key: 'работа',          label: 'Работа' },
      { key: 'статус договора', label: 'Статус' },
      { key: 'стоимость',       label: 'Стоимость', format: fmtMoney },
      { key: 'оплачено',        label: 'Оплачено',  format: fmtMoney },
    ];
    const cw = el('div', { className: 'table-wrap' });
    renderTable(contracts, cCols, cw, {
      onRowClick: r => showContractDetail(String(r['id A'] || '').trim()),
    });
    body.appendChild(cw);

    body.appendChild(el('h3', { textContent: `КС2 (${ks2.length})` }));
    const kCols = [
      { key: 'id A',         label: 'ID' },
      { key: 'КС №',         label: 'КС №' },
      { key: 'объект',       label: 'Объект' },
      { key: 'статус',       label: 'Статус' },
      { key: 'дата КС',      label: 'Дата' },
      { key: 'стоимость КС', label: 'Стоимость', format: fmtMoney },
    ];
    const kw = el('div', { className: 'table-wrap' });
    renderTable(ks2, kCols, kw);
    body.appendChild(kw);

    body.appendChild(el('h3', { textContent: `Оплаты (${payments.length})` }));
    const pCols = autoColumns(payments);
    const pw = el('div', { className: 'table-wrap' });
    renderTable(payments, pCols.length ? pCols : [{ key: 'дата', label: 'Дата' }, { key: 'сумма', label: 'Сумма', format: fmtMoney }], pw);
    body.appendChild(pw);

    if (months.length) {
      body.appendChild(el('h3', { textContent: 'КС2 и оплаты по месяцам' }));
      body.appendChild(chartCanvas('ch-modal-months', '260px'));
      requestAnimationFrame(() => {
        state.charts['ch-modal-months'] = new Chart(document.getElementById('ch-modal-months'), {
          type: 'bar',
          data: { labels: months.map(r => r.период),
                  datasets: [
                    { label: 'КС2',    data: months.map(r => r.кс2_сумма),   backgroundColor: '#3b82f6' },
                    { label: 'Оплаты', data: months.map(r => r.оплат_сумма), backgroundColor: '#10b981' },
                  ] },
          options: { responsive: true, maintainAspectRatio: false },
        });
      });
    }
  });
}

// ==================== КАРТОЧКА ОБЪЕКТА ====================
function showObjectDetail(name) {
  const aggRow = state.agg.objects.find(r => r.объект === name);
  if (!aggRow) return;
  const contracts = state.filteredRaw.contracts
    .filter(c => String(c['объект'] || '').trim() === name);
  const ks2 = state.filteredRaw.ks2
    .filter(k => String(k['объект'] || '').trim() === name);
  const payments = paymentsForObject(name);
  const months = aggByMonth(ks2, payments);

  openModal(`Объект: ${name}`, body => {
    body.appendChild(kpiGrid([
      { label: 'Договоров',       value: fmtInt(aggRow.договоров_всего) },
      { label: 'Подрядчиков',     value: fmtInt(aggRow.подрядчиков_шт) },
      { label: 'Сумма договоров', value: fmtMoney(aggRow.сумма_договоров) },
      { label: 'КС2 сумма',       value: fmtMoney(aggRow.кс2_сумма), sub: `закрытие ${aggRow.закрытие_кс2}%` },
      { label: 'Оплат (факт)',    value: fmtMoney(payments.reduce((s,p)=>s+toNum(p['сумма']),0)) },
    ]));

    body.appendChild(el('h3', { textContent: `Договоры (${contracts.length})` }));
    const cCols = [
      { key: 'id A',            label: 'ID' },
      { key: 'подрядчик',       label: 'Подрядчик' },
      { key: 'работа',          label: 'Работа' },
      { key: 'статус договора', label: 'Статус' },
      { key: 'стоимость',       label: 'Стоимость', format: fmtMoney },
      { key: 'оплачено',        label: 'Оплачено',  format: fmtMoney },
    ];
    const cw = el('div', { className: 'table-wrap' });
    renderTable(contracts, cCols, cw, {
      onRowClick: r => showContractDetail(String(r['id A'] || '').trim()),
    });
    body.appendChild(cw);

    body.appendChild(el('h3', { textContent: `КС2 (${ks2.length})` }));
    const kCols = [
      { key: 'id A',         label: 'ID' },
      { key: 'КС №',         label: 'КС №' },
      { key: 'подрядчик',    label: 'Подрядчик' },
      { key: 'статус',       label: 'Статус' },
      { key: 'дата КС',      label: 'Дата' },
      { key: 'стоимость КС', label: 'Стоимость', format: fmtMoney },
    ];
    const kw = el('div', { className: 'table-wrap' });
    renderTable(ks2, kCols, kw);
    body.appendChild(kw);

    body.appendChild(el('h3', { textContent: `Оплаты (${payments.length})` }));
    const pCols = autoColumns(payments);
    const pw = el('div', { className: 'table-wrap' });
    renderTable(payments, pCols.length ? pCols : [{ key: 'дата', label: 'Дата' }, { key: 'сумма', label: 'Сумма', format: fmtMoney }], pw);
    body.appendChild(pw);

    if (months.length) {
      body.appendChild(el('h3', { textContent: 'КС2 и оплаты по месяцам' }));
      body.appendChild(chartCanvas('ch-modal-months-obj', '260px'));
      requestAnimationFrame(() => {
        state.charts['ch-modal-months-obj'] = new Chart(document.getElementById('ch-modal-months-obj'), {
          type: 'bar',
          data: { labels: months.map(r => r.период),
                  datasets: [
                    { label: 'КС2',    data: months.map(r => r.кс2_сумма),   backgroundColor: '#3b82f6' },
                    { label: 'Оплаты', data: months.map(r => r.оплат_сумма), backgroundColor: '#10b981' },
                  ] },
          options: { responsive: true, maintainAspectRatio: false },
        });
      });
    }
  });
}

// ==================== КАРТОЧКА ДОГОВОРА ====================
function showContractDetail(contractId) {
  const c = state.contractById.get(contractId);
  if (!c) return;
  const ks2 = state.filteredRaw.ks2.filter(k => String(k['id A'] || '').trim() === contractId);
  const payments = paymentsForContract(contractId);
  const ks2Sum = ks2.reduce((s, k) => s + toNum(k['стоимость КС']), 0);
  const paySum = payments.reduce((s, p) => s + toNum(p['сумма']), 0);
  const cost = toNum(c['стоимость']);
  const paidFromContract = toNum(c['оплачено']);

  openModal(`Договор: ${contractId}`, body => {
    body.appendChild(kpiGrid([
      { label: 'Подрядчик',       value: String(c['подрядчик'] || '—') },
      { label: 'Объект',          value: String(c['объект'] || '—') },
      { label: 'Статус',          value: String(c['статус договора'] || '—') },
      { label: 'Стоимость',       value: fmtMoney(cost) },
      { label: 'Оплачено (дог.)', value: fmtMoney(paidFromContract) },
      { label: 'КС2 сумма',       value: fmtMoney(ks2Sum), sub: cost ? `закрытие ${(ks2Sum/cost*100).toFixed(1)}%` : '' },
      { label: 'Оплат (факт)',    value: fmtMoney(paySum) },
    ]));

    if (state.paymentLinkMode !== 'idA') {
      body.appendChild(el('div', {
        className: 'note',
        textContent: `В raw_оплаты нет поля «id A» — оплаты сопоставляются по подрядчику/объекту. Для точной привязки к договору добавь колонку «id A» в лист «оплаты».`,
      }));
    }

    body.appendChild(el('h3', { textContent: `КС2 по договору (${ks2.length})` }));
    const kCols = [
      { key: 'КС №',         label: 'КС №' },
      { key: 'статус',       label: 'Статус' },
      { key: 'дата КС',      label: 'Дата' },
      { key: 'стоимость КС', label: 'Стоимость', format: fmtMoney },
    ];
    const kw = el('div', { className: 'table-wrap' });
    renderTable(ks2, kCols, kw);
    body.appendChild(kw);

    body.appendChild(el('h3', { textContent: `Оплаты по договору (${payments.length})` }));
    const pCols = autoColumns(payments);
    const pw = el('div', { className: 'table-wrap' });
    renderTable(payments, pCols.length ? pCols : [{ key: 'дата', label: 'Дата' }, { key: 'сумма', label: 'Сумма', format: fmtMoney }], pw);
    body.appendChild(pw);
  });
}

// ==================== MODAL ====================
const modalStack = [];
function openModal(title, buildFn) {
  modalStack.push({ title, buildFn });
  renderModal();
}
function backModal() {
  modalStack.pop();
  renderModal();
}
function closeModal() {
  modalStack.length = 0;
  renderModal();
}
function renderModal() {
  const overlay = document.getElementById('modal');
  Object.keys(state.charts).forEach(k => {
    if (k.startsWith('ch-modal')) {
      try { state.charts[k].destroy(); } catch (e) {}
      delete state.charts[k];
    }
  });
  if (!modalStack.length) {
    overlay.classList.remove('open');
    overlay.innerHTML = '';
    return;
  }
  const { title, buildFn } = modalStack[modalStack.length - 1];
  overlay.innerHTML = '';
  overlay.classList.add('open');
  const box = el('div', { className: 'modal-box' });
  const header = el('div', { className: 'modal-header' });
  if (modalStack.length > 1) {
    const back = el('button', { className: 'modal-back', textContent: '← Назад' });
    back.onclick = backModal;
    header.appendChild(back);
  }
  header.appendChild(el('h2', { textContent: title }));
  const closeBtn = el('button', { className: 'modal-close', textContent: '×' });
  closeBtn.onclick = closeModal;
  header.appendChild(closeBtn);
  box.appendChild(header);
  const body = el('div', { className: 'modal-body' });
  buildFn(body);
  box.appendChild(body);
  overlay.appendChild(box);
  overlay.onclick = e => { if (e.target === overlay) closeModal(); };
}

// ==================== INIT ====================
function attachFilterListeners() {
  const onChange = () => { readFiltersFromUI(); applyFilters(); activate(state.currentTab); };
  ['f-contractor', 'f-object', 'f-status', 'f-date-from', 'f-date-to']
    .forEach(id => document.getElementById(id).addEventListener('change', onChange));
  document.getElementById('f-reset').addEventListener('click', () => {
    document.getElementById('f-contractor').value = '';
    document.getElementById('f-object').value = '';
    document.getElementById('f-status').value = '';
    document.getElementById('f-date-from').value = '';
    document.getElementById('f-date-to').value = '';
    onChange();
  });
}

(async function init() {
  try {
    if (typeof Chart === 'undefined') throw new Error('Chart.js не загрузился (CDN заблокирован?)');
    if (typeof Papa === 'undefined')  throw new Error('PapaParse не загрузился (CDN заблокирован?)');
    if (!CONFIG.SPREADSHEET_ID || CONFIG.SPREADSHEET_ID === 'PASTE_DEST_SPREADSHEET_ID_HERE') {
      throw new Error('В app.js не задан SPREADSHEET_ID (впиши ID таблицы-приёмника).');
    }
    console.log('SPREADSHEET_ID =', CONFIG.SPREADSHEET_ID);

    buildTabs();
    logStage('получение данных');

    await loadAll();
    logStage('первичная агрегация');
    populateFilters();
    attachFilterListeners();
    applyFilters();
    validateAgainstServer();

    logStage('отрисовка');
    document.getElementById('last-update').textContent =
      'Данные обновлены: ' + new Date().toLocaleString('ru-RU');
    activate('overview');
    console.log('✓ ГОТОВО');
  } catch (e) {
    console.error(e);
    showFatal(e.message, e.stack || '');
  }
})();
