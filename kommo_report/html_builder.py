import datetime
from config import CRM_LINK


_CSS = """
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Segoe UI', Arial, sans-serif; background: #F4F6FA; color: #333; }
.container { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }

/* Header */
.header { text-align: center; margin-bottom: 24px; }
.header h1 { font-size: 1.8rem; color: #1E5591; }
.header p  { color: #666; font-size: 1rem; margin-top: 6px; }

/* KPI cards */
.kpi-row { display: flex; gap: 16px; margin-bottom: 28px; flex-wrap: wrap; }
.kpi-card {
    flex: 1; min-width: 180px;
    background: #fff; border-radius: 10px;
    box-shadow: 0 2px 8px rgba(0,0,0,.10);
    padding: 20px; text-align: center;
}
.kpi-card .kpi-value { font-size: 2rem; font-weight: 700; color: #1E5591; }
.kpi-card .kpi-label { font-size: 0.85rem; color: #888; margin-top: 4px; }

/* Table */
.table-wrapper { overflow-x: auto; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,.10); }
table { width: 100%; border-collapse: collapse; background: #fff; }
thead tr { background: #1E5591; color: #fff; }
thead th {
    padding: 12px 14px; text-align: left; font-size: .9rem;
    cursor: pointer; white-space: nowrap; user-select: none;
}
thead th:hover { background: #174a7a; }
thead th .sort-icon { margin-left: 4px; opacity: .6; font-size: .8rem; }

tbody tr.manager-row { cursor: pointer; transition: background .15s; }
tbody tr.manager-row:hover { filter: brightness(.97); }

/* Rank colours */
tbody tr.rank-1  { background: #FFF3CD; }
tbody tr.rank-2  { background: #F0F0F0; }
tbody tr.rank-3  { background: #FFE8D6; }
tbody tr.rank-other:nth-child(even) { background: #F9F9F9; }
tbody tr.rank-other:nth-child(odd)  { background: #FFFFFF; }
tbody tr.summary-row { background: #E8F5E9; font-weight: 700; }

tbody td { padding: 11px 14px; font-size: .9rem; vertical-align: middle; }

/* Expand row */
tr.detail-row { display: none; }
tr.detail-row.open { display: table-row; }
tr.detail-row td { padding: 0; }
.detail-inner {
    padding: 12px 20px;
    background: #f0f4fa;
    border-top: 1px solid #dce4f0;
}
.detail-inner table { box-shadow: none; border: 1px solid #dce4f0; }
.detail-inner thead tr { background: #3a75b5; }
.detail-inner tbody tr { background: #fff; }
.detail-inner tbody tr:nth-child(even) { background: #f5f8ff; }
.detail-inner td, .detail-inner th { padding: 8px 12px; font-size: .85rem; }

/* Badge */
.rank-badge {
    display: inline-block; width: 28px; height: 28px; line-height: 28px;
    border-radius: 50%; text-align: center; font-weight: 700; font-size: .85rem;
}
.badge-1 { background: #FFD700; color: #7a5c00; }
.badge-2 { background: #C0C0C0; color: #444; }
.badge-3 { background: #CD7F32; color: #fff; }
.badge-n { background: #dde3ec; color: #555; }

.arrow { margin-left: 6px; font-size: .75rem; transition: transform .2s; display: inline-block; }
.open-arrow { transform: rotate(90deg); }

/* Footer */
.footer { margin-top: 24px; text-align: center; font-size: .82rem; color: #999; }
.footer a { color: #1E5591; text-decoration: none; }
.footer a:hover { text-decoration: underline; }

/* Responsive */
@media (max-width: 640px) {
    .header h1 { font-size: 1.3rem; }
    .kpi-card .kpi-value { font-size: 1.5rem; }
    thead th, tbody td { padding: 9px 8px; font-size: .8rem; }
}
"""

_JS = """
// ---- Expand/collapse detail rows ----
document.querySelectorAll('.manager-row').forEach(function(row) {
    row.addEventListener('click', function() {
        var detailRow = document.getElementById('detail-' + row.dataset.id);
        if (!detailRow) return;
        var isOpen = detailRow.classList.toggle('open');
        var arrow = row.querySelector('.arrow');
        if (arrow) arrow.classList.toggle('open-arrow', isOpen);
    });
});

// ---- Sortable table ----
(function() {
    var table = document.getElementById('rating-table');
    if (!table) return;
    var tbody = table.querySelector('tbody');
    var headers = table.querySelectorAll('thead th[data-col]');
    var currentCol = null, currentDir = 1;

    function sortRows(col, dir) {
        var rows = Array.from(tbody.querySelectorAll('tr.manager-row'));
        rows.sort(function(a, b) {
            var av = parseFloat(a.dataset[col]) || 0;
            var bv = parseFloat(b.dataset[col]) || 0;
            return dir * (bv - av);
        });
        rows.forEach(function(r) {
            var detailId = 'detail-' + r.dataset.id;
            var dr = document.getElementById(detailId);
            tbody.appendChild(r);
            if (dr) tbody.appendChild(dr);
        });
        // Re-apply rank styles
        rows.forEach(function(r, i) {
            r.className = r.className.replace(/rank-\\S+/g, '');
            if (i === 0) r.classList.add('manager-row', 'rank-1');
            else if (i === 1) r.classList.add('manager-row', 'rank-2');
            else if (i === 2) r.classList.add('manager-row', 'rank-3');
            else r.classList.add('manager-row', 'rank-other');
        });
    }

    headers.forEach(function(th) {
        th.addEventListener('click', function() {
            var col = th.dataset.col;
            if (currentCol === col) { currentDir *= -1; }
            else { currentCol = col; currentDir = -1; }
            headers.forEach(function(h) {
                h.querySelector('.sort-icon').textContent = '⇅';
            });
            th.querySelector('.sort-icon').textContent = currentDir === -1 ? '↓' : '↑';
            sortRows(col, currentDir);
        });
    });
})();
"""


def _fmt_money(amount: int) -> str:
    return f"{amount:,.0f} ₴".replace(',', ' ')


def _badge(rank: int) -> str:
    cls = {1: 'badge-1', 2: 'badge-2', 3: 'badge-3'}.get(rank, 'badge-n')
    return f'<span class="rank-badge {cls}">{rank}</span>'


def _rank_class(rank: int) -> str:
    return {1: 'rank-1', 2: 'rank-2', 3: 'rank-3'}.get(rank, 'rank-other')


def build_html(rating: list, month_label: str) -> str:
    total_deals = sum(s['count'] for _, s in rating)
    total_budget = sum(s['total'] for _, s in rating)
    managers_count = len(rating)
    updated = datetime.datetime.now().strftime('%d.%m.%Y %H:%M')

    rows_html = []
    for rank, (manager, stats) in enumerate(rating, start=1):
        pct = (stats['total'] / total_budget * 100) if total_budget else 0
        uid = f"mgr{rank}"

        # Manager row
        rows_html.append(
            f'<tr class="manager-row {_rank_class(rank)}" data-id="{uid}" '
            f'data-total="{stats["total"]}" data-count="{stats["count"]}">'
            f'<td>{_badge(rank)}</td>'
            f'<td>{manager} <span class="arrow">&#9658;</span></td>'
            f'<td style="text-align:center">{stats["count"]}</td>'
            f'<td style="text-align:right">{_fmt_money(stats["total"])}</td>'
            f'<td style="text-align:right">{pct:.1f}%</td>'
            f'</tr>'
        )

        # Detail deals rows
        deal_rows = ''.join(
            f'<tr><td>{d["id"]}</td><td>{d["name"]}</td>'
            f'<td style="text-align:right">{_fmt_money(d["budget"])}</td>'
            f'<td style="text-align:center">{d["closed_at"]}</td></tr>'
            for d in sorted(stats['deals'], key=lambda x: x['budget'], reverse=True)
        )
        rows_html.append(
            f'<tr class="detail-row" id="detail-{uid}">'
            f'<td colspan="5"><div class="detail-inner">'
            f'<table><thead><tr>'
            f'<th>ID</th><th>Назва угоди</th><th>Сума</th><th>Дата закриття</th>'
            f'</tr></thead><tbody>{deal_rows}</tbody></table>'
            f'</div></td></tr>'
        )

    summary_row = (
        f'<tr class="summary-row">'
        f'<td colspan="2">ПІДСУМОК</td>'
        f'<td style="text-align:center">{total_deals}</td>'
        f'<td style="text-align:right">{_fmt_money(total_budget)}</td>'
        f'<td style="text-align:right">100%</td>'
        f'</tr>'
    )

    html = f"""<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Рейтинг менеджерів — {month_label}</title>
<style>{_CSS}</style>
</head>
<body>
<div class="container">

  <div class="header">
    <h1>Рейтинг менеджерів — {month_label}</h1>
    <p>Успішно реалізовані угоди</p>
  </div>

  <div class="kpi-row">
    <div class="kpi-card">
      <div class="kpi-value">{total_deals}</div>
      <div class="kpi-label">Всього угод</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value">{_fmt_money(total_budget)}</div>
      <div class="kpi-label">Загальна сума бюджету</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value">{managers_count}</div>
      <div class="kpi-label">Менеджерів у рейтингу</div>
    </div>
  </div>

  <div class="table-wrapper">
    <table id="rating-table">
      <thead>
        <tr>
          <th data-col="rank" style="width:56px">Місце <span class="sort-icon">↓</span></th>
          <th>Менеджер</th>
          <th data-col="count" style="text-align:center">Угод <span class="sort-icon">⇅</span></th>
          <th data-col="total" style="text-align:right">Сума (грн) <span class="sort-icon">⇅</span></th>
          <th style="text-align:right">% від суми</th>
        </tr>
      </thead>
      <tbody>
        {''.join(rows_html)}
        {summary_row}
      </tbody>
    </table>
  </div>

  <div class="footer">
    Оновлено: {updated} &nbsp;|&nbsp;
    <a href="{CRM_LINK}" target="_blank">Відкрити воронку в CRM ↗</a>
  </div>

</div>
<script>{_JS}</script>
</body>
</html>"""

    return html
