// Minimal Chrome DevTools Protocol driver used by the E2E test. Chrome is
// started separately by the test runner (the sandbox forbids Node from
// spawning browser processes with piped stdio).
import { writeFile } from 'node:fs/promises';

export async function openTarget(url, { port = 9223, viewport = { width: 1440, height: 900 } } = {}) {
  const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
  if (!created.ok) throw new Error(`could not create target: ${created.status}`);
  const target = await created.json();
  const client = new CDP(target.webSocketDebuggerUrl);
  await client.connect();

  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await client.send('Page.navigate', { url });
  await client.waitFor('document.readyState === "complete"', 20000);
  return client;
}

export class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.consoleErrors = [];
    this.logErrors = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => reject(new Error('CDP websocket connect timeout')), 10000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP websocket error: ${event.message || 'unknown'}`));
      });
      this.ws.addEventListener('message', (event) => this.onMessage(event.data));
      this.ws.addEventListener('close', () => {
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new Error('CDP connection closed'));
        }
        this.pending.clear();
      });
    });
  }

  onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || 'CDP error'));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      const text = (message.params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
      this.consoleErrors.push(text);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      this.consoleErrors.push(message.params?.exceptionDetails?.text || 'runtime exception');
    }
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
      this.logErrors.push(message.params.entry.text);
    }
    const handlers = this.listeners.get(message.method);
    if (handlers) handlers.forEach((handler) => handler(message.params));
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method)?.delete(handler);
  }

  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'page evaluation failed');
    }
    return result.result?.value;
  }

  async waitFor(expression, timeoutMs = 10000, intervalMs = 100) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        if (await this.evaluate(expression)) return true;
      } catch { /* document may be navigating */ }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`timed out waiting for: ${expression}`);
  }

  async click(selector) {
    const clicked = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`element not found: ${selector}`);
  }

  async setValue(selector, value) {
    const ok = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Error(`element not found: ${selector}`);
  }

  async setViewport(width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    });
  }

  async screenshot(path) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    await writeFile(path, Buffer.from(result.data, 'base64'));
  }

  async text(selector) {
    return this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText || ''`);
  }

  async count(selector) {
    return this.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  }

  async visible(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    })()`);
  }

  async close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}
