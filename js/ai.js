// ============================================================================
// ai.js — Tactical 1-2-1 Futsal Rotation AI & Goalkeeper Positioning
// ============================================================================
import { FIELD } from './data.js';
import { clamp, dist, normalize } from './utils.js';

/**
 * Computes tactical target coordinates for 1-2-1 futsal rotation:
 * - GK: guards goal line & angle bisector
 * - Anchor: deep playmaker / defensive cover
 * - Flank Kanan & Flank Kiri: width providers & diagonal runners
 * - Pivot: advanced target & pressing trigger
 */
export function getTacticalAnchor(player, ball, attackDir, hasPossession) {
  const w = FIELD.WIDTH;
  const h = FIELD.HEIGHT;
  const cy = h / 2;

  const ownGoalX = attackDir === 1 ? FIELD.MARGIN + 18 : w - FIELD.MARGIN - 18;
  const oppGoalX = attackDir === 1 ? w - FIELD.MARGIN - 20 : FIELD.MARGIN + 20;

  // Goalkeeper positioning
  if (player.role === 'GK') {
    const goalX = attackDir === 1 ? FIELD.MARGIN + 16 : w - FIELD.MARGIN - 16;
    const targetY = clamp(
      cy + (ball.y - cy) * 0.36,
      cy - FIELD.GOAL_WIDTH * 0.36,
      cy + FIELD.GOAL_WIDTH * 0.36
    );
    return { x: goalX, y: targetY };
  }

  // Ball progress factor (0 = own goal, 1 = opp goal)
  const ballProg = clamp(
    attackDir === 1
      ? (ball.x - FIELD.MARGIN) / (w - FIELD.MARGIN * 2)
      : (w - FIELD.MARGIN - ball.x) / (w - FIELD.MARGIN * 2),
    0.1,
    0.92
  );

  const shiftX = (ballProg - 0.5) * 230 * attackDir;
  const ballOffsetY = (ball.y - cy) * 0.28;

  if (hasPossession) {
    // Attacking 1-2-1 diamond shape finding open space
    switch (player.pos) {
      case 'Anchor':
        return {
          x: clamp(w * 0.5 - 165 * attackDir + shiftX * 0.7, FIELD.MARGIN + 70, w - FIELD.MARGIN - 70),
          y: clamp(cy + ballOffsetY * 0.6, FIELD.MARGIN + 65, h - FIELD.MARGIN - 65),
        };
      case 'Flank Kanan':
        return {
          x: clamp(w * 0.5 + 35 * attackDir + shiftX * 0.85, FIELD.MARGIN + 70, w - FIELD.MARGIN - 70),
          y: clamp(attackDir === 1 ? h - 92 : 92, FIELD.MARGIN + 45, h - FIELD.MARGIN - 45),
        };
      case 'Flank Kiri':
        return {
          x: clamp(w * 0.5 + 35 * attackDir + shiftX * 0.85, FIELD.MARGIN + 70, w - FIELD.MARGIN - 70),
          y: clamp(attackDir === 1 ? 92 : h - 92, FIELD.MARGIN + 45, h - FIELD.MARGIN - 45),
        };
      case 'Pivot':
      default:
        return {
          x: clamp(oppGoalX - 145 * attackDir, FIELD.MARGIN + 85, w - FIELD.MARGIN - 85),
          y: clamp(cy - ballOffsetY * 0.55, FIELD.MARGIN + 70, h - FIELD.MARGIN - 70),
        };
    }
  } else {
    // Compact defensive 1-2-1 diamond protecting central passing lanes
    const defBaseX = ownGoalX + 185 * attackDir + shiftX * 0.55;
    switch (player.pos) {
      case 'Anchor':
        return {
          x: clamp(ownGoalX + 125 * attackDir + shiftX * 0.35, FIELD.MARGIN + 60, w - FIELD.MARGIN - 60),
          y: clamp(cy + ballOffsetY * 0.5, FIELD.MARGIN + 75, h - FIELD.MARGIN - 75),
        };
      case 'Flank Kanan':
        return {
          x: clamp(defBaseX, FIELD.MARGIN + 65, w - FIELD.MARGIN - 65),
          y: clamp(cy + (attackDir === 1 ? 115 : -115) + ballOffsetY * 0.4, FIELD.MARGIN + 50, h - FIELD.MARGIN - 50),
        };
      case 'Flank Kiri':
        return {
          x: clamp(defBaseX, FIELD.MARGIN + 65, w - FIELD.MARGIN - 65),
          y: clamp(cy + (attackDir === 1 ? -115 : 115) + ballOffsetY * 0.4, FIELD.MARGIN + 50, h - FIELD.MARGIN - 50),
        };
      case 'Pivot':
      default:
        return {
          x: clamp(defBaseX + 115 * attackDir, FIELD.MARGIN + 75, w - FIELD.MARGIN - 75),
          y: clamp(cy + ballOffsetY * 0.65, FIELD.MARGIN + 65, h - FIELD.MARGIN - 65),
        };
    }
  }
}

export function decideBallCarrierAction(carrier, teammates, opponents, attackDir, dt) {
  carrier.aiDecisionTimer = (carrier.aiDecisionTimer || 0) - dt;
  const oppGoalX = attackDir === 1 ? FIELD.WIDTH - FIELD.MARGIN : FIELD.MARGIN;
  const oppGoalY = FIELD.HEIGHT / 2;
  const distToGoal = dist(carrier.x, carrier.y, oppGoalX, oppGoalY);

  // GK quick distribution
  if (carrier.role === 'GK') {
    if (carrier.aiDecisionTimer <= 0) {
      carrier.aiDecisionTimer = 0.65;
      const openMate = findBestPassTarget(carrier, teammates, opponents, attackDir);
      if (openMate) {
        return { action: 'PASS', target: openMate };
      }
      return {
        action: 'SHOOT',
        dirX: attackDir,
        dirY: (Math.random() - 0.5) * 0.4,
        power: 0.72,
        curve: 0,
      };
    }
    return { action: 'DRIBBLE', mx: 0, my: 0 };
  }

  // Shoot when inside clean shooting range
  if (distToGoal < 245 && carrier.aiDecisionTimer <= 0) {
    carrier.aiDecisionTimer = 0.55;
    const cornerOffset = (Math.random() > 0.5 ? 1 : -1) * (FIELD.GOAL_WIDTH * 0.34);
    const targetY = oppGoalY + cornerOffset;
    const dir = normalize(oppGoalX - carrier.x, targetY - carrier.y);
    const curve = Math.sign(targetY - carrier.y) * 0.65;
    return {
      action: 'SHOOT',
      dirX: dir.x,
      dirY: dir.y,
      power: clamp(0.68 + Math.random() * 0.25, 0.65, 0.95),
      curve,
    };
  }

  // Check nearby defender pressure -> pass to open teammate
  const nearestDefDist = opponents.reduce(
    (min, opp) => Math.min(min, dist(carrier.x, carrier.y, opp.x, opp.y)),
    999
  );

  if ((nearestDefDist < 68 || Math.random() < 0.025) && carrier.aiDecisionTimer <= 0) {
    carrier.aiDecisionTimer = 0.5;
    const target = findBestPassTarget(carrier, teammates, opponents, attackDir);
    if (target) {
      return { action: 'PASS', target };
    }
  }

  // Otherwise dribble forward toward space
  const targetY = oppGoalY + Math.sin(performance.now() * 0.002 + carrier.number) * 85;
  const d = normalize(oppGoalX - carrier.x, targetY - carrier.y);
  return { action: 'DRIBBLE', mx: d.x * 0.88, my: d.y * 0.88 };
}

export function findBestPassTarget(passer, teammates, opponents, attackDir, preferForward = false) {
  let best = null;
  let bestScore = -9999;

  for (const mate of teammates) {
    if (!mate || mate.id === passer.id || mate.role === 'GK') continue;
    const d = dist(passer.x, passer.y, mate.x, mate.y);
    if (d < 45 || d > 520) continue;

    const forwardGain = (mate.x - passer.x) * attackDir;
    const closestOpp = opponents.reduce(
      (min, opp) => Math.min(min, dist(mate.x, mate.y, opp.x, opp.y)),
      999
    );

    let score = closestOpp * 1.4 - d * 0.22 + forwardGain * (preferForward ? 0.95 : 0.45);
    if (score > bestScore) {
      bestScore = score;
      best = mate;
    }
  }
  return best;
}
