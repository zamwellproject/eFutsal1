// ============================================================================
// data.js — Field constants, Official Teams, Player Roster & Admin Storage
// ============================================================================
import { clamp, deepClone } from './utils.js';

export const ADMIN_PASSWORD = 'azzamkece26';
const STORAGE_KEY_ROSTER = 'efutsal26_custom_roster_v1';

export const FIELD = Object.freeze({
  WIDTH: 1000,
  HEIGHT: 560,
  MARGIN: 36,
  GOAL_WIDTH: 124,
  GOAL_DEPTH: 28,
  PENALTY_AREA_RADIUS: 112,
  PENALTY_SPOT_DIST: 135,
  CENTER_CIRCLE_RADIUS: 68,
  PLAYER_RADIUS: 14,
  BALL_RADIUS: 8.5,
  // Calibrated movement speeds (px/sec) for smooth, realistic futsal pacing
  BASE_PLAYER_SPEED: 142,
  SPRINT_MULTIPLIER: 1.24,
  AI_SUPPORT_SPEED_FACTOR: 0.90,
  BALL_FRICTION: 0.985,
  MAX_BALL_SPEED: 640,
});

export const OFFICIAL_TEAMS = [
  {
    id: 'evr',
    name: 'EVERSION',
    abbr: 'EVR',
    primaryColor: '#00e676',
    accentColor: '#081b29',
  },
  {
    id: 'vdl',
    name: 'Vaedalation',
    abbr: 'VDL',
    primaryColor: '#00b0ff',
    accentColor: '#101828',
  },
  {
    id: 'awfa',
    name: 'Alwafi futsal academy',
    abbr: 'AWFA',
    primaryColor: '#ffd54f',
    accentColor: '#1b263b',
  },
  {
    id: 'zvr',
    name: 'Zetsvire',
    abbr: 'ZVR',
    primaryColor: '#ff5252',
    accentColor: '#14141f',
  },
];

// Outfield Positions: Anchor (ANC), Pivot (PVT), Flank Kanan (FLK-R), Flank Kiri (FLK-L)
// Goalkeeper: GK
export const DEFAULT_PLAYERS = [
  // Outfield (13)
  { id: 'p_hilmy', name: 'Hilmy', number: 7, role: 'OUTFIELD', pos: 'Pivot', speed: 84, shoot: 86, pass: 80, dribble: 85, defense: 68, gkHandling: 35 },
  { id: 'p_sunan', name: 'Sunan', number: 18, role: 'OUTFIELD', pos: 'Anchor', speed: 79, shoot: 77, pass: 85, dribble: 78, defense: 86, gkHandling: 38 },
  { id: 'p_faiq', name: 'Faiq', number: 48, role: 'OUTFIELD', pos: 'Flank Kanan', speed: 88, shoot: 81, pass: 83, dribble: 87, defense: 72, gkHandling: 34 },
  { id: 'p_nyong', name: 'Nyong', number: 29, role: 'OUTFIELD', pos: 'Flank Kiri', speed: 87, shoot: 80, pass: 82, dribble: 86, defense: 74, gkHandling: 35 },
  { id: 'p_ahmad', name: 'Ahmad', number: 25, role: 'OUTFIELD', pos: 'Anchor', speed: 78, shoot: 76, pass: 84, dribble: 77, defense: 87, gkHandling: 36 },
  { id: 'p_hamdi', name: 'Hamdi', number: 27, role: 'OUTFIELD', pos: 'Flank Kanan', speed: 85, shoot: 79, pass: 84, dribble: 83, defense: 76, gkHandling: 35 },
  { id: 'p_ikenzie_out', name: 'I. Kenzie', number: 13, role: 'OUTFIELD', pos: 'Pivot', speed: 83, shoot: 85, pass: 81, dribble: 84, defense: 70, gkHandling: 35 },
  { id: 'p_sajjad', name: 'Sajjad', number: 10, role: 'OUTFIELD', pos: 'Pivot', speed: 86, shoot: 88, pass: 87, dribble: 90, defense: 73, gkHandling: 36 },
  { id: 'p_alraffle', name: 'Al raffle', number: 77, role: 'OUTFIELD', pos: 'Flank Kiri', speed: 89, shoot: 82, pass: 80, dribble: 86, defense: 71, gkHandling: 33 },
  { id: 'p_rakan', name: 'Rakan', number: 23, role: 'OUTFIELD', pos: 'Anchor', speed: 80, shoot: 78, pass: 86, dribble: 79, defense: 85, gkHandling: 37 },
  { id: 'p_abiyu', name: 'Abiyu', number: 7, role: 'OUTFIELD', pos: 'Flank Kanan', speed: 86, shoot: 83, pass: 82, dribble: 85, defense: 72, gkHandling: 34 },
  { id: 'p_manggos', name: 'Manggos', number: 67, role: 'OUTFIELD', pos: 'Pivot', speed: 82, shoot: 84, pass: 79, dribble: 82, defense: 75, gkHandling: 36 },
  { id: 'p_najid', name: 'Najid', number: 57, role: 'OUTFIELD', pos: 'Flank Kiri', speed: 85, shoot: 81, pass: 83, dribble: 84, defense: 74, gkHandling: 35 },

  // Goalkeepers (4)
  { id: 'gk_bima', name: 'Bima', number: 2, role: 'GK', pos: 'GK', speed: 72, shoot: 62, pass: 78, dribble: 65, defense: 80, gkHandling: 86 },
  { id: 'gk_ikenzie', name: 'I.kenzie', number: 9, role: 'GK', pos: 'GK', speed: 74, shoot: 65, pass: 80, dribble: 68, defense: 79, gkHandling: 85 },
  { id: 'gk_rmaliq', name: 'R. Maliq', number: 6, role: 'GK', pos: 'GK', speed: 71, shoot: 60, pass: 77, dribble: 64, defense: 81, gkHandling: 87 },
  { id: 'gk_naufal', name: 'Naufal', number: 1, role: 'GK', pos: 'GK', speed: 75, shoot: 64, pass: 82, dribble: 67, defense: 82, gkHandling: 89 },
];

export function loadRosterDatabase() {
  const base = deepClone(DEFAULT_PLAYERS);
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ROSTER);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return base;
    const map = new Map(saved.map((p) => [p.id, p]));
    return base.map((p) => {
      const custom = map.get(p.id);
      if (!custom) return p;
      return {
        ...p,
        speed: clamp(custom.speed, 1, 99),
        shoot: clamp(custom.shoot, 1, 99),
        pass: clamp(custom.pass, 1, 99),
        dribble: clamp(custom.dribble, 1, 99),
        defense: clamp(custom.defense, 1, 99),
        gkHandling: clamp(custom.gkHandling, 1, 99),
      };
    });
  } catch {
    return base;
  }
}

export function saveRosterDatabase(roster) {
  try {
    localStorage.setItem(STORAGE_KEY_ROSTER, JSON.stringify(roster));
    return true;
  } catch {
    return false;
  }
}

export function resetRosterDatabase() {
  try {
    localStorage.removeItem(STORAGE_KEY_ROSTER);
  } catch {
    // ignore storage restriction
  }
  return deepClone(DEFAULT_PLAYERS);
}

export function computeOverall(player) {
  if (!player) return 75;
  if (player.role === 'GK') {
    return Math.round(
      player.gkHandling * 0.45 +
      player.defense * 0.25 +
      player.pass * 0.15 +
      player.speed * 0.15
    );
  }
  return Math.round(
    player.speed * 0.22 +
    player.shoot * 0.22 +
    player.pass * 0.2 +
    player.dribble * 0.2 +
    player.defense * 0.16
  );
}

export function resolveDuplicateNumbers(lineup) {
  const used = new Set();
  return lineup.map((p) => {
    let num = clamp(Math.round(Number(p.number) || 1), 1, 99);
    while (used.has(num)) {
      num = num >= 99 ? 1 : num + 1;
    }
    used.add(num);
    return { ...p, number: num };
  });
}

export function buildDefaultLineup(roster) {
  const outfields = roster.filter((p) => p.role === 'OUTFIELD').slice(0, 4);
  const gk = roster.find((p) => p.role === 'GK') || roster[roster.length - 1];
  return resolveDuplicateNumbers([...outfields, gk]);
}
