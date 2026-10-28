/**
 * 🧾 «ТЕСТ ЗАКАЗ 1С» — віджет Kommo (вкладка в картці угоди). Вікно рахунку малюється ТУТ, у вкладці; сервер —
 * дашборд (`/api/zakaz1c`, тека `backend/src/zakaz1c/`). Усі запити — через `self.$authorizedAjax`: Kommo додає
 * підписаний `X-Auth-Token`, сервер перевіряє підпис секретом інтеграції. Ключів і паролів у цьому файлі немає.
 *
 * Вигляд — варіант А макета, який погодив Сергій 27.10.2026 (https://claude.ai/artifact/4oa6EJoR194rGWeszf93VP):
 * три плитки «Рахунок → Оплата → Документи», форма відкривається кнопкою «Виставити рахунок». Правила форми
 * (організації, ПДВ, послуги, дати) приходять із сервера, і сервер перевіряє їх ще раз — вікно лише підказує.
 * Чого 1С ще не вміє (другий рахунок, зміна, акт і ТТН) — кнопки сірі, причина словами з сервера (`waits`).
 *
 * Вкладка — прийом Genesis (розібрано 23.10.2026): `card_sdk` + `lcard-0`, `loadPreloadedData` повертає ОБʼЄКТ `{}`
 * (тоді Kommo тримає вкладку постійно), а вміст малюємо в контейнер `#<widget_code>`. Кому не можна — повертаємо `[]`,
 * і вкладки немає. Хто бачить — поле «testers» у налаштуваннях інтеграції: порожньо — усі, інакше лише перелічені.
 */
define(["jquery"], function ($) {
  return function () {
    var self = this;
    var NS = "z1c";
    var state = { data: null, form: null, busy: false, msg: null, modal: null };

    function settings() { return self.get_settings() || {}; }
    function apiBase() { return String(settings().api_url || "https://dashboard.uts.ua/api/zakaz1c").replace(/\/+$/, ""); }
    function testers() {
      return String(settings().testers || "").split(/[,\s]+/).map(Number).filter(function (n) { return n > 0; });
    }
    function me() { return Number(AMOCRM.constant("user").id); }
    /** Порожній список — вкладку бачать усі (рішення Романа 28.10.2026); заповнений — лише ті, хто в ньому. */
    function allowedHere() { var t = testers(); return t.length === 0 || t.indexOf(me()) !== -1; }
    function leadId() { return AMOCRM.data && AMOCRM.data.current_card ? Number(AMOCRM.data.current_card.id) : 0; }
    function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
    function r2(n) { return Math.round(Number(n || 0) * 100) / 100; }
    function money(n) { return r2(n).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function dmy(iso) { var p = String(iso || "").slice(0, 10).split("-"); return p.length === 3 ? p[2] + "." + p[1] + "." + p[0] : String(iso || ""); }
    function addDays(iso, n) { var p = iso.split("-"), d = new Date(+p[0], +p[1] - 1, +p[2] + n); return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }

    /** Один запит до сервера через підписаний Kommo канал. Відповідь — JSON; помилка — текст сервера. */
    function api(method, path, body) {
      return new Promise(function (resolve, reject) {
        self.$authorizedAjax({
          url: apiBase() + path,
          method: method,
          dataType: "json",
          contentType: "application/json; charset=utf-8",
          data: body ? JSON.stringify(body) : undefined,
          success: function (j) { resolve(j); },
          error: function (x) {
            var msg = "Сервер недоступний.";
            try { msg = (x.responseJSON && x.responseJSON.error) || JSON.parse(x.responseText).error || msg; } catch (e) { /* лишаємо загальне */ }
            reject(new Error(msg));
          }
        });
      });
    }

    function root() { return $("#" + settings().widget_code); }

    /** Темна тема Kommo — за кольором тла сторінки: класу теми Kommo не гарантує, а колір є завжди. */
    function isDark() {
      var m = String(getComputedStyle(document.body).backgroundColor || "").match(/\d+(\.\d+)?/g);
      if (!m || m.length < 3 || (m.length > 3 && Number(m[3]) === 0)) return false;
      return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) < 110;
    }

    var P = "." + NS;
    var CSS = P + "{--txt:#2e3640;--mut:#7d8893;--line:#dfe3e8;--card:#fff;--note:#f7f9fa;--fld:#fff;--acc:#4c8bf7;"
      + "--ok:#e3f5e8;--okt:#1f7a3a;--part:#fdf1d8;--partt:#8a5a00;--bad:#fde4e4;--badt:#a12626;--strip:#f1f3f5;--stage:#e6e9ed;"
      + "padding:14px 18px;font-size:13.5px;color:var(--txt);line-height:1.4}"
      + P + ".dark{--txt:#e3e8ee;--mut:#9aa6b2;--line:#34404c;--card:#1f2a35;--note:#22303c;--fld:#1a242e;--acc:#5b9bff;"
      + "--ok:#173a26;--okt:#6fd496;--part:#3a3016;--partt:#f0c46a;--bad:#3d1c1f;--badt:#ff9a9a;--strip:#26323e;--stage:#2c3844}"
      + P + " *{box-sizing:border-box}"
      + P + " .lbl{display:block;font-size:11.5px;color:var(--mut);margin-bottom:4px}"
      + P + " .in{height:36px;width:100%;font:inherit;font-size:13.5px;background:var(--fld);border:1px solid var(--line);border-radius:3px;padding:7px 9px;color:var(--txt)}"
      + P + " .in:disabled," + P + " .ro{opacity:.7;background:var(--strip)}"
      + P + " .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 12px;align-items:start}" + P + " textarea.in{height:auto}"
      + P + " .grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}"
      + P + " .btn{font:inherit;font-size:13px;border:1px solid var(--line);background:transparent;color:var(--txt);border-radius:3px;padding:7px 14px;cursor:pointer;white-space:nowrap}"
      + P + " .btn:hover{border-color:var(--acc)}"
      + P + " .btn.main{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:700}"
      + P + " .btn.dash{border-style:dashed;color:var(--mut)}"
      + P + " .btn.sm{padding:4px 10px;font-size:12px}"
      + P + " .btn.link{border:0;padding:4px 0;color:var(--acc)}"
      + P + " .btn[disabled]{opacity:.55;cursor:not-allowed}"
      + P + " .row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}"
      + P + " .between{justify-content:space-between}"
      + P + " .mut{color:var(--mut);font-size:12px}"
      + P + " .chip{display:inline-block;font-size:11.5px;padding:2px 8px;border-radius:3px;white-space:nowrap}"
      + P + " .chip.ok{background:var(--ok);color:var(--okt)}" + P + " .chip.part{background:var(--part);color:var(--partt)}"
      + P + " .chip.bad{background:var(--bad);color:var(--badt)}" + P + " .chip.wait{background:var(--strip);color:var(--mut);border:1px solid var(--line)}"
      + P + " .chip.test{background:var(--part);color:var(--partt);letter-spacing:.4px}"
      + P + " .steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}"
      + P + " .step{border:1px solid var(--line);border-radius:4px;padding:12px;background:var(--note);display:flex;flex-direction:column;gap:7px;min-width:0}"
      + P + " .step .h{display:flex;justify-content:space-between;align-items:center;gap:6px;font-weight:700}"
      + P + " .step .big{font-size:18px;font-weight:700}"
      + P + " .step.done{border-color:var(--okt)}" + P + " .step.next{border-color:var(--acc)}"
      + P + " .meter{height:6px;background:var(--stage);border-radius:3px;overflow:hidden}" + P + " .meter i{display:block;height:100%;background:var(--okt)}"
      + P + " .formbox{border:1px solid var(--acc);border-radius:4px;padding:14px;margin-top:14px;display:grid;gap:14px}"
      + P + " .seg{display:inline-flex;border:1px solid var(--line);border-radius:3px;overflow:hidden}"
      + P + " .seg button{font:inherit;background:transparent;border:0;border-right:1px solid var(--line);padding:6px 12px;font-size:13px;cursor:pointer;color:var(--txt)}"
      + P + " .seg button:last-child{border-right:0}" + P + " .seg button.on{background:var(--acc);color:#fff}"
      + P + " .seg button.off{color:var(--mut);text-decoration:line-through}"
      + P + " .item{border:1px solid var(--line);border-radius:4px;padding:10px;display:grid;gap:8px;background:var(--note)}"
      + P + " .msg{border-radius:3px;padding:8px 12px;font-size:13px;margin-top:10px}"
      + P + " .msg.err{background:var(--bad);color:var(--badt)}" + P + " .msg.ok{background:var(--ok);color:var(--okt)}" + P + " .msg.warn{background:var(--part);color:var(--partt)}"
      + P + " .tot{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12.5px;color:var(--mut)}" + P + " .tot b{color:var(--txt)}"
      + P + " .hint{display:block;margin-top:4px;font-size:11px;color:var(--mut)}"
      + P + " .prev{border:1px dashed var(--line);border-radius:4px;padding:8px 10px;font-size:12.5px;display:grid;gap:4px;overflow-wrap:anywhere}"
      + P + " .x{background:none;border:0;color:var(--mut);font-size:18px;cursor:pointer;padding:0 4px}"
      + P + " table{width:100%;border-collapse:collapse;margin-top:8px}"
      + P + " th{font-weight:400;color:var(--mut);font-size:11.5px;text-align:left;padding:0 8px 6px 0;border-bottom:1px solid var(--line)}"
      + P + " td{padding:8px 8px 8px 0;border-bottom:1px solid var(--line)}"
      + P + " .shade{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;padding:60px 16px;z-index:10000}"
      + P + " .modal{width:min(560px,100%);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:16px 18px;display:grid;gap:12px}"
      + P + " .tg{white-space:pre-wrap;background:var(--strip);border:1px solid var(--line);border-radius:4px;padding:8px 10px;margin:0;font:inherit;font-size:12.5px}"
      + "@media (max-width:760px){" + P + " .steps," + P + " .grid{grid-template-columns:minmax(0,1fr)}" + P + " .grid>*{grid-column:auto!important}}";

    /* ——— дані ——— */

    function orgOf(key) { return state.data.orgs.filter(function (o) { return o.key === key; })[0]; }
    function invoices() { return state.data.invoices || []; }
    function lastInv() { return invoices()[0] || null; }
    function routeOf(lead) { return lead.cityFrom && lead.cityTo ? lead.cityFrom + " – " + lead.cityTo : ""; }

    function newForm() {
      var d = state.data, o = d.orgs.filter(function (x) { return x.available; })[0] || d.orgs[0];
      return {
        org: o.key, currency: "UAH", bank: "", agreement: "", vatType: o.vatTypes[0], dueDate: addDays(d.today, 7), actDate: "",
        crmComment: "", stamp: true,
        items: [{ service: o.services[0], route: routeOf(d.lead), qty: 1, price: d.lead.price || "", vat: o.itemVats[0] }]
      };
    }

    function calc(f) {
      var sub = 0, vat = 0;
      f.items.forEach(function (it) {
        var line = (Number(it.qty) || 0) * (Number(it.price) || 0), r = Number(it.vat) || 0;
        sub += line;
        if (f.vatType === "ПДВ в тому числі") vat += line * r / (100 + r);
      });
      return { sub: r2(sub), vat: r2(vat), total: r2(sub) };
    }

    function payChip(p) {
      if (p.k === "paid") return { k: "ok", t: "оплачено" };
      if (p.k === "part") return { k: "part", t: "частково " + money(p.paid) };
      if (p.k === "overdue") return { k: "bad", t: "прострочено" };
      if (p.k === "missing") return { k: "wait", t: "немає серед неоплачених у 1С" };
      if (p.k === "pending") return { k: "wait", t: "оплата оновиться протягом години" };
      return { k: "wait", t: "чекає оплату" };
    }
    function chip(c) { return "<span class='chip " + c.k + "'>" + esc(c.t) + "</span>"; }

    /* ——— шматки вікна ——— */

    function head() {
      var d = state.data, c = d.lead.company || {}, o = d.onec;
      var where = !c.edrpou ? "<b>у компанії немає ЄДРПОУ / ІПН</b>"
        : o.found ? "<span style='color:var(--okt)'>знайдено в 1С</span>"
          : o.error ? "<b>1С: " + esc(o.error) + "</b>"
            : "<b>у 1С немає</b> <button class='btn sm' data-z1c='customer'" + (d.canCreate && !state.busy ? "" : " disabled") + ">Створити контрагента в 1С</button>";
      return "<div class='row between' style='margin-bottom:12px'><span class='mut'>Контрагент <b style='color:var(--txt);font-weight:400'>"
        + esc(c.name || "компанію не привʼязано") + "</b>" + (c.edrpou ? " · " + (c.edrpou.length === 10 ? "ІПН " : "ЄДРПОУ ") + esc(c.edrpou) : "")
        + " · " + where + "</span>" + (d.mode === "test" ? "<span class='chip test' title='Лише тестовий контрагент ЄДРПОУ " + esc(d.testEdrpou) + "'>ТЕСТ</span>" : "") + "</div>"
        + (d.canCreate ? "" : "<div class='msg warn' style='margin:0 0 12px'>" + esc(d.blockedWhy) + "</div>");
    }

    function pdfBtns(inv) {
      return "<button class='btn sm' data-z1c='pdf' data-uid='" + esc(inv.invoice_uid) + "' data-stamp='1'>PDF</button>"
        + "<button class='btn sm' data-z1c='pdf' data-uid='" + esc(inv.invoice_uid) + "' data-stamp='0'>без печатки</button>";
    }
    function editBtn(inv) {
      return inv.can_edit
        ? "<button class='btn sm dash' disabled title='" + esc(state.data.waits.update) + "'>Змінити</button>"
        : "<button class='btn sm' data-z1c='req' data-uid='" + esc(inv.invoice_uid) + "' title='Після дня виставлення або після оплати рахунок змінює бухгалтерія'>Запит бухгалтерії</button>";
    }

    function steps() {
      var d = state.data, inv = lastInv();
      var s1 = inv
        ? "<div class='step done'><div class='h'>1 · Рахунок " + chip({ k: "ok", t: "є" }) + "</div><div class='big'>№" + esc(inv.number_print) + "</div>"
          + "<div class='mut'>" + esc(dmy(inv.invoice_date)) + " · " + esc(inv.organization) + " · " + money(inv.total) + " " + esc(inv.currency) + "</div>"
          + (inv.attach_error ? "<div class='mut'>PDF у файлах угоди немає — візьміть тут</div>" : "")
          + "<div class='row'>" + pdfBtns(inv) + "</div><div class='row'>" + editBtn(inv) + "</div>"
          + "<button class='btn link' disabled title='" + esc(d.waits.multi) + "' style='text-align:left'>+ ще рахунок</button></div>"
        : "<div class='step next'><div class='h'>1 · Рахунок " + chip({ k: "wait", t: "немає" }) + "</div><div class='big'>—</div>"
          + "<div class='mut'>Маршрут і суму підставимо з угоди</div><div><button class='btn main' data-z1c='open'" + (d.canCreate && d.onec.found ? "" : " disabled") + ">Виставити рахунок</button></div></div>";
      var p = inv ? inv.pay : null, paidAll = p && p.k === "paid";
      var ratio = inv && inv.total ? Math.min(100, Math.round(p.paid / inv.total * 100)) : 0;
      var s2 = "<div class='step " + (paidAll ? "done" : inv ? "next" : "") + "'><div class='h'>2 · Оплата " + (inv ? chip(payChip(p)) : chip({ k: "wait", t: "чекає рахунок" })) + "</div>"
        + (inv ? "<div class='big'>" + money(p.paid) + " " + esc(inv.currency) + "</div><div class='mut'>із " + money(inv.total) + " " + esc(inv.currency) + "</div>"
          + "<div class='meter'><i style='width:" + ratio + "%'></i></div><div class='mut'>приходить з 1С сама, щогодини</div>"
          : "<div class='big'>—</div><div class='mut'>зʼявиться після рахунку</div>") + "</div>";
      var s3 = "<div class='step'><div class='h'>3 · Документи " + chip({ k: "wait", t: "потім" }) + "</div>"
        + "<div class='mut'>" + esc(d.waits.docs) + "</div><div class='row'>"
        + "<button class='btn sm dash' disabled title='Зʼявиться, коли бухгалтерія проведе реалізацію в 1С'>ТТН</button>"
        + "<button class='btn sm dash' disabled title='Зʼявиться, коли бухгалтерія проведе реалізацію в 1С'>Акт</button></div></div>";
      return "<div class='steps'>" + s1 + s2 + s3 + "</div>";
    }

    function seg(act, list, cur) {
      return "<div class='seg'>" + list.map(function (x) {
        return "<button data-z1c='" + act + "' data-v='" + esc(x.v) + "' class='" + (x.v === cur ? "on" : "") + (x.off ? " off" : "") + "'"
          + (x.title ? " title='" + esc(x.title) + "'" : "") + ">" + esc(x.t) + "</button>";
      }).join("") + "</div>";
    }

    function agreementsFor(f) {
      var o = orgOf(f.org);
      return state.data.onec.agreements.filter(function (a) {
        return String(a.organization).toLowerCase().indexOf(o.match) !== -1 && (!a.currency || a.currency === f.currency);
      });
    }

    function formHtml() {
      var d = state.data, f = state.form, o = orgOf(f.org), t = calc(f);
      var orgSeg = seg("org", d.orgs.map(function (x) { return { v: x.key, t: x.short, off: !x.available, title: x.waits }; }), f.org);
      var curSeg = seg("cur", d.currencies.map(function (c) { return { v: c, t: c }; }), f.currency);
      var bankSeg = o.banks ? "<div><span class='lbl'>Рахунок " + esc(o.short) + ", на який платить клієнт</span>"
        + seg("bank", o.banks.map(function (b) { return { v: b, t: b }; }), f.bank) + "</div>" : "";
      var agrs = agreementsFor(f);
      var agrSel = "<select class='in' data-k='agreement'><option value=''>" + (agrs.length ? "основний (1С обере сама)" : "немає — 1С створить основний") + "</option>"
        + agrs.map(function (a) { return "<option value='" + esc(a.value) + "'" + (f.agreement === a.value ? " selected" : "") + ">" + esc(a.label) + "</option>"; }).join("") + "</select>";
      var vatSel = "<select class='in' data-k='vatType'" + (o.vatTypes.length < 2 ? " disabled" : "") + ">" + o.vatTypes.map(function (v) {
        return "<option" + (f.vatType === v ? " selected" : "") + ">" + esc(v) + "</option>"; }).join("") + "</select>"
        + "<span class='hint'>" + (o.vatTypes[0] === "Без ПДВ" ? "для " + esc(o.short) + " лише без ПДВ" : "для " + esc(o.short) + " лише ПДВ у тому числі") + "</span>";
      var items = f.items.map(function (it, i) {
        return "<div class='item'><div class='row between'><span class='lbl' style='margin:0'>Позиція " + (i + 1) + "</span>"
          + (f.items.length > 1 ? "<button class='x' data-z1c='rm' data-i='" + i + "' aria-label='Прибрати позицію'>✕</button>" : "") + "</div>"
          + "<label><span class='lbl'>Послуга</span><select class='in' data-i='" + i + "' data-f='service'>" + o.services.map(function (n) {
            return "<option" + (it.service === n ? " selected" : "") + ">" + esc(n) + "</option>"; }).join("") + "</select></label>"
          + "<label><span class='lbl'>Маршрут (у 1С стане після назви послуги)</span><input class='in' data-i='" + i + "' data-f='route' value='" + esc(it.route) + "' placeholder='м. Київ (Київська обл.) – м. Львів (Львівська обл.)'></label>"
          + "<div class='grid3'><label><span class='lbl'>К-ть</span><input class='in' type='number' min='0' step='1' data-i='" + i + "' data-f='qty' value='" + esc(it.qty) + "'></label>"
          + "<label><span class='lbl'>Ціна, " + esc(f.currency) + "</span><input class='in' type='number' min='0' step='0.01' data-i='" + i + "' data-f='price' value='" + esc(it.price) + "'></label>"
          + "<label><span class='lbl'>ПДВ</span><select class='in' data-i='" + i + "' data-f='vat'" + (o.itemVats.length < 2 ? " disabled" : "") + ">" + o.itemVats.map(function (r) {
            return "<option value='" + r + "'" + (Number(it.vat) === r ? " selected" : "") + ">" + r + "%</option>"; }).join("") + "</select></label></div></div>";
      }).join("");
      return "<div class='formbox'><div class='row between'><b>Новий рахунок</b><button class='x' data-z1c='close' aria-label='Закрити'>✕</button></div>"
        + "<div class='row between'><div><span class='lbl'>Від кого виставляємо</span>" + orgSeg + "</div><div><span class='lbl'>Валюта</span>" + curSeg + "</div></div>" + bankSeg
        + "<div class='grid'><label><span class='lbl'>Договір (з 1С)</span>" + agrSel + "</label><label><span class='lbl'>ПДВ</span>" + vatSel + "</label>"
        + "<div><span class='lbl'>Дата рахунку</span><div class='in ro' title='Рахунок завжди виставляється поточним числом'>" + esc(dmy(d.today)) + " · сьогодні</div></div>"
        + "<label><span class='lbl'>Оплатити до</span><input class='in' type='date' min='" + esc(d.today) + "' data-k='dueDate' value='" + esc(f.dueDate) + "'></label></div>"
        + items + "<div class='row'><button class='btn sm' data-z1c='add'>+ позиція</button></div>"
        + "<div class='grid'>"
        + "<label><span class='lbl'>Дата акту</span><input class='in' type='date' data-k='actDate' value='" + esc(f.actDate) + "'><span class='hint'>лише якщо впевнені, інакше порожньо</span></label>"
        + "<label style='grid-column:span 3'><span class='lbl'>Коментар для бухгалтерії</span><input class='in' data-k='crmComment' value='" + esc(f.crmComment) + "' placeholder='необовʼязково, у 1С піде в «Коментар СРМ»'></label></div>"
        + "<div class='hint'>" + esc(d.waits.fields) + "</div>"
        + "<label class='row' style='gap:8px'><input type='checkbox' data-k='stamp'" + (f.stamp ? " checked" : "") + "> PDF з печаткою</label>"
        + "<div class='prev'><span class='lbl' style='margin:0'>Так піде в 1С, як зараз із Genesis:</span><span>Комментарий: <b>" + esc(d.managerName ? d.managerName + ", " : "")
        + "Загружен из amoCRM по сделке №" + esc(d.lead.id) + "</b></span></div>"
        + "<div class='row between'><div class='tot' data-z1c-tot>" + totHtml(t, f) + "</div><span class='row'><button class='btn' data-z1c='close'>Скасувати</button>"
        + "<button class='btn main' data-z1c='submit'" + (state.busy ? " disabled" : "") + ">" + (state.busy ? "Відправляємо в 1С…" : "Виставити в 1С") + "</button></span></div></div>";
    }
    function totHtml(t, f) {
      return "Сума <b>" + money(t.sub) + "</b>"
        + (f.vatType !== "Без ПДВ" ? " · ПДВ <b>" + money(t.vat) + "</b>" : "") + " · Разом <b>" + money(t.total) + " " + esc(f.currency) + "</b>";
    }

    function reqText(inv, what) {
      var d = state.data;
      return "Запит на зміну рахунку №" + inv.number_print + " від " + dmy(inv.invoice_date) + "\nУгода Kommo №" + d.lead.id + ", "
        + ((d.lead.company && d.lead.company.name) || "") + "\nСума: " + money(inv.total) + " " + inv.currency + "\nЩо змінити: " + (what || "…");
    }
    function modalHtml() {
      var m = state.modal;
      if (!m) return "";
      var inv = invoices().filter(function (x) { return x.invoice_uid === m.uid; })[0];
      if (!inv) return "";
      return "<div class='shade'><div class='modal' role='dialog' aria-label='Запит бухгалтерії'><div class='row between'><b>Запит бухгалтерії · рахунок №" + esc(inv.number_print) + "</b>"
        + "<button class='x' data-z1c='mclose' aria-label='Закрити'>✕</button></div>"
        + "<p class='mut' style='margin:0'>Рахунок виставлено не сьогодні або вже оплачено, тому змінює його бухгалтерія. Поки запити йдуть у Telegram: напишіть, що змінити, скопіюйте текст і надішліть у чат бухгалтерії.</p>"
        + "<label><span class='lbl'>Що змінити</span><textarea class='in' rows='3' data-z1c-req placeholder='Наприклад: змінити суму на 1 750 EUR, клієнт погодив знижку'>" + esc(m.text || "") + "</textarea></label>"
        + "<div><span class='lbl'>Текст для Telegram</span><pre class='tg' data-z1c-prev>" + esc(reqText(inv, m.text)) + "</pre></div>"
        + (m.note ? "<div class='msg warn' style='margin:0'>" + esc(m.note) + "</div>" : "")
        + "<div class='row between'><span class='mut'>Видалити рахунок не можна</span><span class='row'><button class='btn' data-z1c='mclose'>Скасувати</button>"
        + "<button class='btn main' data-z1c='reqsend'>" + (m.manual ? "Надіслав" : "Скопіювати для Telegram") + "</button></span></div></div></div>";
    }

    function render() {
      var d = state.data;
      if (!d) return;
      var many = invoices().length > 1;
      root().html("<div class='" + NS + (isDark() ? " dark" : "") + "'><style>" + CSS + "</style>" + head() + steps()
        + (state.form ? formHtml() : "")
        + (state.msg ? "<div class='msg " + state.msg.kind + "'>" + esc(state.msg.text) + "</div>" : "")
        + (many ? "<div style='margin-top:16px'><b>Усі рахунки угоди</b><table><tr><th>№</th><th>Дата</th><th>Організація</th><th>Сума</th><th>Оплата</th><th></th></tr>"
          + invoices().map(function (i) {
            return "<tr><td><b>" + esc(i.number_print) + "</b></td><td>" + esc(dmy(i.invoice_date)) + "</td><td>" + esc(i.organization) + "</td><td>" + money(i.total) + " " + esc(i.currency)
              + "</td><td>" + chip(payChip(i.pay)) + "</td><td><span class='row' style='gap:6px'>" + pdfBtns(i) + editBtn(i) + "</span></td></tr>";
          }).join("") + "</table></div>" : "")
        + modalHtml() + "</div>");
    }

    /* ——— дії ——— */

    function say(kind, text) { state.msg = { kind: kind, text: text }; }

    function load() {
      var id = leadId();
      if (!id) return Promise.resolve();
      if (!state.data) root().html("<div class='" + NS + "'>Завантаження…</div>");
      return api("GET", "/lead/" + id).then(function (d) {
        state.data = d; render();
      }).catch(function (e) { root().html("<div class='" + NS + "' style='color:#a12626'>" + esc(e.message) + "</div>"); });
    }

    function submit() {
      if (state.busy || !state.form) return;
      var f = state.form, o = orgOf(f.org);
      if (!o.available) { say("err", o.waits); render(); return; }
      if (o.banks && !f.bank) { say("err", "Оберіть рахунок " + o.short + ": " + o.banks.join(" чи ") + "."); render(); return; }
      if (f.dueDate && f.dueDate < state.data.today) { say("err", "«Оплатити до» не може бути в минулому."); render(); return; }
      state.busy = true; state.msg = null; render();
      api("POST", "/lead/" + leadId() + "/invoice", f).then(function (r) {
        var inv = r.invoice;
        say(inv.existed || !r.attached || (inv.warnings && inv.warnings.length) ? "warn" : "ok",
          (inv.existed ? "У 1С уже був рахунок цієї угоди: " : "Рахунок ") + "№" + inv.number + " · " + inv.organization + " · " + money(inv.total) + " " + inv.currency
          + (r.attached ? " · PDF у файлах угоди" : (inv.existed ? "" : " · PDF не прикріпився: " + (r.attachError || "")))
          + (inv.warnings && inv.warnings.length ? " · " + inv.warnings.join("; ") : ""));
        state.form = null;
        return load();
      }).catch(function (e) { say("err", e.message); })
        .then(function () { state.busy = false; render(); });
    }

    function createCustomer() {
      if (state.busy) return;
      state.busy = true; state.msg = null; render();
      api("POST", "/lead/" + leadId() + "/customer", {}).then(function (r) {
        say(r.warnings && r.warnings.length ? "warn" : "ok", (r.existed ? "Контрагент у 1С уже був." : "Контрагента створено в 1С.")
          + (r.warnings && r.warnings.length ? " " + r.warnings.join("; ") : ""));
        return load();
      }).catch(function (e) { say("err", e.message); })
        .then(function () { state.busy = false; render(); });
    }

    /** Файл з JSON `{fileName, base64}` → завантаження в браузері (запит лише підписаним каналом). */
    function download(path, type) {
      api("GET", path).then(function (r) {
        var bin = atob(r.base64), bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var url = URL.createObjectURL(new Blob([bytes], { type: type }));
        var a = document.createElement("a");
        a.href = url; a.download = r.fileName; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      }).catch(function (e) { say("err", e.message); render(); });
    }

    function sendRequest() {
      var m = state.modal, inv = invoices().filter(function (x) { return x.invoice_uid === m.uid; })[0];
      var what = String(m.text || "").trim();
      if (!what) { say("err", "Напишіть, що саме змінити в рахунку."); state.modal = null; render(); return; }
      var text = reqText(inv, what);
      var done = function () {
        api("POST", "/lead/" + leadId() + "/invoice/" + m.uid + "/request", { text: what }).then(function () {
          say("ok", (m.manual ? "Запит записано в стрічку угоди." : "Текст скопійовано. Вставте його в чат бухгалтерії в Telegram. У стрічці угоди зʼявився запис про запит."));
        }).catch(function (e) { say("err", e.message); }).then(function () { state.modal = null; render(); });
      };
      var settled = false;
      var once = function (fn) { return function () { if (!settled) { settled = true; fn(); } }; };
      /** Буфер недоступний (заборонено або браузер мовчить) — виділяємо текст у вікні й кажемо це там само. */
      var manual = once(function () {
        m.note = "Скопіювати автоматично не вдалося. Текст виділено — скопіюйте його вручну (Ctrl+C), надішліть у Telegram і натисніть «Надіслав».";
        m.manual = true; render();
        var pr = root().find("[data-z1c-prev]")[0];
        if (pr) { var rg = document.createRange(); rg.selectNodeContents(pr); var sel = getSelection(); sel.removeAllRanges(); sel.addRange(rg); }
      });
      if (m.manual) { done(); return; }
      setTimeout(manual, 1500);
      try { navigator.clipboard.writeText(text).then(once(done), manual); } catch (e) { manual(); }
    }

    function onClick(e) {
      var b = $(e.currentTarget), a = b.data("z1c"), f = state.form;
      e.preventDefault();
      if (b.prop("disabled")) return;
      if (a === "open") { state.form = newForm(); state.msg = null; }
      else if (a === "close") state.form = null;
      else if (a === "org") {
        var o = orgOf(String(b.data("v")));
        if (!o.available) { say("warn", o.waits); render(); return; }
        f.org = o.key; f.bank = ""; f.agreement = ""; f.vatType = o.vatTypes[0];
        f.items.forEach(function (it) { if (o.services.indexOf(it.service) === -1) it.service = o.services[0]; it.vat = o.itemVats[0]; });
        state.msg = null;
      }
      else if (a === "cur") { f.currency = String(b.data("v")); f.agreement = ""; }
      else if (a === "bank") f.bank = String(b.data("v"));
      else if (a === "add") { var oo = orgOf(f.org); f.items.push({ service: oo.services[0], route: "", qty: 1, price: "", vat: oo.itemVats[0] }); }
      else if (a === "rm") f.items.splice(Number(b.data("i")), 1);
      else if (a === "submit") { submit(); return; }
      else if (a === "customer") { createCustomer(); return; }
      else if (a === "pdf") { download("/lead/" + leadId() + "/invoice/" + b.data("uid") + "/pdf?stamp=" + b.data("stamp"), "application/pdf"); return; }
      else if (a === "req") state.modal = { uid: String(b.data("uid")), text: "" };
      else if (a === "mclose") state.modal = null;
      else if (a === "reqsend") { sendRequest(); return; }
      render();
    }

    /** Поля форми пишемо в стан без перемальовування — інакше губиться курсор; суму оновлюємо на місці. */
    function onInput(e) {
      var el = $(e.currentTarget), f = state.form;
      if (el.is("[data-z1c-req]")) {
        state.modal.text = el.val();
        var inv = invoices().filter(function (x) { return x.invoice_uid === state.modal.uid; })[0];
        root().find("[data-z1c-prev]").text(reqText(inv, String(el.val()).trim()));
        return;
      }
      if (!f) return;
      var k = el.data("k"), i = el.data("i");
      if (k) f[k] = el.is(":checkbox") ? el.prop("checked") : el.val();
      else if (i !== undefined) f.items[Number(i)][el.data("f")] = el.val();
      root().find("[data-z1c-tot]").html(totHtml(calc(f), f));
    }

    this.callbacks = {
      render: function () { return true; },
      init: function () { return true; },
      bind_actions: function () {
        var sel = "#" + settings().widget_code;
        $(document).off("." + NS)
          .on("click." + NS, sel + " [data-z1c]", onClick)
          .on("input." + NS + " change." + NS, sel + " ." + NS + " .in, " + sel + " ." + NS + " input[type=checkbox]", onInput);
        return true;
      },
      settings: function () { return true; },
      onSave: function () { return true; },
      destroy: function () { $(document).off("." + NS); },
      /** Вкладка: `{}` — постійна вкладка (прийом Genesis); `[]` — вкладки немає. */
      loadPreloadedData: function () {
        if (!allowedHere()) return Promise.resolve([]);
        setTimeout(load, 0);
        return Promise.resolve({});
      },
      loadElements: function () { return Promise.resolve([]); },
      linkCard: function () { return Promise.resolve(); },
      searchDataInCard: function () { return Promise.resolve([]); }
    };
    return this;
  };
});
