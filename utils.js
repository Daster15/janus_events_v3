// utils.js
'use strict';

/**
 * Normalizuje znacznik czasu z Janusa/integra:
 *  - number (sekundy/ms/µs/ns) → Date
 *  - string ISO → Date
 *  - null/undefined → new Date()
 */
function toDate(ts) {
  if (ts == null) return new Date();

  // Jeśli już Date
  if (ts instanceof Date) return ts;

  // String (ISO lub epoch jako string)
  if (typeof ts === 'string') {
    // spróbuj ISO
    const iso = Date.parse(ts);
    if (!Number.isNaN(iso)) return new Date(iso);
    // spróbuj jako liczba
    const n = Number(ts);
    if (!Number.isNaN(n)) return toDate(n);
    // nie rozpoznano
    return new Date(); // fallback, by nie wywalić inserta
  }

  // Number (epoch w s/ms/µs/ns)
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    // Bierzemy długość części całkowitej
    const abs = Math.abs(Math.trunc(ts));
    const digits = String(abs).length;

    // ns ≈ 19 cyfr (np. 1_725_000_000_000_000_000)
    if (digits >= 19) {
      return new Date(ts / 1e6); // ns -> ms
    }
    // µs ≈ 16 cyfr (np. 1_725_000_000_000_000)
    if (digits >= 16) {
      return new Date(ts / 1e3); // µs -> ms
    }
    // ms ≈ 13 cyfr (np. 1_725_000_000_000)
    if (digits >= 13) {
      return new Date(ts);       // ms
    }
    // s ≈ 10 cyfr (np. 1_725_000_000)
    if (digits >= 10) {
      return new Date(ts * 1e3); // s -> ms
    }
    // zbyt mała liczba? potraktuj jako sekundy
    return new Date(ts * 1e3);
  }

  // fallback
  return new Date();
}

module.exports = { toDate };
