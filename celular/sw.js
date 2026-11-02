// Guarda os arquivos do aplicativo no celular para abrir rápido, mesmo com sinal fraco.
// Dados (notas, login) sempre vão direto para a nuvem; nada disso fica em cache.
const VERSION = "frotas-notas-v1";
const FILES = ["./", "index.html", "app.css", "app.js", "vendor/supabase.js", "logo.svg", "icone-192.png", "icone-512.png", "manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  // Rede primeiro (pega atualizações); se estiver sem sinal, usa a cópia guardada.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("index.html"))),
  );
});
