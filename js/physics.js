// ============================================================================
// physics.js — Futsal Pitch Boundaries, Ball Magnus Curve, Collisions & Rules
// ============================================================================
import { FIELD } from './data.js';
import { clamp, dist, normalize, safeNum } from './utils.js';

export function createBall() {
  return {
    x: FIELD.WIDTH / 2,
    y: FIELD.HEIGHT / 2,
    vx: 0,
    vy: 0,
    spin: 0, // Magnus angular spin (-1..1)
    ownerId: null,
    lastTouchTeam: 'HOME',
    lastTouchPlayerId: null,
    trail: [],
    kickCooldown: 0,
  };
}

export function resetBallToSpot(ball, x, y) {
  ball.x = clamp(safeNum(x, FIELD.WIDTH / 2), FIELD.MARGIN, FIELD.WIDTH - FIELD.MARGIN);
  ball.y = clamp(safeNum(y, FIELD.HEIGHT / 2), FIELD.MARGIN, FIELD.HEIGHT - FIELD.MARGIN);
  ball.vx = 0;
  ball.vy = 0;
  ball.spin = 0;
  ball.ownerId = null;
  ball.trail = [];
  ball.kickCooldown = 0.12;
}

export function kickBall(ball, dirX, dirY, powerSpeed, spin = 0, kicker = null) {
  const n = normalize(dirX, dirY);
  const fx = n.len > 0 ? n.x : 1;
  const fy = n.len > 0 ? n.y : 0;
  const speed = clamp(safeNum(powerSpeed, 280), 80, FIELD.MAX_BALL_SPEED);

  ball.ownerId = null;
  ball.vx = fx * speed;
  ball.vy = fy * speed;
  ball.spin = clamp(safeNum(spin, 0), -1.35, 1.35);
  ball.kickCooldown = 0.16;

  if (kicker) {
    ball.lastTouchTeam = kicker.team;
    ball.lastTouchPlayerId = kicker.id;
  }
}

export function stepBallPhysics(ball, players, dt, secondHalf = false) {
  if (!ball || !Array.isArray(players)) return { event: null };

  ball.kickCooldown = Math.max(0, safeNum(ball.kickCooldown, 0) - dt);

  // If ball is controlled by a player, lock smoothly to their dribble foot
  if (ball.ownerId) {
    const owner = players.find((p) => p && p.id === ball.ownerId);
    if (owner) {
      const f = normalize(owner.facingX, owner.facingY);
      const fx = f.len > 0 ? f.x : (owner.team === 'HOME' ? 1 : -1);
      const fy = f.len > 0 ? f.y : 0;
      const offset = FIELD.PLAYER_RADIUS + FIELD.BALL_RADIUS - 2;
      ball.x = clamp(owner.x + fx * offset, FIELD.MARGIN - 6, FIELD.WIDTH - FIELD.MARGIN + 6);
      ball.y = clamp(owner.y + fy * offset, FIELD.MARGIN - 6, FIELD.HEIGHT - FIELD.MARGIN + 6);
      ball.vx = owner.vx;
      ball.vy = owner.vy;
      ball.spin = 0;
      ball.lastTouchTeam = owner.team;
      ball.lastTouchPlayerId = owner.id;
      recordTrail(ball);
      return checkBoundaryAndGoal(ball, secondHalf);
    } else {
      ball.ownerId = null;
    }
  }

  // Free ball physics with Magnus effect (curve)
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed > 12 && Math.abs(ball.spin) > 0.01) {
    // Perpendicular vector to velocity
    const perpX = -ball.vy / speed;
    const perpY = ball.vx / speed;
    const magnusAccel = ball.spin * speed * 1.15;
    ball.vx += perpX * magnusAccel * dt;
    ball.vy += perpY * magnusAccel * dt;
    ball.spin *= Math.pow(0.55, dt);
  }

  // Frame-rate independent ground friction
  const damping = Math.pow(FIELD.BALL_FRICTION, dt * 60);
  ball.vx *= damping;
  ball.vy *= damping;

  if (Math.hypot(ball.vx, ball.vy) < 4) {
    ball.vx = 0;
    ball.vy = 0;
    ball.spin = 0;
  }

  ball.x = safeNum(ball.x, FIELD.WIDTH / 2) + safeNum(ball.vx, 0) * dt;
  ball.y = safeNum(ball.y, FIELD.HEIGHT / 2) + safeNum(ball.vy, 0) * dt;

  recordTrail(ball);

  // Player-to-ball possession, interception & handball check
  if (ball.kickCooldown <= 0) {
    for (const p of players) {
      if (!p || p.stunTimer > 0) continue;
      const d = dist(ball.x, ball.y, p.x, p.y);
      const reach = FIELD.PLAYER_RADIUS + FIELD.BALL_RADIUS + 2;
      if (d <= reach) {
        // Rare handball infraction on high-speed deflected outfield shots
        if (
          p.role !== 'GK' &&
          speed > 395 &&
          ball.lastTouchTeam !== p.team &&
          Math.random() < 0.035
        ) {
          ball.vx *= 0.2;
          ball.vy *= 0.2;
          return {
            event: 'HANDBALL',
            team: p.team === 'HOME' ? 'AWAY' : 'HOME',
            x: clamp(p.x, FIELD.MARGIN + 25, FIELD.WIDTH - FIELD.MARGIN - 25),
            y: clamp(p.y, FIELD.MARGIN + 25, FIELD.HEIGHT - FIELD.MARGIN - 25),
            offender: p,
          };
        }

        // Goalkeeper catch / parry
        if (p.role === 'GK') {
          const handlingChance = clamp(0.45 + (p.gkHandling / 100) * 0.5, 0.45, 0.96);
          if (speed < 470 || Math.random() < handlingChance) {
            ball.ownerId = p.id;
            ball.vx = 0;
            ball.vy = 0;
            ball.spin = 0;
            ball.lastTouchTeam = p.team;
            ball.lastTouchPlayerId = p.id;
            return { event: 'GK_SAVE', player: p };
          } else {
            // Parry deflection
            const awayX = p.x < FIELD.WIDTH / 2 ? 1 : -1;
            ball.vx = awayX * speed * 0.48;
            ball.vy = (Math.random() - 0.5) * 240;
            ball.spin = 0;
            ball.kickCooldown = 0.22;
            ball.lastTouchTeam = p.team;
            return { event: 'GK_PARRY', player: p };
          }
        }

        // Outfield first-touch control
        const controlSkill = clamp((p.dribble || 75) / 100, 0.5, 1);
        if (speed <= 420 * controlSkill || Math.random() < 0.72) {
          ball.ownerId = p.id;
          ball.vx = 0;
          ball.vy = 0;
          ball.spin = 0;
          ball.lastTouchTeam = p.team;
          ball.lastTouchPlayerId = p.id;
          break;
        } else {
          // Heavy touch bounce
          const bounce = normalize(ball.x - p.x, ball.y - p.y);
          ball.vx = bounce.x * speed * 0.42;
          ball.vy = bounce.y * speed * 0.42;
          ball.kickCooldown = 0.14;
          ball.lastTouchTeam = p.team;
          break;
        }
      }
    }
  }

  return checkBoundaryAndGoal(ball, secondHalf);
}

function recordTrail(ball) {
  const spd = Math.hypot(ball.vx, ball.vy);
  if (spd > 190 || Math.abs(ball.spin) > 0.15) {
    ball.trail.push({ x: ball.x, y: ball.y, spin: ball.spin });
    if (ball.trail.length > 16) ball.trail.shift();
  } else if (ball.trail.length > 0) {
    ball.trail.shift();
  }
}

function checkBoundaryAndGoal(ball, secondHalf) {
  const left = FIELD.MARGIN;
  const right = FIELD.WIDTH - FIELD.MARGIN;
  const top = FIELD.MARGIN;
  const bottom = FIELD.HEIGHT - FIELD.MARGIN;
  const goalTop = FIELD.HEIGHT / 2 - FIELD.GOAL_WIDTH / 2;
  const goalBottom = FIELD.HEIGHT / 2 + FIELD.GOAL_WIDTH / 2;

  // Goal detection (Left & Right goals)
  const inGoalY = ball.y >= goalTop && ball.y <= goalBottom;

  if (ball.x < left && inGoalY) {
    // Left goal entered -> scorer depends on side swap
    const scorer = secondHalf ? 'HOME' : 'AWAY';
    return { event: 'GOAL', scorer };
  }

  if (ball.x > right && inGoalY) {
    const scorer = secondHalf ? 'AWAY' : 'HOME';
    return { event: 'GOAL', scorer };
  }

  // Goal post bounce
  if ((ball.x <= left + 4 || ball.x >= right - 4) && !inGoalY) {
    const dTopPost = Math.abs(ball.y - goalTop);
    const dBotPost = Math.abs(ball.y - goalBottom);
    if (dTopPost < 8 || dBotPost < 8) {
      ball.vx = -ball.vx * 0.65;
      ball.x = clamp(ball.x, left + 6, right - 6);
      return { event: 'POST' };
    }
  }

  // Sideline OUT -> Kick-in
  if (ball.y < top || ball.y > bottom) {
    const restartTeam = ball.lastTouchTeam === 'HOME' ? 'AWAY' : 'HOME';
    const spotX = clamp(ball.x, left + 18, right - 18);
    const spotY = ball.y < top ? top + 4 : bottom - 4;
    return { event: 'KICK_IN', team: restartTeam, x: spotX, y: spotY };
  }

  // Endline OUT (outside goal mouth) -> Corner or Goal Kick
  if (ball.x < left || ball.x > right) {
    const isLeftEnd = ball.x < left;
    const defendingTeam = isLeftEnd
      ? (secondHalf ? 'AWAY' : 'HOME')
      : (secondHalf ? 'HOME' : 'AWAY');

    if (ball.lastTouchTeam === defendingTeam) {
      // Corner Kick
      const attackingTeam = defendingTeam === 'HOME' ? 'AWAY' : 'HOME';
      const cx = isLeftEnd ? left + 8 : right - 8;
      const cy = ball.y < FIELD.HEIGHT / 2 ? top + 8 : bottom - 8;
      return { event: 'CORNER', team: attackingTeam, x: cx, y: cy };
    } else {
      // Goal Kick
      const gx = isLeftEnd ? left + 48 : right - 48;
      const gy = FIELD.HEIGHT / 2;
      return { event: 'GOAL_KICK', team: defendingTeam, x: gx, y: gy };
    }
  }

  return { event: null };
}

export function resolvePlayerCollisions(players) {
  const minDist = FIELD.PLAYER_RADIUS * 2.05;
  for (let i = 0; i < players.length; i++) {
    const a = players[i];
    if (!a) continue;
    for (let j = i + 1; j < players.length; j++) {
      const b = players[j];
      if (!b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.001 && d < minDist) {
        const overlap = (minDist - d) * 0.5;
        const nx = dx / d;
        const ny = dy / d;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;
      }
    }
    a.x = clamp(a.x, FIELD.MARGIN - 6, FIELD.WIDTH - FIELD.MARGIN + 6);
    a.y = clamp(a.y, FIELD.MARGIN - 6, FIELD.HEIGHT - FIELD.MARGIN + 6);
  }
}
