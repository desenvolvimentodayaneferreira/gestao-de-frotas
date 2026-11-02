"use strict";

// Componentes de interface reutilizáveis: avisos, formulários, confirmações e tabelas.
Frotas.ui = (() => {
  const { esc, parseNumber } = Frotas.util;
  let toastTimer = null;

  function toast(message, type = "success") {
    const element = document.querySelector("#toast");
    clearTimeout(toastTimer);
    element.textContent = message;
    element.dataset.type = type;
    element.classList.add("show");
    toastTimer = setTimeout(() => element.classList.remove("show"), 3600);
  }

  function status(text, type = "success") {
    return `<span class="status ${type}">${esc(text)}</span>`;
  }

  function vehicleCell(vehicle, extra = "") {
    if (!vehicle) return `<div class="vehicle-cell"><span class="vehicle-symbol">?</span><div><strong>Veículo removido</strong></div></div>`;
    const symbol = vehicle.type === "Moto" ? "M" : vehicle.type === "Caminhão" ? "C" : vehicle.type === "Utilitário" ? "U" : "V";
    const plate = vehicle.plate ? Frotas.util.formatPlate(vehicle.plate) : "Sem placa";
    const scope = vehicle.scope === "autorizado" ? " · Autorizado" : "";
    return `<div class="vehicle-cell"><span class="vehicle-symbol ${vehicle.scope === "autorizado" ? "authorized" : ""}">${symbol}</span><div><strong>${esc(vehicle.name)}</strong><small>${esc(plate)}${scope}${extra}</small></div></div>`;
  }

  function personCell(name, detail) {
    return `<div class="person-cell"><span class="person-symbol">${esc(Frotas.util.initials(name))}</span><div><strong>${esc(name)}</strong><small>${esc(detail || "")}</small></div></div>`;
  }

  function empty(title, text, action = "") {
    return `<div class="empty-block"><div class="empty-icon">○</div><strong>${esc(title)}</strong><p>${esc(text)}</p>${action}</div>`;
  }

  // ---------- Formulários ----------

  function optionList(options, value) {
    return options.map((option) => {
      const item = typeof option === "string" ? { value: option, label: option } : option;
      const selected = String(item.value) === String(value ?? "") ? " selected" : "";
      return `<option value="${esc(item.value)}"${selected}>${esc(item.label)}</option>`;
    }).join("");
  }

  function fieldHtml(field, value) {
    const id = `field-${field.name}`;
    const required = field.required ? " required" : "";
    const span = field.full ? " full" : "";
    const help = field.help ? `<small class="field-help">${esc(field.help)}</small>` : "";
    const label = `${esc(field.label)}${field.required ? ' <em class="required-mark">*</em>' : ""}`;
    let control;
    switch (field.type) {
      case "select":
        control = `<select id="${id}" name="${field.name}"${required}>${field.placeholder !== false ? `<option value="">${esc(field.placeholder || "Selecione")}</option>` : ""}${optionList(field.options || [], value)}</select>`;
        break;
      case "textarea":
        control = `<textarea id="${id}" name="${field.name}" rows="3" placeholder="${esc(field.placeholder || "")}"${required}>${esc(value ?? "")}</textarea>`;
        break;
      case "checkbox":
        return `<label class="check-field${span}"><input id="${id}" name="${field.name}" type="checkbox"${value ? " checked" : ""} /> ${esc(field.label)}${help}</label>`;
      case "file":
        control = `<input id="${id}" name="${field.name}" type="file" accept="${esc(field.accept || "")}" />${value ? `<small class="field-help">Arquivo atual mantido se nenhum novo for escolhido.</small>` : ""}`;
        break;
      case "decimal":
        control = `<input id="${id}" name="${field.name}" type="text" inputmode="decimal" value="${esc(value ?? "")}" placeholder="${esc(field.placeholder || "")}"${required} />`;
        break;
      default:
        control = `<input id="${id}" name="${field.name}" type="${field.type || "text"}" value="${esc(value ?? "")}" placeholder="${esc(field.placeholder || "")}"${field.min !== undefined ? ` min="${field.min}"` : ""}${field.max !== undefined ? ` max="${field.max}"` : ""}${field.step ? ` step="${field.step}"` : ""}${field.autocomplete ? ` autocomplete="${field.autocomplete}"` : ""}${required} />`;
    }
    return `<label class="${span.trim()}" for="${id}"><span>${label}</span>${control}${help}</label>`;
  }

  function readForm(form, fields) {
    const values = {};
    fields.forEach((field) => {
      const input = form.elements[field.name];
      if (!input) return;
      if (field.type === "checkbox") values[field.name] = input.checked;
      else if (field.type === "file") values[field.name] = input.files[0] || null;
      else if (field.type === "number" || field.type === "decimal") values[field.name] = parseNumber(input.value);
      else values[field.name] = input.value.trim();
    });
    return values;
  }

  /**
   * Abre um formulário em janela. onSubmit pode lançar erro com mensagem para o usuário;
   * a janela só fecha quando a gravação termina sem erros.
   */
  function openForm({ title, eyebrow = "", fields, values = {}, submitLabel = "Salvar", onSubmit, intro = "", wide = false }) {
    const dialog = document.querySelector("#form-dialog");
    dialog.classList.toggle("wide", wide);
    dialog.innerHTML = `
      <form novalidate>
        <div class="dialog-heading">
          <div>${eyebrow ? `<span class="eyebrow">${esc(eyebrow)}</span>` : ""}<h3>${esc(title)}</h3></div>
          <button type="button" class="dialog-close" data-close aria-label="Fechar">×</button>
        </div>
        ${intro ? `<div class="dialog-intro">${intro}</div>` : ""}
        <div class="form-grid">${fields.map((field) => fieldHtml(field, values[field.name])).join("")}</div>
        <p class="form-error" role="alert"></p>
        <div class="dialog-actions">
          <button type="button" class="secondary-button" data-close>Cancelar</button>
          <button type="submit" class="primary-button">${esc(submitLabel)}</button>
        </div>
      </form>`;
    const form = dialog.querySelector("form");
    const error = dialog.querySelector(".form-error");
    dialog.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => dialog.close()));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        await onSubmit(readForm(form, fields), form);
        dialog.close();
      } catch (problem) {
        error.textContent = problem.message || String(problem);
      } finally {
        submit.disabled = false;
      }
    });
    dialog.showModal();
    form.querySelector("input:not([type=hidden]), select, textarea")?.focus();
    return form;
  }

  function confirm(message, { title = "Confirmar ação", confirmLabel = "Confirmar", danger = false } = {}) {
    return new Promise((resolve) => {
      const dialog = document.querySelector("#confirm-dialog");
      dialog.innerHTML = `
        <form method="dialog">
          <div class="dialog-heading"><div><h3>${esc(title)}</h3></div></div>
          <p class="confirm-message">${esc(message)}</p>
          <div class="dialog-actions">
            <button value="no" class="secondary-button">Cancelar</button>
            <button value="yes" class="${danger ? "danger-button" : "primary-button"}">${esc(confirmLabel)}</button>
          </div>
        </form>`;
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true });
      dialog.showModal();
    });
  }

  // ---------- Tabelas com ordenação, busca e paginação ----------

  const tableState = {};

  function stripTags(html) {
    return String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();
  }

  function table({ id, columns, rows, pageSize = 20, emptyText = "Nenhum registro encontrado.", rowAttrs = () => "" }) {
    const state = tableState[id] || (tableState[id] = { sort: null, dir: 1, page: 0 });
    const term = Frotas.app?.searchTerm?.() || "";
    let data = rows;

    if (term) {
      data = data.filter((row) => columns.some((column) => stripTags(column.render(row)).includes(term)));
    }
    if (state.sort !== null) {
      const column = columns[state.sort];
      const value = column.sortValue || ((row) => stripTags(column.render(row)));
      data = [...data].sort((a, b) => {
        const first = value(a);
        const second = value(b);
        if (first === second) return 0;
        if (first === null || first === undefined || first === "") return 1;
        if (second === null || second === undefined || second === "") return -1;
        return (first > second ? 1 : -1) * state.dir;
      });
    }

    const pages = Math.max(1, Math.ceil(data.length / pageSize));
    state.page = Math.min(state.page, pages - 1);
    const visible = data.slice(state.page * pageSize, (state.page + 1) * pageSize);

    const head = columns.map((column, index) => {
      const sortable = column.sortable !== false;
      const arrow = state.sort === index ? (state.dir === 1 ? " ▲" : " ▼") : "";
      return `<th class="${column.align === "right" ? "align-right" : ""}${sortable ? " sortable" : ""}"${sortable ? ` data-table-sort="${id}:${index}"` : ""}>${esc(column.label)}${arrow}</th>`;
    }).join("");

    const body = visible.length
      ? visible.map((row) => `<tr ${rowAttrs(row)}>${columns.map((column) => `<td class="${column.align === "right" ? "align-right" : ""}">${column.render(row)}</td>`).join("")}</tr>`).join("")
      : `<tr><td colspan="${columns.length}" class="empty-state">${esc(term ? "Nenhum resultado para a busca." : emptyText)}</td></tr>`;

    const pager = pages > 1 ? `
      <div class="table-pager">
        <span>${data.length} registro(s) · página ${state.page + 1} de ${pages}</span>
        <div>
          <button class="secondary-button small" data-table-page="${id}:${state.page - 1}"${state.page === 0 ? " disabled" : ""}>Anterior</button>
          <button class="secondary-button small" data-table-page="${id}:${state.page + 1}"${state.page >= pages - 1 ? " disabled" : ""}>Próxima</button>
        </div>
      </div>` : `<div class="table-pager"><span>${data.length} registro(s)</span></div>`;

    return `<div class="table-wrap"><table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${pager}`;
  }

  function handleTableClick(event) {
    const sortButton = event.target.closest("[data-table-sort]");
    if (sortButton) {
      const [id, index] = sortButton.dataset.tableSort.split(":");
      const state = tableState[id];
      const column = Number(index);
      if (state.sort === column) state.dir *= -1;
      else {
        state.sort = column;
        state.dir = 1;
      }
      return true;
    }
    const pageButton = event.target.closest("[data-table-page]");
    if (pageButton) {
      const [id, page] = pageButton.dataset.tablePage.split(":");
      tableState[id].page = Math.max(0, Number(page));
      return true;
    }
    return false;
  }

  function resetPages() {
    Object.values(tableState).forEach((state) => {
      state.page = 0;
    });
  }

  return { toast, status, vehicleCell, personCell, empty, openForm, confirm, table, handleTableClick, resetPages, optionList };
})();
