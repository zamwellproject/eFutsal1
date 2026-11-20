// ============================================================================
// utils.js — Mathematical helpers, anti-NaN guardrails, formatting & storage
// ============================================================================

export function safeNum(val, fallback = 0) {
  return Number.isFinite(val) ? val : fallback;
}

export function clamp(val, min, max) {
  const v = safeNum(val, min);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

export function lerp(a, b, t) {
  const ct = clamp(t, 0, 1);
  return safeNum(a, 0) + (safeNum(b, 0) - safeNum(a, 0)) * ct;
}

export function dist(x1, y1, x2, y2) {
  const dx = safeNum(x2) - safeNum(x1);
  const dy = safeNum(y2) - safeNum(y1);
  return Math.hypot(dx, dy);
}

export function normalize(vx, vy) {
  const x = safeNum(vx, 0);
  const y = safeNum(vy, 0);
  const len = Math.hypot(x, y);
  if (len < 1e-6) return { x: 0, y: 0, len: 0 };
  return { x: x / len, y: y / len, len };
}

export function formatClock(seconds) {
  const s = Math.max(0, Math.ceil(safeNum(seconds, 0)));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function generateRoomCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

export function deepClone(obj) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return obj;
  }
}

export function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  return (
    'ontouchstart' in window ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
    window.innerWidth <= 900
  );
}
