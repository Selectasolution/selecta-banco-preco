// Selecta · Banco de Preço — service worker MINIMO (BUILD 2026-08-25-E)
// Existe so para o app ser instalavel na tela inicial (Android/Chrome exige um SW).
// NAO faz cache de nada: toda requisicao segue direto para a rede, como sem SW.
// Assim nao ha risco de tela velha depois de publicar um build novo.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
