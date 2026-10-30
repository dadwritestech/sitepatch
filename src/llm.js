// Minimal OpenAI-compatible chat client for the local llama-server.
// node:http, not fetch: fetch has a 300 s headers timeout that a busy shared server can hit.
const http = require('node:http');
const https = require('node:https');

const MODEL = process.env.SITEPATCH_MODEL || 'gemma-4-12b';

function post(url, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? https : http).request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => (res.statusCode >= 400 ? reject(new Error(`LLM HTTP ${res.statusCode}: ${data.slice(0, 200)}`)) : resolve(data)));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`LLM timeout after ${timeoutMs / 1000}s`)));
    req.on('error', reject);
    req.end(body);
  });
}

async function chat(messages, { temperature = 0.2, maxTokens = 900 } = {}) {
  const key = process.env.LLAMA_API_KEY;
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const body = JSON.stringify({
    model: MODEL, messages, temperature, max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    chat_template_kwargs: { enable_thinking: false }, // gemma-4: 8x faster with reasoning off
  });
  const url = process.env.SITEPATCH_LLM_URL || 'http://localhost:8080/v1/chat/completions';
  const raw = await post(url, body, headers, Number(process.env.SITEPATCH_LLM_TIMEOUT || 240) * 1000);
  const msg = JSON.parse(raw).choices[0].message.content;
  return parseJson(msg);
}

function parseJson(text) {
  const s = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error('LLM did not return JSON: ' + s.slice(0, 120));
}

module.exports = { chat, parseJson, MODEL };
