/**
 * 🧾 «ТЕСТ ЗАКАЗ 1С» — віджет Kommo (вкладка в картці угоди). Вікно рахунку малюється ТУТ, у вкладці; сервер —
 * дашборд (`/api/zakaz1c`, тека `backend/src/zakaz1c/`). Усі запити — через `self.$authorizedAjax`: Kommo додає
 * підписаний `X-Auth-Token`, сервер перевіряє підпис секретом інтеграції. Ключів і паролів у цьому файлі немає.
 *
 * Вкладка — прийом Genesis (розібрано 23.10.2026): `card_sdk` + `lcard-0`, `loadPreloadedData` повертає ОБʼЄКТ `{}`
 * (тоді Kommo тримає вкладку постійно), а вміст малюємо в контейнер `#<widget_code>`. Кому не можна — повертаємо `[]`,
 * і вкладки немає. Список тих, кому можна, — поле «testers» у налаштуваннях інтеграції.
 */
define(["jquery"], function ($) {
  return function () {
    var self = this;
    var NS = "z1c";
    var state = { lead: null, data: null, busy: false };

    function settings() { return self.get_settings() || {}; }
    function apiBase() { return String(settings().api_url || "https://dashboard.uts.ua/api/zakaz1c").replace(/\/+$/, ""); }
    function testers() {
      return String(settings().testers || "").split(/[,\s]+/).map(Number).filter(function (n) { return n > 0; });
    }
    function me() { return Number(AMOCRM.constant("user").id); }
    function allowedHere() { return testers().indexOf(me()) !== -1; }
    function leadId() { return AMOCRM.data && AMOCRM.data.current_card ? Number(AMOCRM.data.current_card.id) : 0; }
    function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
    function money(n) { return (Math.round(Number(n || 0) * 100) / 100).toLocaleString("uk-UA", { minimumFractionDigits: 2 }); }

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

    var CSS = "." + NS + "{padding:14px 18px;font-size:14px;color:#2e3640}"
      + "." + NS + " h3{margin:0 0 10px;font-size:16px;display:flex;gap:8px;align-items:center}"
      + "." + NS + " .badge{font-size:11px;padding:2px 6px;border-radius:4px;background:#fdecc8;color:#8a5a00}"
      + "." + NS + " .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 14px;margin:10px 0}"
      + "." + NS + " label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#6b7785}"
      + "." + NS + " input,." + NS + " select,." + NS + " textarea{font-size:14px;padding:6px 8px;border:1px solid #d4d9de;border-radius:4px;color:#2e3640;background:#fff}"
      + "." + NS + " table{width:100%;border-collapse:collapse;margin:8px 0}"
      + "." + NS + " th{font-size:12px;color:#6b7785;text-align:left;font-weight:normal;padding:4px}"
      + "." + NS + " td{padding:3px 4px;vertical-align:top}"
      + "." + NS + " td input{width:100%;box-sizing:border-box}"
      + "." + NS + " .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:8px 0}"
      + "." + NS + " .btn{padding:7px 14px;border-radius:4px;border:1px solid #d4d9de;background:#fff;cursor:pointer}"
      + "." + NS + " .btn.main{background:#4c8bf7;border-color:#4c8bf7;color:#fff}"
      + "." + NS + " .btn[disabled]{opacity:.5;cursor:default}"
      + "." + NS + " .msg{padding:8px 10px;border-radius:4px;margin:8px 0}"
      + "." + NS + " .msg.err{background:#fde7e7;color:#a12626}"
      + "." + NS + " .msg.ok{background:#e6f6ea;color:#1f6b33}"
      + "." + NS + " .msg.warn{background:#fdf3dc;color:#7a5600}"
      + "." + NS + " .muted{color:#8a95a1;font-size:12px}"
      + "." + NS + " .inv{border-top:1px solid #eef0f2;padding:8px 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap}";

    function defaultItemName(currency) {
      return currency === "UAH" ? "Організація перевезення в межах території України" : "Організація міжнародного перевезення";
    }

    function itemRow(it) {
      return "<tr class='" + NS + "-item'>"
        + "<td><input data-k='name' value='" + esc(it.name) + "'></td>"
        + "<td><input data-k='content' value='" + esc(it.content) + "'></td>"
        + "<td style='width:70px'><input data-k='qty' type='number' min='0' step='any' value='" + esc(it.qty) + "'></td>"
        + "<td style='width:120px'><input data-k='price' type='number' min='0' step='any' value='" + esc(it.price) + "'></td>"
        + "<td style='width:80px'><select data-k='vat'>" + [20, 14, 7, 0].map(function (v) {
          return "<option value='" + v + "'" + (Number(it.vat) === v ? " selected" : "") + ">" + (v ? v + "%" : "Без ПДВ") + "</option>";
        }).join("") + "</select></td>"
        + "<td style='width:30px'><button class='btn " + NS + "-del' title='Прибрати'>×</button></td></tr>";
    }

    function render() {
      var d = state.data, el = root();
      if (!d) return;
      var lead = d.lead, company = lead.company || {};
      var cur = "UAH";
      var content = [lead.cityFrom && lead.cityTo ? lead.cityFrom + " – " + lead.cityTo : lead.name, lead.car].filter(Boolean).join(", ");
      var html = "<div class='" + NS + "'><style>" + CSS + "</style>"
        + "<h3>Рахунок у 1С" + (d.mode === "test" ? " <span class='badge'>ТЕСТ · лише ЄДРПОУ " + esc(d.testEdrpou) + "</span>" : "") + "</h3>"
        + "<div class='muted'>Контрагент: <b>" + esc(company.name || "компанію не привʼязано") + "</b>"
        + (company.edrpou ? " · ЄДРПОУ " + esc(company.edrpou) : " · <b>немає ЄДРПОУ</b>")
        + (d.onec.found ? " · у 1С: " + esc(d.onec.name) : (company.edrpou ? " · <b>у 1С не знайдено</b>" : "")) + "</div>"
        + (d.canCreate ? "" : "<div class='msg warn'>" + esc(d.blockedWhy) + "</div>")
        + "<div class='grid'>"
        + "<label>Організація<select data-f='organization'>" + d.organizations.map(function (o) {
          return "<option value='" + esc(o.value) + "'>" + esc(o.label) + "</option>"; }).join("") + "</select></label>"
        + "<label>Договір<select data-f='agreement'><option value=''>Основний (1С обере сама)</option>" + d.onec.agreements.map(function (a) {
          return "<option value='" + esc(a.value) + "'>" + esc(a.label) + "</option>"; }).join("") + "</select></label>"
        + "<label>Валюта<select data-f='currency'>" + d.currencies.map(function (c) {
          return "<option" + (c === cur ? " selected" : "") + ">" + c + "</option>"; }).join("") + "</select></label>"
        + "<label>ПДВ<select data-f='vatType'>" + d.vatTypes.map(function (v) {
          return "<option" + (v === "ПДВ в тому числі" ? " selected" : "") + ">" + esc(v) + "</option>"; }).join("") + "</select></label>"
        + "<label>Дата рахунку<input type='date' data-f='invoiceDate'></label>"
        + "<label>Оплатити до<input type='date' data-f='dueDate'></label>"
        + "<label>Знижка, сума<input type='number' min='0' step='any' value='0' data-f='discount'></label>"
        + "<label>Печатка<select data-f='stamp'><option value='1'>З печаткою</option><option value='0'>Без печатки</option></select></label>"
        + "</div>"
        + "<table><thead><tr><th>Найменування</th><th>Зміст (маршрут, авто)</th><th>К-ть</th><th>Ціна</th><th>ПДВ</th><th></th></tr></thead><tbody>"
        + itemRow({ name: defaultItemName(cur), content: content, qty: 1, price: lead.price || "", vat: 20 })
        + "</tbody></table>"
        + "<div class='row'><button class='btn " + NS + "-add'>+ позиція</button><span class='muted " + NS + "-total'></span></div>"
        + "<label>Коментар<textarea rows='2' data-f='comment'></textarea></label>"
        + "<div class='row'><button class='btn main " + NS + "-create'" + (d.canCreate ? "" : " disabled") + ">Створити рахунок</button>"
        + "<span class='muted'>Повторне натискання не створює дубль: 1С поверне той самий рахунок угоди.</span></div>"
        + "<div class='" + NS + "-msg'></div>"
        + "<h3 style='margin-top:16px'>Рахунки угоди</h3><div class='" + NS + "-list'>" + listHtml(d.invoices) + "</div>"
        + "<h3 style='margin-top:16px'>ТТН</h3><div class='row'>" + (d.ttn
          ? "<button class='btn " + NS + "-ttn'>⬇ ТТН (Excel)</button><span class='muted'>із заявки перевізнику в Конструкторі дашборда від " + esc(d.ttn.createdAt) + "</span>"
          : "<span class='muted'>Немає заявки перевізнику в Конструкторі дашборда для цієї угоди — ТТН береться з неї.</span>") + "</div>"
        + "</div>";
      el.html(html);
      recalc();
    }

    function listHtml(rows) {
      if (!rows || !rows.length) return "<div class='muted'>Ще не створювались.</div>";
      return rows.map(function (r) {
        return "<div class='inv'><b>№" + esc(r.number_print) + "</b><span>" + esc(String(r.invoice_date).slice(0, 10)) + "</span>"
          + "<span>" + esc(r.organization) + "</span><span>" + money(r.total) + " " + esc(r.currency) + "</span>"
          + (r.attach_error ? "<span class='muted'>PDF у файлах угоди немає</span>" : "")
          + "<button class='btn " + NS + "-pdf' data-uid='" + esc(r.invoice_uid) + "' data-stamp='1'>PDF</button>"
          + "<button class='btn " + NS + "-pdf' data-uid='" + esc(r.invoice_uid) + "' data-stamp='0'>PDF без печатки</button></div>";
      }).join("");
    }

    function readForm() {
      var el = root(), f = {};
      el.find("[data-f]").each(function () { f[$(this).data("f")] = $(this).val(); });
      var items = el.find("." + NS + "-item").map(function () {
        var it = {};
        $(this).find("[data-k]").each(function () { it[$(this).data("k")] = $(this).val(); });
        return it;
      }).get();
      return {
        organization: f.organization, agreement: f.agreement, currency: f.currency, vatType: f.vatType,
        discount: Number(f.discount || 0), invoiceDate: f.invoiceDate || "", dueDate: f.dueDate || "", comment: f.comment || "",
        stamp: f.stamp !== "0",
        items: items.map(function (it) { return { name: it.name, content: it.content, qty: Number(it.qty), price: Number(it.price), vat: Number(it.vat) }; })
      };
    }

    function recalc() {
      var f = readForm();
      var sum = f.items.reduce(function (t, it) { return t + (it.qty || 0) * (it.price || 0); }, 0) - (f.discount || 0);
      root().find("." + NS + "-total").text("Разом: " + money(sum) + " " + f.currency);
    }

    function message(kind, text) { root().find("." + NS + "-msg").html("<div class='msg " + kind + "'>" + esc(text) + "</div>"); }

    function load() {
      var id = leadId();
      if (!id) return;
      root().html("<div class='" + NS + "' style='padding:14px 18px'>Завантаження…</div>");
      api("GET", "/lead/" + id).then(function (d) { state.data = d; render(); })
        .catch(function (e) { root().html("<div class='" + NS + "' style='padding:14px 18px;color:#a12626'>" + esc(e.message) + "</div>"); });
    }

    function create() {
      if (state.busy) return;
      state.busy = true;
      var btn = root().find("." + NS + "-create").prop("disabled", true).text("Створюю в 1С…");
      api("POST", "/lead/" + leadId() + "/invoice", readForm()).then(function (r) {
        var inv = r.invoice;
        var text = (inv.existed ? "Рахунок уже був: " : "Створено рахунок ") + "№" + inv.number + " · " + inv.organization + " · "
          + money(inv.total) + " " + inv.currency
          + (r.attached ? " · PDF у файлах угоди" : (inv.existed ? "" : " · PDF не прикріпився: " + (r.attachError || "")))
          + (inv.warnings && inv.warnings.length ? " · 1С: " + inv.warnings.join("; ") : "");
        message(inv.existed || !r.attached ? "warn" : "ok", text);
        return api("GET", "/lead/" + leadId()).then(function (d) { state.data.invoices = d.invoices; root().find("." + NS + "-list").html(listHtml(d.invoices)); });
      }).catch(function (e) { message("err", e.message); })
        .then(function () { state.busy = false; btn.prop("disabled", !state.data.canCreate).text("Створити рахунок"); });
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
      }).catch(function (e) { message("err", e.message); });
    }
    function openPdf(uid, stamp) { download("/lead/" + leadId() + "/invoice/" + uid + "/pdf?stamp=" + stamp, "application/pdf"); }
    function openTtn() { download("/lead/" + leadId() + "/ttn", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); }

    this.callbacks = {
      render: function () { return true; },
      init: function () { return true; },
      bind_actions: function () {
        var sel = "#" + settings().widget_code;
        $(document).off("." + NS)
          .on("click." + NS, sel + " ." + NS + "-create", function (e) { e.preventDefault(); create(); })
          .on("click." + NS, sel + " ." + NS + "-add", function (e) {
            e.preventDefault();
            var f = readForm();
            root().find("tbody").append(itemRow({ name: defaultItemName(f.currency), content: "", qty: 1, price: "", vat: f.currency === "UAH" ? 20 : 0 }));
            recalc();
          })
          .on("click." + NS, sel + " ." + NS + "-del", function (e) {
            e.preventDefault();
            if (root().find("." + NS + "-item").length > 1) $(this).closest("tr").remove();
            recalc();
          })
          .on("click." + NS, sel + " ." + NS + "-pdf", function (e) { e.preventDefault(); openPdf($(this).data("uid"), $(this).data("stamp")); })
          .on("click." + NS, sel + " ." + NS + "-ttn", function (e) { e.preventDefault(); openTtn(); })
          .on("input." + NS + " change." + NS, sel + " input, " + sel + " select", recalc);
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
