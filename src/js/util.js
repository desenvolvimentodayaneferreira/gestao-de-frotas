"use strict";

// Funções utilitárias compartilhadas por todo o sistema.
window.Frotas = window.Frotas || {};

Frotas.util = (() => {
  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  // Todo texto digitado pelo usuário passa por aqui antes de ir para a tela.
  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
  }

  const currencyFormat = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const currencyShort = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

  function money(value) {
    return currencyFormat.format(Number(value) || 0);
  }

  function moneyShort(value) {
    return currencyShort.format(Number(value) || 0);
  }

  function number(value, digits = 0) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    return Number(value).toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function percent(value, total) {
    if (!total) return "0%";
    return `${number((value / total) * 100, 1)}%`;
  }

  // Aceita "1.234,56", "1234,56" e "1234.56".
  function parseNumber(value) {
    if (typeof value === "number") return value;
    const text = String(value ?? "").trim();
    if (!text) return null;
    const normalized = text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function todayISO() {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function addDays(iso, days) {
    const date = new Date(`${iso}T12:00:00`);
    date.setDate(date.getDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function daysBetween(fromIso, toIso) {
    return Math.round((new Date(`${toIso}T12:00:00`) - new Date(`${fromIso}T12:00:00`)) / 86400000);
  }

  function dateBR(iso) {
    if (!iso) return "—";
    const [year, month, day] = String(iso).slice(0, 10).split("-");
    if (!year || !month || !day) return String(iso);
    return `${day}/${month}/${year}`;
  }

  function dateTimeBR(timestamp) {
    if (!timestamp) return "—";
    return new Date(timestamp).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }

  function monthLabel(key) {
    const [year, month] = key.split("-");
    const name = new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(new Date(Number(year), Number(month) - 1, 1));
    return `${name.replace(".", "")}/${year.slice(2)}`;
  }

  function longToday() {
    const text = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(new Date());
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function relativeTime(timestamp) {
    if (!timestamp) return "sem registro";
    const minutes = Math.round((Date.now() - timestamp) / 60000);
    if (minutes < 1) return "agora";
    if (minutes < 60) return `há ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `há ${hours} h`;
    return `há ${Math.round(hours / 24)} dia(s)`;
  }

  function uid(prefix = "id") {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  // Placas no padrão antigo (ABC1234) e Mercosul (ABC1D23), com ou sem hífen.
  // Exige limite de palavra para não confundir "Saveiro 2010" com uma placa.
  const PLATE_PATTERN = /\b([A-Z]{3})-?(\d[A-Z0-9]\d{2})\b/;

  function extractPlate(text) {
    const match = String(text || "").toUpperCase().match(PLATE_PATTERN);
    return match ? `${match[1]}${match[2]}`.toUpperCase() : "";
  }

  function formatPlate(plate) {
    const clean = String(plate || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
    return clean.length === 7 ? `${clean.slice(0, 3)}-${clean.slice(3)}` : clean;
  }

  function normalizeText(text) {
    return String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  }

  function initials(name) {
    return String(name || "?").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
  }

  function sum(list, pick = (item) => item) {
    return list.reduce((total, item) => total + (Number(pick(item)) || 0), 0);
  }

  function groupBy(list, keyFn) {
    const map = new Map();
    list.forEach((item) => {
      const key = keyFn(item);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    });
    return map;
  }

  function median(values) {
    const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function toCSV(headers, rows) {
    const cell = (value) => {
      const text = String(value ?? "");
      return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return "﻿" + [headers, ...rows].map((row) => row.map(cell).join(";")).join("\r\n");
  }

  async function downloadText(content, filename, extension = "csv") {
    if (window.frotasDesktop) {
      return window.frotasDesktop.saveTextFile(content, filename, extension);
    }
    const blob = new Blob([content], { type: extension === "csv" ? "text/csv;charset=utf-8" : "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    return filename;
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new Error("Não foi possível ler o arquivo."));
      reader.readAsDataURL(file);
    });
  }

  function debounce(fn, wait = 250) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  return {
    esc, money, moneyShort, number, percent, parseNumber,
    todayISO, addDays, daysBetween, dateBR, dateTimeBR, monthLabel, longToday, relativeTime,
    uid, extractPlate, formatPlate, normalizeText, initials, sum, groupBy, median,
    toCSV, downloadText, fileToBase64, debounce,
  };
})();
