// ============================================================================
// engine.js — Core Match State Machine, Fixed-Dt Loop, Rules & Tie-Breakers
// ============================================================================
import { FIELD } from './data.js';
import { clamp, dist, formatClock, normalize, safeNum } from './utils.js';
import {
  createBall,
  kickBall,
  resetBallToSpot,
  resolvePlayerCollisions,
  stepBallPhysics,
} from './physics.js';
import { decideBallCarrierAction, findBestPassTarget, getTacticalAnchor } from './ai.js';

export class MatchEngine {
  constructor({ renderer, input, network, callbacks }) {
    this.renderer = renderer;
    this.input = input;
    this.network = network;
    this.callbacks = callbacks || {};

    this.running = false;
    this.paused = false;
    this.rafId = null;
    this.lastTime = 0;

    // Match Configuration
    this.mode = 'AI'; // 'AI' | 'ONLINE'
    this.localSide = 'HOME'; // 'HOME' (Host/AI-Player) | 'AWAY' (Guest)
    this.totalDurationSec = 240; // 3..7 minutes
    this.homeTeam = null;
    this.awayTeam = null;

    // Match State
    this.phase = 'IDLE'; // 'PLAYING' | 'SET_PIECE' | 'HALFTIME_PAUSE' | 'EXTRA_TIME' | 'PENALTY' | 'SUIT' | 'FULLTIME'
    this.period = 1; // 1 = 1st Half, 2 = 2nd Half, 3 = Extra Time
    this.periodClock = 120;
    this.secondHalf = false;

    this.score = { HOME: 0, AWAY: 0 };
    this.players = [];
    this.ball = createBall();
    this.controlledHomeId = null;
    this.controlledAwayId = null;
    this.restartSpot = null;
    this.restartTeam = null;
    this.setPieceTimer = 0;
    this.bannerTimer = 0;

    // Remote input & sync throttles
    this.remoteInput = { mx: 0, my: 0, sprint: false, passPressed: false, throughPressed: false, switchPressed: false, shootReleased: false, shootPower: 0, curveFactor: 0 };
    this.netSyncAccum = 0;

    // Tie-breaker state (Penalty & Golden Ball Suit)
    this.penaltyState = null;
    this.suitState = null;
  }

  startMatch({ mode, localSide, durationMinutes, homeConfig, awayConfig }) {
    this.stop();

    this.mode = mode === 'ONLINE' ? 'ONLINE' : 'AI';
    this.localSide = localSide === 'AWAY' ? 'AWAY' : 'HOME';
    const mins = clamp(Number(durationMinutes) || 4, 3, 7);
    this.totalDurationSec = mins * 60;

    this.homeTeam = homeConfig;
    this.awayTeam = awayConfig;

    this.score = { HOME: 0, AWAY: 0 };
    this.period = 1;
    this.secondHalf = false;
    this.periodClock = this.totalDurationSec / 2;
    this.phase = 'PLAYING';
    this.paused = false;
    this.restartSpot = null;
    this.penaltyState = null;
    this.suitState = null;

    this._buildMatchPlayers();
    this._arrangeKickoff('HOME');

    this.renderer.resize();
    this._triggerBanner('1ST HALF KICK-OFF', `${this.homeTeam.abbr} vs ${this.awayTeam.abbr}`, 1.8);

    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame((t) => this._loop(t));
  }

  stop() {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  togglePause(forceState = null) {
    if (this.phase === 'FULLTIME') return;
    this.paused = forceState !== null ? Boolean(forceState) : !this.paused;
    this.callbacks.onPauseChange?.(this.paused, this);
  }

  _buildMatchPlayers() {
    this.players = [];

    const makeEntity = (raw, team, idx) => ({
      id: `${team}_${raw.id}_${idx}`,
      name: raw.name,
      number: raw.number,
      role: raw.role,
      pos: raw.pos,
      team,
      speed: clamp(raw.speed, 1, 99),
      shoot: clamp(raw.shoot, 1, 99),
      pass: clamp(raw.pass, 1, 99),
      dribble: clamp(raw.dribble, 1, 99),
      defense: clamp(raw.defense, 1, 99),
      gkHandling: clamp(raw.gkHandling, 1, 99),
      x: FIELD.WIDTH / 2,
      y: FIELD.HEIGHT / 2,
      vx: 0,
      vy: 0,
      facingX: team === 'HOME' ? 1 : -1,
      facingY: 0,
      stamina: 100,
      stunTimer: 0,
      aiDecisionTimer: 0.3,
    });

    this.homeTeam.lineup.forEach((p, idx) => {
      this.players.push(makeEntity(p, 'HOME', idx));
    });
    this.awayTeam.lineup.forEach((p, idx) => {
      this.players.push(makeEntity(p, 'AWAY', idx));
    });

    this.controlledHomeId = this.players.find((p) => p.team === 'HOME' && p.role !== 'GK')?.id || null;
    this.controlledAwayId = this.players.find((p) => p.team === 'AWAY' && p.role !== 'GK')?.id || null;
  }

  _arrangeKickoff(kickoffTeam) {
    const cx = FIELD.WIDTH / 2;
    const cy = FIELD.HEIGHT / 2;
    resetBallToSpot(this.ball, cx, cy);

    const homeDir = this.secondHalf ? -1 : 1;
    const awayDir = -homeDir;

    const placeTeam = (team, dir, isKickoff) => {
      const roster = this.players.filter((p) => p.team === team);
      roster.forEach((p) => {
        p.vx = 0;
        p.vy = 0;
        p.facingX = dir;
        p.facingY = 0;
        if (p.role === 'GK') {
          p.x = dir === 1 ? FIELD.MARGIN + 22 : FIELD.WIDTH - FIELD.MARGIN - 22;
          p.y = cy;
        } else if (p.pos === 'Pivot') {
          p.x = isKickoff ? cx - dir * 14 : cx - dir * 82;
          p.y = cy;
        } else if (p.pos === 'Flank Kanan') {
          p.x = cx - dir * 95;
          p.y = cy + (dir === 1 ? 115 : -115);
        } else if (p.pos === 'Flank Kiri') {
          p.x = cx - dir * 95;
          p.y = cy + (dir === 1 ? -115 : 115);
        } else {
          // Anchor
          p.x = cx - dir * 185;
          p.y = cy;
        }
      });
    };

    placeTeam('HOME', homeDir, kickoffTeam === 'HOME');
    placeTeam('AWAY', awayDir, kickoffTeam === 'AWAY');

    const kicker = this.players.find((p) => p.team === kickoffTeam && p.pos === 'Pivot')
      || this.players.find((p) => p.team === kickoffTeam && p.role !== 'GK');
    if (kicker) {
      this.ball.ownerId = kicker.id;
      if (kickoffTeam === 'HOME') this.controlledHomeId = kicker.id;
      else this.controlledAwayId = kicker.id;
    }
  }

  _triggerBanner(sub, title, duration = 1.6) {
    this.bannerTimer = duration;
    this.callbacks.onBanner?.(sub, title, true);
  }

  _loop(now) {
    if (!this.running) return;

    // Clamp dt strictly between 0.001s and 0.05s for 60Hz/120Hz frame stability
    const rawDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    const dt = clamp(safeNum(rawDt, 0.016), 0.001, 0.05);

    if (!this.paused) {
      this._update(dt);
    }

    this.renderer.render({
      players: this.players,
      ball: this.ball,
      homeKit: this.homeTeam,
      awayKit: this.awayTeam,
      controlledHomeId: this.controlledHomeId,
      controlledAwayId: this.controlledAwayId,
      restartSpot: this.restartSpot,
    });

    this.rafId = requestAnimationFrame((t) => this._loop(t));
  }

  _update(dt) {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) {
        this.callbacks.onBanner?.('', '', false);
      }
    }

    const localSample = this.input.sample(dt);

    // Online Guest sends input to Host and applies received authoritative state
    if (this.mode === 'ONLINE' && this.localSide === 'AWAY') {
      this.network.send({ type: 'INPUT', input: localSample });
      this._updateHud(localSample);
      return;
    }

    // Authoritative simulation (Single Player or Online Host)
    if (this.phase === 'PLAYING' || this.phase === 'EXTRA_TIME') {
      this.periodClock -= dt;
      if (this.periodClock <= 0) {
        this.periodClock = 0;
        this._handlePeriodEnd();
        this._updateHud(localSample);
        return;
      }

      const homeInput = localSample;
      const awayInput = this.mode === 'ONLINE' ? this.remoteInput : null;

      this._stepPlayers(dt, homeInput, awayInput);
      resolvePlayerCollisions(this.players);

      const physResult = stepBallPhysics(this.ball, this.players, dt, this.secondHalf);
      if (physResult?.event) {
        this._handlePhysicsEvent(physResult);
      }
    } else if (this.phase === 'SET_PIECE') {
      this.setPieceTimer -= dt;
      if (this.setPieceTimer <= 0) {
        this._executeSetPiece();
      }
    }

    // Broadcast authoritative snapshot to Online Guest at ~30Hz
    if (this.mode === 'ONLINE' && this.localSide === 'HOME') {
      this.netSyncAccum += dt;
      if (this.netSyncAccum >= 0.033) {
        this.netSyncAccum = 0;
        this.network.send({
          type: 'STATE',
          snapshot: this.getNetworkSnapshot(),
        });
      }
    }

    this._updateHud(localSample);
  }

  _stepPlayers(dt, homeInput, awayInput) {
    const homeDir = this.secondHalf ? -1 : 1;
    const awayDir = -homeDir;

    // Auto-switch active player to ball carrier when team gains possession
    if (this.ball.ownerId) {
      const owner = this.players.find((p) => p.id === this.ball.ownerId);
      if (owner && owner.role !== 'GK') {
        if (owner.team === 'HOME') this.controlledHomeId = owner.id;
        if (owner.team === 'AWAY' && this.mode === 'ONLINE') this.controlledAwayId = owner.id;
      }
    }

    if (homeInput?.switchPressed) {
      this._switchControlledPlayer('HOME');
    }
    if (awayInput?.switchPressed) {
      this._switchControlledPlayer('AWAY');
    }

    const homeCarrier = this.players.find((p) => p.team === 'HOME' && p.id === this.ball.ownerId);
    const awayCarrier = this.players.find((p) => p.team === 'AWAY' && p.id === this.ball.ownerId);

    // Closest AI chaser per team when defending
    const homeChaser = this._findClosestOutfield('HOME', this.ball.x, this.ball.y);
    const awayChaser = this._findClosestOutfield('AWAY', this.ball.x, this.ball.y);

    for (const p of this.players) {
      if (!p) continue;
      p.stunTimer = Math.max(0, (p.stunTimer || 0) - dt);

      const isHome = p.team === 'HOME';
      const attackDir = isHome ? homeDir : awayDir;
      const isUserControlled =
        (isHome && p.id === this.controlledHomeId) ||
        (!isHome && this.mode === 'ONLINE' && p.id === this.controlledAwayId);

      const activeInput = isHome ? homeInput : awayInput;
      const maxBaseSpeed = FIELD.BASE_PLAYER_SPEED * (0.82 + (p.speed / 100) * 0.34);

      if (isUserControlled && activeInput) {
        // Human controlled player movement
        const sprinting = activeInput.sprint && p.stamina > 8;
        if (sprinting && (Math.abs(activeInput.mx) > 0.1 || Math.abs(activeInput.my) > 0.1)) {
          p.stamina = clamp(p.stamina - 22 * dt, 0, 100);
        } else {
          p.stamina = clamp(p.stamina + 14 * dt, 0, 100);
        }

        const moveSpeed = maxBaseSpeed * (sprinting ? FIELD.SPRINT_MULTIPLIER : 1);
        p.vx = activeInput.mx * moveSpeed;
        p.vy = activeInput.my * moveSpeed;

        if (Math.hypot(p.vx, p.vy) > 6) {
          const f = normalize(p.vx, p.vy);
          p.facingX = f.x;
          p.facingY = f.y;
        }

        // Handle Pass / Through / Shoot actions
        if (this.ball.ownerId === p.id) {
          if (activeInput.passPressed) {
            this._performPass(p, attackDir, false);
          } else if (activeInput.throughPressed) {
            this._performPass(p, attackDir, true);
          } else if (activeInput.shootReleased) {
            this._performShoot(p, attackDir, activeInput.shootPower, activeInput.curveFactor);
          }
        } else if (activeInput.passPressed) {
          // Standing tackle / pressure lunge when off-ball
          this._attemptTackle(p);
        }
      } else {
        // AI Teammate or AI Opponent
        p.stamina = clamp(p.stamina + 12 * dt, 0, 100);
        const teamHasBall = isHome ? Boolean(homeCarrier) : Boolean(awayCarrier);

        if (this.ball.ownerId === p.id) {
          const teammates = this.players.filter((m) => m.team === p.team);
          const opponents = this.players.filter((m) => m.team !== p.team);
          const decision = decideBallCarrierAction(p, teammates, opponents, attackDir, dt);

          if (decision.action === 'PASS' && decision.target) {
            const d = normalize(decision.target.x - p.x, decision.target.y - p.y);
            const passSpd = 260 + (p.pass / 100) * 145;
            kickBall(this.ball, d.x, d.y, passSpd, 0, p);
          } else if (decision.action === 'SHOOT') {
            this._performShoot(p, attackDir, decision.power, decision.curve, decision.dirX, decision.dirY);
          } else {
            p.vx = (decision.mx || 0) * maxBaseSpeed * 0.92;
            p.vy = (decision.my || 0) * maxBaseSpeed * 0.92;
          }
        } else if (!teamHasBall && p.role !== 'GK' && (isHome ? p.id === homeChaser?.id : p.id === awayChaser?.id)) {
          // Pressing ball chaser
          const chase = normalize(this.ball.x - p.x, this.ball.y - p.y);
          p.vx = chase.x * maxBaseSpeed * 0.95;
          p.vy = chase.y * maxBaseSpeed * 0.95;
          if (chase.len < 28) {
            this._attemptTackle(p);
          }
        } else {
          // Tactical 1-2-1 spacing or GK angle positioning
          const anchor = getTacticalAnchor(p, this.ball, attackDir, teamHasBall);
          const toAnchor = normalize(anchor.x - p.x, anchor.y - p.y);
          if (toAnchor.len > 6) {
            const factor = clamp(toAnchor.len / 60, 0.25, 1) * FIELD.AI_SUPPORT_SPEED_FACTOR;
            p.vx = toAnchor.x * maxBaseSpeed * factor;
            p.vy = toAnchor.y * maxBaseSpeed * factor;
          } else {
            p.vx = 0;
            p.vy = 0;
          }
        }

        if (Math.hypot(p.vx, p.vy) > 6) {
          const f = normalize(p.vx, p.vy);
          p.facingX = f.x;
          p.facingY = f.y;
        }
      }

      p.x = clamp(p.x + p.vx * dt, FIELD.MARGIN - 6, FIELD.WIDTH - FIELD.MARGIN + 6);
      p.y = clamp(p.y + p.vy * dt, FIELD.MARGIN - 6, FIELD.HEIGHT - FIELD.MARGIN + 6);
    }
  }

  _switchControlledPlayer(team) {
    const candidates = this.players.filter((p) => p.team === team && p.role !== 'GK');
    if (candidates.length === 0) return;

    const currentId = team === 'HOME' ? this.controlledHomeId : this.controlledAwayId;
    candidates.sort((a, b) => dist(a.x, a.y, this.ball.x, this.ball.y) - dist(b.x, b.y, this.ball.x, this.ball.y));

    const next = candidates.find((p) => p.id !== currentId) || candidates[0];
    if (team === 'HOME') this.controlledHomeId = next.id;
    else this.controlledAwayId = next.id;
  }

  _findClosestOutfield(team, x, y) {
    let best = null;
    let minD = 9999;
    for (const p of this.players) {
      if (p.team !== team || p.role === 'GK') continue;
      const d = dist(p.x, p.y, x, y);
      if (d < minD) {
        minD = d;
        best = p;
      }
    }
    return best;
  }

  _performPass(passer, attackDir, isThrough) {
    const teammates = this.players.filter((p) => p.team === passer.team && p.id !== passer.id);
    const opponents = this.players.filter((p) => p.team !== passer.team);
    const target = findBestPassTarget(passer, teammates, opponents, attackDir, isThrough);

    let dirX = passer.facingX || attackDir;
    let dirY = passer.facingY || 0;

    if (target) {
      const leadX = isThrough ? target.x + attackDir * 58 : target.x;
      const leadY = isThrough ? target.y + target.vy * 0.25 : target.y;
      const n = normalize(leadX - passer.x, leadY - passer.y);
      if (n.len > 0) {
        dirX = n.x;
        dirY = n.y;
      }
      if (passer.team === 'HOME') this.controlledHomeId = target.id;
      else if (this.mode === 'ONLINE') this.controlledAwayId = target.id;
    }

    const baseSpeed = isThrough ? 320 : 275;
    const speed = baseSpeed + (passer.pass / 100) * 145;
    kickBall(this.ball, dirX, dirY, speed, 0, passer);
  }

  _performShoot(shooter, attackDir, power, curveFactor, customDirX = null, customDirY = null) {
    const oppGoalX = attackDir === 1 ? FIELD.WIDTH - FIELD.MARGIN : FIELD.MARGIN;
    const oppGoalY = FIELD.HEIGHT / 2;

    let dirX = customDirX;
    let dirY = customDirY;

    if (dirX === null || dirY === null) {
      // Blend player facing with smart goal-frame aim assist
      const toGoal = normalize(oppGoalX - shooter.x, oppGoalY - shooter.y);
      const aimX = shooter.facingX * 0.45 + toGoal.x * 0.55;
      const aimY = shooter.facingY * 0.55 + toGoal.y * 0.45;
      const blended = normalize(aimX, aimY);
      dirX = blended.len > 0 ? blended.x : attackDir;
      dirY = blended.len > 0 ? blended.y : 0;
    }

    const shotStat = clamp(shooter.shoot, 40, 99) / 100;
    const dribbleStat = clamp(shooter.dribble, 40, 99) / 100;
    const finalSpeed = (340 + shotStat * 210) * clamp(power, 0.35, 1.0);
    const spin = clamp(curveFactor, -1, 1) * (0.45 + dribbleStat * 0.65);

    kickBall(this.ball, dirX, dirY, finalSpeed, spin, shooter);
  }

  _attemptTackle(defender) {
    if (!this.ball.ownerId || this.ball.ownerId === defender.id) return;
    const carrier = this.players.find((p) => p.id === this.ball.ownerId);
    if (!carrier || carrier.team === defender.team || carrier.role === 'GK') return;

    if (dist(defender.x, defender.y, carrier.x, carrier.y) <= FIELD.PLAYER_RADIUS * 2.3) {
      const defFactor = (defender.defense || 75) / ((carrier.dribble || 75) + 40);
      if (Math.random() < clamp(defFactor, 0.3, 0.78)) {
        this.ball.ownerId = defender.id;
        carrier.stunTimer = 0.45;
        if (defender.team === 'HOME') this.controlledHomeId = defender.id;
        else if (this.mode === 'ONLINE') this.controlledAwayId = defender.id;
      }
    }
  }

  _handlePhysicsEvent(res) {
    if (res.event === 'GOAL') {
      this.score[res.scorer] = (this.score[res.scorer] || 0) + 1;
      const scorerTeam = res.scorer === 'HOME' ? this.homeTeam : this.awayTeam;
      this._triggerBanner('GOAL!', `${scorerTeam.name.toUpperCase()} SCORES!`, 2.0);

      // Golden goal rule during Extra Time
      if (this.period === 3) {
        this._finishMatch();
        return;
      }

      const conceding = res.scorer === 'HOME' ? 'AWAY' : 'HOME';
      this._arrangeKickoff(conceding);
      return;
    }

    if (res.event === 'KICK_IN' || res.event === 'CORNER' || res.event === 'GOAL_KICK' || res.event === 'HANDBALL') {
      const labels = {
        KICK_IN: 'OUT — KICK-IN',
        CORNER: 'CORNER KICK',
        GOAL_KICK: 'GOAL KICK',
        HANDBALL: 'HANDBALL — FREE KICK',
      };
      const teamObj = res.team === 'HOME' ? this.homeTeam : this.awayTeam;
      this._triggerBanner(labels[res.event], `BOLA UNTUK ${teamObj.abbr}`, 1.2);

      this.phase = 'SET_PIECE';
      this.setPieceTimer = 0.75;
      this.restartTeam = res.team;
      this.restartSpot = { x: res.x, y: res.y };
      resetBallToSpot(this.ball, res.x, res.y);
    }
  }

  _executeSetPiece() {
    if (!this.restartSpot || !this.restartTeam) {
      this.phase = this.period === 3 ? 'EXTRA_TIME' : 'PLAYING';
      return;
    }

    const taker =
      this._findClosestOutfield(this.restartTeam, this.restartSpot.x, this.restartSpot.y) ||
      this.players.find((p) => p.team === this.restartTeam);

    if (taker) {
      taker.x = clamp(this.restartSpot.x, FIELD.MARGIN, FIELD.WIDTH - FIELD.MARGIN);
      taker.y = clamp(this.restartSpot.y, FIELD.MARGIN, FIELD.HEIGHT - FIELD.MARGIN);
      this.ball.ownerId = taker.id;
      if (this.restartTeam === 'HOME') this.controlledHomeId = taker.id;
      else if (this.mode === 'ONLINE') this.controlledAwayId = taker.id;
    }

    this.restartSpot = null;
    this.restartTeam = null;
    this.phase = this.period === 3 ? 'EXTRA_TIME' : 'PLAYING';
  }

  _handlePeriodEnd() {
    if (this.period === 1) {
      // Switch sides for 2nd Half
      this.period = 2;
      this.secondHalf = true;
      this.periodClock = this.totalDurationSec / 2;
      this._arrangeKickoff('AWAY');
      this._triggerBanner('2ND HALF — TUKAR SISI', 'BABAK KEDUA DIMULAI', 2.0);
      return;
    }

    if (this.period === 2) {
      if (this.score.HOME !== this.score.AWAY) {
        this._finishMatch();
        return;
      }
      // Tied after 2 halves -> 2-minute Extra Time
      this.period = 3;
      this.periodClock = 120;
      this.phase = 'EXTRA_TIME';
      this._arrangeKickoff('HOME');
      this._triggerBanner('DRAW! EXTRA TIME 2 MENIT', 'GOLDEN GOAL AKTIF', 2.2);
      return;
    }

    if (this.period === 3) {
      if (this.score.HOME !== this.score.AWAY) {
        this._finishMatch();
        return;
      }
      // Still tied after Extra Time -> 3-taker Penalty Shootout
      this._startPenaltyShootout();
    }
  }

  // ==================== TIE-BREAKER 2: PENALTY SHOOTOUT (3 KICKERS) ====================
  _startPenaltyShootout() {
    this.phase = 'PENALTY';
    this.penaltyState = {
      isGoldenBall: false,
      round: 1,
      maxRounds: 3,
      turnTeam: 'HOME', // 'HOME' kicks first, then 'AWAY'
      homeGoals: 0,
      awayGoals: 0,
      homeKicks: 0,
      awayKicks: 0,
      history: [],
    };
    this.callbacks.onPenaltyUpdate?.(this.penaltyState, this);
    this._checkAiPenaltyTurn();
  }

  submitPenaltyChoice(side, dir) {
    if ((this.phase !== 'PENALTY' && this.phase !== 'GOLDEN_KICK') || !this.penaltyState) return;
    const st = this.penaltyState;
    const chosenDir = clamp(Math.round(Number(dir) || 0), -1, 1);

    // If online guest submitted, forward to host
    if (this.mode === 'ONLINE' && this.localSide === 'AWAY') {
      this.network.send({ type: 'PENALTY_CHOICE', dir: chosenDir });
      return;
    }

    const keeperDir = [-1, 0, 1][Math.floor(Math.random() * 3)];
    const scored = chosenDir !== keeperDir || Math.random() < 0.25;

    if (st.turnTeam === 'HOME') {
      st.homeKicks++;
      if (scored) st.homeGoals++;
    } else {
      st.awayKicks++;
      if (scored) st.awayGoals++;
    }

    st.history.push({ team: st.turnTeam, scored });

    // Golden Ball single decisive kick resolution
    if (st.isGoldenBall) {
      if (scored) {
        this.score[st.turnTeam] += 1;
      } else {
        const other = st.turnTeam === 'HOME' ? 'AWAY' : 'HOME';
        this.score[other] += 1;
      }
      this.callbacks.onPenaltyClose?.();
      this._finishMatch();
      return;
    }

    // Check 3-round penalty completion
    if (st.homeKicks >= st.maxRounds && st.awayKicks >= st.maxRounds && st.homeKicks === st.awayKicks) {
      if (st.homeGoals !== st.awayGoals) {
        this.score.HOME += st.homeGoals;
        this.score.AWAY += st.awayGoals;
        this.callbacks.onPenaltyClose?.();
        this._finishMatch();
        return;
      } else {
        // Still tied after 3 penalties -> Golden Ball Suit!
        this.score.HOME += st.homeGoals;
        this.score.AWAY += st.awayGoals;
        this.callbacks.onPenaltyClose?.();
        this._startGoldenBallSuit();
        return;
      }
    }

    st.turnTeam = st.turnTeam === 'HOME' ? 'AWAY' : 'HOME';
    if (st.turnTeam === 'HOME') st.round++;
    this.callbacks.onPenaltyUpdate?.(st, this);
    this._checkAiPenaltyTurn();
  }

  _checkAiPenaltyTurn() {
    if (!this.penaltyState) return;
    if (this.mode === 'AI' && this.penaltyState.turnTeam === 'AWAY') {
      setTimeout(() => {
        if (this.phase === 'PENALTY' || this.phase === 'GOLDEN_KICK') {
          const aiDir = [-1, 0, 1][Math.floor(Math.random() * 3)];
          this.submitPenaltyChoice('AWAY', aiDir);
        }
      }, 900);
    }
  }

  // ==================== TIE-BREAKER 3: GOLDEN BALL (SUIT) ====================
  _startGoldenBallSuit() {
    this.phase = 'SUIT';
    this.suitState = {
      homePick: null,
      awayPick: null,
      winner: null,
      statusText: 'Adu Penalti Seri! Pilih Gunting, Batu, atau Kertas untuk Golden Ball.',
    };
    this.callbacks.onSuitUpdate?.(this.suitState, this);
  }

  submitSuitChoice(pick) {
    if (this.phase !== 'SUIT' || !this.suitState) return;
    const valid = ['GUNTING', 'BATU', 'KERTAS'];
    if (!valid.includes(pick)) return;

    if (this.mode === 'ONLINE' && this.localSide === 'AWAY') {
      this.network.send({ type: 'SUIT_PICK', pick });
      return;
    }

    this.suitState.homePick = pick;
    if (this.mode === 'AI') {
      this.suitState.awayPick = valid[Math.floor(Math.random() * 3)];
    }

    this._evaluateSuit();
  }

  receiveRemoteSuitPick(pick) {
    if (!this.suitState) return;
    this.suitState.awayPick = pick;
    this._evaluateSuit();
  }

  _evaluateSuit() {
    const st = this.suitState;
    if (!st.homePick || !st.awayPick) {
      st.statusText = 'Menunggu pilihan suit lawan...';
      this.callbacks.onSuitUpdate?.(st, this);
      return;
    }

    if (st.homePick === st.awayPick) {
      st.statusText = `Seri (${st.homePick} vs ${st.awayPick})! Pilih ulang suit.`;
      st.homePick = null;
      st.awayPick = null;
      this.callbacks.onSuitUpdate?.(st, this);
      return;
    }

    const winsAgainst = {
      GUNTING: 'KERTAS',
      BATU: 'GUNTING',
      KERTAS: 'BATU',
    };
    const winner = winsAgainst[st.homePick] === st.awayPick ? 'HOME' : 'AWAY';
    st.winner = winner;
    const winTeamName = winner === 'HOME' ? this.homeTeam.name : this.awayTeam.name;
    st.statusText = `${winTeamName} menang suit (${st.homePick} vs ${st.awayPick})! Pilih Menendang atau Menepis.`;
    this.callbacks.onSuitUpdate?.(st, this);

    // If AI won suit, AI picks role automatically
    if (this.mode === 'AI' && winner === 'AWAY') {
      setTimeout(() => {
        this.submitSuitRole(Math.random() > 0.5 ? 'KICK' : 'SAVE');
      }, 950);
    }
  }

  submitSuitRole(role) {
    if (this.phase !== 'SUIT' || !this.suitState || !this.suitState.winner) return;

    if (this.mode === 'ONLINE' && this.localSide === 'AWAY') {
      this.network.send({ type: 'SUIT_ROLE', role });
      return;
    }

    const winner = this.suitState.winner;
    const loser = winner === 'HOME' ? 'AWAY' : 'HOME';
    const kickerTeam = role === 'KICK' ? winner : loser;

    this.callbacks.onSuitClose?.();
    this.phase = 'GOLDEN_KICK';
    this.penaltyState = {
      isGoldenBall: true,
      round: 1,
      maxRounds: 1,
      turnTeam: kickerTeam,
      homeGoals: 0,
      awayGoals: 0,
      homeKicks: 0,
      awayKicks: 0,
      history: [],
    };
    this.callbacks.onPenaltyUpdate?.(this.penaltyState, this);
    this._checkAiPenaltyTurn();
  }

  _finishMatch() {
    this.phase = 'FULLTIME';
    this.paused = true;
    // Send the final authoritative snapshot immediately; the paused host loop
    // will no longer emit periodic state packets after this transition.
    if (this.mode === 'ONLINE' && this.localSide === 'HOME') {
      this.network.send({ type: 'STATE', snapshot: this.getNetworkSnapshot() });
    }
    const winnerName = this.score.HOME === this.score.AWAY
      ? 'PERTANDINGAN BERAKHIR SERI'
      : this.score.HOME > this.score.AWAY
        ? `${this.homeTeam.name} MENANG!`
        : `${this.awayTeam.name} MENANG!`;
    this.callbacks.onMatchEnd?.(winnerName, this.score, this.homeTeam, this.awayTeam);
  }

  _updateHud(localSample) {
    const periodNames = {
      1: '1ST HALF',
      2: '2ND HALF',
      3: 'EXTRA TIME',
    };
    const activeId = this.localSide === 'HOME' ? this.controlledHomeId : this.controlledAwayId;
    const activePlayer = this.players.find((p) => p.id === activeId) || this.players[0];

    this.callbacks.onHudUpdate?.({
      homeScore: this.score.HOME,
      awayScore: this.score.AWAY,
      periodLabel: periodNames[this.period] || 'PENALTY',
      clockText: formatClock(this.periodClock),
      activePlayer,
      chargeRatio: localSample?.currentCharge || 0,
      curveActive: Boolean(localSample?.curveActive),
    });
  }

  getNetworkSnapshot() {
    return {
      phase: this.phase,
      period: this.period,
      periodClock: this.periodClock,
      secondHalf: this.secondHalf,
      score: { ...this.score },
      controlledHomeId: this.controlledHomeId,
      controlledAwayId: this.controlledAwayId,
      ball: {
        x: Math.round(this.ball.x * 10) / 10,
        y: Math.round(this.ball.y * 10) / 10,
        vx: Math.round(this.ball.vx),
        vy: Math.round(this.ball.vy),
        spin: this.ball.spin,
        ownerId: this.ball.ownerId,
      },
      restartSpot: this.restartSpot ? { ...this.restartSpot } : null,
      restartTeam: this.restartTeam,
      penaltyState: this.penaltyState ? JSON.parse(JSON.stringify(this.penaltyState)) : null,
      suitState: this.suitState ? JSON.parse(JSON.stringify(this.suitState)) : null,
      players: this.players.map((p) => ({
        id: p.id,
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        vx: Math.round(p.vx),
        vy: Math.round(p.vy),
        facingX: p.facingX,
        facingY: p.facingY,
        stamina: Math.round(p.stamina),
        stunTimer: p.stunTimer,
      })),
    };
  }


  applyNetworkSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    const previousPhase = this.phase;
    const previousPenaltyKey = this.penaltyState
      ? `${this.penaltyState.turnTeam}|${this.penaltyState.round}|${this.penaltyState.homeGoals}|${this.penaltyState.awayGoals}|${this.penaltyState.isGoldenBall}`
      : '';
    const previousSuitKey = this.suitState
      ? `${this.suitState.homePick}|${this.suitState.awayPick}|${this.suitState.winner}|${this.suitState.statusText}`
      : '';
    this.phase = snap.phase || this.phase;
    if (this.phase === 'FULLTIME') this.paused = true;
    this.period = safeNum(snap.period, this.period);
    this.periodClock = safeNum(snap.periodClock, this.periodClock);
    this.secondHalf = Boolean(snap.secondHalf);
    if (snap.score && typeof snap.score === 'object') {
      this.score = {
        HOME: safeNum(snap.score.HOME, this.score.HOME),
        AWAY: safeNum(snap.score.AWAY, this.score.AWAY),
      };
    }
    this.controlledHomeId = snap.controlledHomeId || this.controlledHomeId;
    this.controlledAwayId = snap.controlledAwayId || this.controlledAwayId;

    if (snap.ball) {
      this.ball.x = safeNum(snap.ball.x, this.ball.x);
      this.ball.y = safeNum(snap.ball.y, this.ball.y);
      this.ball.vx = safeNum(snap.ball.vx, 0);
      this.ball.vy = safeNum(snap.ball.vy, 0);
      this.ball.spin = safeNum(snap.ball.spin, 0);
      this.ball.ownerId = snap.ball.ownerId || null;
    }


    this.restartSpot = snap.restartSpot && typeof snap.restartSpot === 'object'
      ? { x: safeNum(snap.restartSpot.x, FIELD.WIDTH / 2), y: safeNum(snap.restartSpot.y, FIELD.HEIGHT / 2) }
      : null;
    this.restartTeam = snap.restartTeam === 'HOME' || snap.restartTeam === 'AWAY' ? snap.restartTeam : null;
    this.penaltyState = snap.penaltyState && typeof snap.penaltyState === 'object'
      ? JSON.parse(JSON.stringify(snap.penaltyState)) : null;
    this.suitState = snap.suitState && typeof snap.suitState === 'object'
      ? JSON.parse(JSON.stringify(snap.suitState)) : null;

    if (Array.isArray(snap.players)) {
      const map = new Map(snap.players.map((sp) => [sp.id, sp]));
      for (const p of this.players) {
        const sp = map.get(p.id);
        if (sp) {
          p.x = safeNum(sp.x, p.x);
          p.y = safeNum(sp.y, p.y);
          p.vx = safeNum(sp.vx, p.vx);
          p.vy = safeNum(sp.vy, p.vy);
          p.facingX = safeNum(sp.facingX, p.facingX);
          p.facingY = safeNum(sp.facingY, p.facingY);
          p.stamina = safeNum(sp.stamina, p.stamina);
          p.stunTimer = safeNum(sp.stunTimer, p.stunTimer);
        }
      }
    }


    // Mirror host-only phase callbacks on the Guest so online penalties,
    // Golden Ball choices, and full-time overlays are usable on both devices.
    const penaltyKey = this.penaltyState
      ? `${this.penaltyState.turnTeam}|${this.penaltyState.round}|${this.penaltyState.homeGoals}|${this.penaltyState.awayGoals}|${this.penaltyState.isGoldenBall}`
      : '';
    const suitKey = this.suitState
      ? `${this.suitState.homePick}|${this.suitState.awayPick}|${this.suitState.winner}|${this.suitState.statusText}`
      : '';

    if ((previousPhase === 'PENALTY' || previousPhase === 'GOLDEN_KICK') && this.phase !== 'PENALTY' && this.phase !== 'GOLDEN_KICK') {
      this.callbacks.onPenaltyClose?.();
    }
    if (previousPhase === 'SUIT' && this.phase !== 'SUIT') this.callbacks.onSuitClose?.();
    if ((this.phase === 'PENALTY' || this.phase === 'GOLDEN_KICK') && (previousPhase !== this.phase || previousPenaltyKey !== penaltyKey)) {
      this.callbacks.onPenaltyUpdate?.(this.penaltyState, this);
    }
    if (this.phase === 'SUIT' && (previousPhase !== 'SUIT' || previousSuitKey !== suitKey)) {
      this.callbacks.onSuitUpdate?.(this.suitState, this);
    }
    if (this.phase === 'FULLTIME' && previousPhase !== 'FULLTIME') {
      const winnerName = this.score.HOME === this.score.AWAY
        ? 'PERTANDINGAN BERAKHIR SERI'
        : this.score.HOME > this.score.AWAY
          ? `${this.homeTeam?.name || 'HOME'} MENANG!`
          : `${this.awayTeam?.name || 'AWAY'} MENANG!`;
      this.callbacks.onMatchEnd?.(winnerName, this.score, this.homeTeam, this.awayTeam);
    }
  }

}
