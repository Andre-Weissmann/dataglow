// Service Worker for Validation Webhook Mode (browser PWA)
// Intercepts POST /dataglow-webhook and routes through webhook-handler.js
//
// This is the browser PWA path for Validation Webhook Mode: it lets a
// pipeline engineer POST a micro-batch to a DataGlow tab running in the
// background and get back a signed pass/fail/warn response, with no server
// and no data leaving the machine. The future Tauri desktop path swaps this
// Service Worker for a real localhost HTTP server (see docs/webhook-mode.md)
// — the request/response shape stays identical either way.

importScripts('../streaming/streaming-validator.js');
importScripts('./webhook-handler.js');

// In-memory baseline store (persists for the lifetime of the SW)
let currentBaseline = null;

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/dataglow-webhook') {
    event.respondWith(handleWebhookRequest(event.request));
  }
});

async function handleWebhookRequest(request) {
  try {
    const body = await request.json();
    const result = await processWebhookBatch(body, currentBaseline);
    if (result.error) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    currentBaseline = result.newBaseline;
    return new Response(JSON.stringify(result.response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
