const CONFIG = {
  // ⚠️ ID ТОЙ таблицы, где лежат листы agg_* (не источника!)
  SPREADSHEET_ID: '1Vw0rBiUT_I19f1rzkFxPPw5wLuIY0zD3Im04t42NKtM',
};

const state = { data: {}, charts: {} };

function csvUrl(sheet) {
  return `https://docs.google.com/spreadsheets/d/${CONFIG.SPREADSHEET_ID}` +
         `/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheet)}`;
}

async function loadSheet(sheet) {
  const res = await fetch(csvUrl(sheet), { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${sheet}`);
  return Papa.parse(await res.text(), { header: true, skipEmptyLines: true }).data;
}

async function loadAll() {
  const [c, o, w, m, s] = await Promise.all([
    loadSheet('agg_подрядчики'), loadSheet('agg_объекты'),
    loadSheet('agg_работы'),    loadSheet('agg_по_месяцам'),
    loadSheet('agg_статусы'),
  ]);
  state.data = { contractors: c, objects: o, works: w, months: m, statuses: s };
}

// --- utils ---
const toNum = v => {
  if (v === '' || v == null) return 0;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
};
const fmtMoney = n => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(n) + ' ₽';
const fmtInt   = n => new Intl.NumberFormat('ru-RU').format(n);
const fmtPct   = n => Number(n).toFixed(1) + '%';

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  children.forEach(c => e.appendChild(c));
  return e;
}

function chartCanvas(id) {
  const wrap = el('div', { className: 'chart-wrap' });
  const cv = el('canvas'); cv.id = id;
  wrap.appendChild(cv);
  return wrap;
}

function makeChart(id, cfg) {
  const c = document.getElementById(id);
  if (!c) return;
  if (state.charts[id]) state.charts[id].destroy();
  state.charts[id] = new Chart(c, cfg);
}

function renderTable(rows, cols, parent) {
  const t = el('table', { className: 'data-table' });
  const hr = t.createTHead().insertRow();
  cols.forEach(c => hr.appendChild(el('th', { textContent: c.label })));
  const tb = t.createTBody();
  rows.forEach(r => {
    const tr = tb.insertRow();
    cols.forEach(c => {
      const td = tr.insertCell();
      const v = r[c.key];
      td.textContent = c.format ? c.format(v) : (v ?? '');
    });
  });
  parent.appendChild(t);
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

// --- tabs ---
const TABS = [
  { id: 'overview',    title: 'Обзор',         render: renderOverview },
  { id: 'contractors', title: 'Подрядчики',    render: renderContractors },
  { id: 'objects',     title: 'Объекты',       render: renderObjects },
  { id: 'works',       title: 'Работы',        render: renderWorks },
  { id: 'months',      title: 'По месяцам',    render: renderMonths },
  { id: 'statuses',    title: 'Статусы',       render: renderStatuses },
];

function buildTabs() {
  const nav = document.getElementById('tabs');
  TABS.forEach((tab, i) => {
    const b = el('button', { textContent: tab.title, dataset: { tab: tab.id } });
    if (i === 0) b.classList.add('active');
    b.onclick = () => activate(tab.id);
    nav.appendChild(b);
  });
}

function activate(id) {
  document.querySelectorAll('#tabs button')
    .forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  Object.values(state.charts).forEach(c => c.destroy());
  state.charts = {};
  const content = document.getElementById('content');
  content.innerHTML = '';
  TABS.find(t => t.id === id).render(content);
}

// --- overview ---
function renderOverview(root) {
  const c = state.data.contractors;
  const sumDog  = c.reduce((s, r) => s + toNum(r.сумма_договоров), 0);
  const sumKS2  = c.reduce((s, r) => s + toNum(r.кс2_сумма), 0);
  const sumPaid = c.reduce((s, r) => s + toNum(r.оплачено_сумма), 0);
  const close   = sumDog ? (sumKS2 / sumDog * 100).toFixed(1) : 0;

  root.appendChild(kpiGrid([
    { label: 'Подрядчиков',     value: fmtInt(c.length) },
    { label: 'Сумма договоров', value: fmtMoney(sumDog) },
    { label: 'Сумма КС2',       value: fmtMoney(sumKS2), sub: `закрытие ${close}%` },
    { label: 'Оплачено по КС2', value: fmtMoney(sumPaid) },
  ]));

  const grid = el('div', { className: 'charts-grid' });
  const top = [...c].sort((a, b) => toNum(b.сумма_договоров) - toNum(a.сумма_договоров)).slice(0, 10);
  const m = [...state.data.months].sort((a, b) => String(a.период).localeCompare(String(b.период)));
  const st = state.data.statuses.filter(r => r.источник === 'договоры');

  const card1 = el('div', { className: 'card' },
    [el('h3', { textContent: 'Топ-10 подрядчиков по сумме договоров' }), chartCanvas('ch-top')]);
  const card2 = el('div', { className: 'card' },
    [el('h3', { textContent: 'КС2 и оплаты по месяцам' }), chartCanvas('ch-months')]);
  const card3 = el('div', { className: 'card' },
    [el('h3', { textContent: 'Статусы договоров' }), chartCanvas('ch-statuses')]);
  grid.append(card1, card2, card3);
  root.appendChild(grid);

  makeChart('ch-top', {
    type: 'bar',
    data: { labels: top.map(r => r.подрядчик),
            datasets: [{ label: 'Сумма договоров',
                         data: top.map(r => toNum(r.сумма_договоров)),
                         backgroundColor: '#3b82f6' }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
               plugins: { legend: { display: false } } },
  });

  makeChart('ch-months', {
    type: 'line',
    data: { labels: m.map(r => r.период),
            datasets: [
              { label: 'КС2', data: m.map(r => toNum(r.кс2_сумма)),
                borderColor: '#3b82f6', backgroundColor: '#3b82f633', fill: true, tension: .3 },
              { label: 'Оплаты', data: m.map(r => toNum(r.оплат_сумма)),
                borderColor: '#10b981', backgroundColor: '#10b98133', fill: true, tension: .3 },
            ] },
    options: { responsive: true, maintainAspectRatio: false },
  });

  makeChart('ch-statuses', {
    type: 'doughnut',
    data: { labels: st.map(r => r.статус),
            datasets: [{ data: st.map(r => toNum(r.количество)),
                         backgroundColor: ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899'] }] },
    options: { responsive: true, maintainAspectRatio: false },
  });
}

// --- table tabs ---
function renderContractors(root) {
  const cols = [
    { key: 'подрядчик',         label: 'Подрядчик' },
    { key: 'договоров_всего',   label: 'Договоров',      format: fmtInt },
    { key: 'законтрактовано',   label: 'Законтракт.',    format: fmtInt },
    { key: 'переподписано',     label: 'Переподписано',  format: fmtInt },
    { key: 'отменено',          label: 'Отменено',       format: fmtInt },
    { key: 'сумма_договоров',   label: 'Сумма договоров',format: fmtMoney },
    { key: 'сумма_оплат',       label: 'Сумма оплат',    format: fmtMoney },
    { key: 'отчетов_кол',       label: 'Отчётов',        format: fmtInt },
    { key: 'кс2_кол',           label: 'КС2 (шт)',       format: fmtInt },
    { key: 'кс2_сумма',         label: 'КС2 (сумма)',    format: fmtMoney },
    { key: 'оплачено_сумма',    label: 'Оплачено',       format: fmtMoney },
    { key: 'закрытие_кс2',      label: 'Закрытие',       format: fmtPct },
    { key: 'объектов_шт',       label: 'Объектов',       format: fmtInt },
    { key: 'работ_шт',          label: 'Работ',          format: fmtInt },
  ];
  const rows = [...state.data.contractors]
    .sort((a, b) => toNum(b.сумма_договоров) - toNum(a.сумма_договоров));
  const wrap = el('div', { className: 'table-wrap' });
  renderTable(rows, cols, wrap);
  root.appendChild(wrap);
}

function renderObjects(root) {
  const cols = [
    { key: 'объект',            label: 'Объект' },
    { key: 'договоров_всего',   label: 'Договоров',       format: fmtInt },
    { key: 'законтрактовано',   label: 'Законтракт.',     format: fmtInt },
    { key: 'сумма_договоров',   label: 'Сумма договоров', format: fmtMoney },
    { key: 'сумма_оплат',       label: 'Сумма оплат',     format: fmtMoney },
    { key: 'кс2_кол',           label: 'КС2 (шт)',        format: fmtInt },
    { key: 'кс2_сумма',         label: 'КС2 (сумма)',     format: fmtMoney },
    { key: 'закрытие_кс2',      label: 'Закрытие',        format: fmtPct },
    { key: 'подрядчиков_шт',    label: 'Подрядчиков',     format: fmtInt },
    { key: 'работ_шт',          label: 'Работ',           format: fmtInt },
  ];
  const rows = [...state.data.objects]
    .sort((a, b) => toNum(b.сумма_договоров) - toNum(a.сумма_договоров));
  const wrap = el('div', { className: 'table-wrap' });
  renderTable(rows, cols, wrap);
  root.appendChild(wrap);
}

function renderWorks(root) {
  const cols = [
    { key: 'работа',            label: 'Работа' },
    { key: 'договоров_всего',   label: 'Договоров',       format: fmtInt },
    { key: 'сумма_договоров',   label: 'Сумма договоров', format: fmtMoney },
    { key: 'подрядчиков_шт',    label: 'Подрядчиков',     format: fmtInt },
    { key: 'объектов_шт',       label: 'Объектов',        format: fmtInt },
  ];
  const rows = [...state.data.works]
    .sort((a, b) => toNum(b.сумма_договоров) - toNum(a.сумма_договоров));
  const wrap = el('div', { className: 'table-wrap' });
  renderTable(rows, cols, wrap);
  root.appendChild(wrap);
}

function renderMonths(root) {
  const rows = [...state.data.months]
    .sort((a, b) => String(a.период).localeCompare(String(b.период)));

  const card = el('div', { className: 'card' },
    [el('h3', { textContent: 'КС2 и оплаты по месяцам' }), chartCanvas('ch-months2')]);
  root.appendChild(card);

  const cols = [
    { key: 'период',      label: 'Период' },
    { key: 'кс2_кол',     label: 'КС2 (шт)',      format: fmtInt },
    { key: 'кс2_сумма',   label: 'КС2 (сумма)',   format: fmtMoney },
    { key: 'оплат_кол',   label: 'Оплат (шт)',    format: fmtInt },
    { key: 'оплат_сумма', label: 'Оплат (сумма)', format: fmtMoney },
  ];
  const wrap = el('div', { className: 'table-wrap', style: 'margin-top:20px' });
  renderTable(rows, cols, wrap);
  root.appendChild(wrap);

  makeChart('ch-months2', {
    type: 'bar',
    data: { labels: rows.map(r => r.период),
            datasets: [
              { label: 'КС2', data: rows.map(r => toNum(r.кс2_сумма)), backgroundColor: '#3b82f6' },
              { label: 'Оплаты', data: rows.map(r => toNum(r.оплат_сумма)), backgroundColor: '#10b981' },
            ] },
    options: { responsive: true, maintainAspectRatio: false },
  });
}

function renderStatuses(root) {
  const cols = [
    { key: 'источник',   label: 'Источник' },
    { key: 'статус',     label: 'Статус' },
    { key: 'количество', label: 'Кол-во', format: fmtInt },
  ];
  const wrap = el('div', { className: 'table-wrap' });
  renderTable(state.data.statuses, cols, wrap);
  root.appendChild(wrap);
}

// --- init ---
(async function init() {
  buildTabs();
  try {
    await loadAll();
    document.getElementById('last-update').textContent =
      'Данные обновлены: ' + new Date().toLocaleString('ru-RU');
    activate('overview');
  } catch (e) {
    document.getElementById('content').innerHTML =
      `<div class="error">Ошибка загрузки: ${e.message}<br>
       Проверьте, что SPREADSHEET_ID — это ID таблицы с листами agg_*,<br>
       и что она расшарена «всем, у кого есть ссылка».</div>`;
    console.error(e);
  }
})();
