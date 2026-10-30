// In-process domain events (message.received, contact.created, …). The OA and AM engines
// subscribe in later steps (capture rule r1, reset-on-reply r7, …). Handlers run after the
// emitting transaction has committed; a failing handler is logged and audited, never rethrown
// into the request that produced the event.
import { logEvent } from '../services/audit.js';

const handlers = new Map(); // event → Map(name → fn)

export function on(event, name, fn) {
  if (!handlers.has(event)) handlers.set(event, new Map());
  handlers.get(event).set(name, fn);
  return () => handlers.get(event)?.delete(name);
}

export async function emit(event, payload) {
  const results = {};
  for (const [name, fn] of handlers.get(event) ?? []) {
    try {
      results[name] = await fn(payload);
    } catch (err) {
      console.error(`event ${event} → ${name}:`, err);
      results[name] = { error: err.message };
      await logEvent({ entityType: 'system', entityId: event, action: 'event.handler_failed', reason: `${name}: ${err.message}` }).catch(() => {});
    }
  }
  return results;
}
