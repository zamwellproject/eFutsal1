// ============================================================================
// renderer.js — High-DPI Calibrated Tactical Broadcast Canvas Renderer
// ============================================================================
import { FIELD } from './data.js';
import { clamp } from './utils.js';

export class ArenaRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.dpr = 1;
    this.scale = 1;
    this.resize();
  }

  resize() {
    if (!this.canvas || !this.canvas.parentElement) return;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const availW = Math.max(280, rect.width);
    const availH = Math.max(180, rect.height);

    // Maintain 1000:560 aspect ratio cleanly inside container
    const aspect = FIELD.WIDTH / FIELD.HEIGHT;
    let cssW = availW;
    let cssH = availW / aspect;
    if (cssH > availH) {
      cssH = availH;
      cssW = availH * aspect;
    }

    // Cap DPR at 1.65 for locked 60/120Hz performance on mobile & retina displays
    this.dpr = clamp(window.devicePixelRatio || 1, 1, 1.65);
    this.canvas.style.width = `${Math.floor(cssW)}px`;
    this.canvas.style.height = `${Math.floor(cssH)}px`;
    this.canvas.width = Math.floor(cssW * this.dpr);
    this.canvas.height = Math.floor(cssH * this.dpr);
    this.scale = (cssW / FIELD.WIDTH) * this.dpr;
  }

  render(state) {
    const ctx = this.ctx;
    if (!ctx || !state) return;

    ctx.save();
    ctx.scale(this.scale, this.scale);

    this._drawPitch(ctx, state);
    this._drawBallTrail(ctx, state.ball);
    this._drawPlayers(ctx, state);
    this._drawBall(ctx, state.ball);

    ctx.restore();
  }

  _drawPitch(ctx, state) {
    const w = FIELD.WIDTH;
    const h = FIELD.HEIGHT;
    const m = FIELD.MARGIN;

    // Outer stadium apron
    ctx.fillStyle = '#07131f';
    ctx.fillRect(0, 0, w, h);

    // Futsal court surface (deep tactical blue-teal court with subtle parquet bands)
    const courtGrad = ctx.createLinearGradient(m, m, w - m, h - m);
    courtGrad.addColorStop(0, '#0d3b5c');
    courtGrad.addColorStop(0.5, '#114b72');
    courtGrad.addColorStop(1, '#0d3b5c');
    ctx.fillStyle = courtGrad;
    ctx.fillRect(m, m, w - m * 2, h - m * 2);

    // Subtle vertical court zones
    const bands = 10;
    const bandW = (w - m * 2) / bands;
    for (let i = 0; i < bands; i++) {
      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.025)';
        ctx.fillRect(m + i * bandW, m, bandW, h - m * 2);
      }
    }

    // Pitch lines
    ctx.strokeStyle = 'rgba(235, 248, 255, 0.85)';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(m, m, w - m * 2, h - m * 2);

    // Halfway line & center circle
    ctx.beginPath();
    ctx.moveTo(w / 2, m);
    ctx.lineTo(w / 2, h - m);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(w / 2, h / 2, FIELD.CENTER_CIRCLE_RADIUS, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 4, 0, Math.PI * 2);
    ctx.fill();

    // Penalty D-arcs (Left & Right)
    ctx.beginPath();
    ctx.arc(m, h / 2, FIELD.PENALTY_AREA_RADIUS, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(w - m, h / 2, FIELD.PENALTY_AREA_RADIUS, Math.PI / 2, (Math.PI * 3) / 2);
    ctx.stroke();

    // Penalty spots
    ctx.beginPath();
    ctx.arc(m + FIELD.PENALTY_SPOT_DIST, h / 2, 3.5, 0, Math.PI * 2);
    ctx.arc(w - m - FIELD.PENALTY_SPOT_DIST, h / 2, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Goals (Left & Right)
    const goalTop = h / 2 - FIELD.GOAL_WIDTH / 2;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;

    // Left goal net
    ctx.fillRect(m - FIELD.GOAL_DEPTH, goalTop, FIELD.GOAL_DEPTH, FIELD.GOAL_WIDTH);
    ctx.strokeRect(m - FIELD.GOAL_DEPTH, goalTop, FIELD.GOAL_DEPTH, FIELD.GOAL_WIDTH);

    // Right goal net
    ctx.fillRect(w - m, goalTop, FIELD.GOAL_DEPTH, FIELD.GOAL_WIDTH);
    ctx.strokeRect(w - m, goalTop, FIELD.GOAL_DEPTH, FIELD.GOAL_WIDTH);

    // Restart marker if set-piece active
    if (state.restartSpot) {
      ctx.save();
      ctx.strokeStyle = '#ffd54f';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(state.restartSpot.x, state.restartSpot.y, 18, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawBallTrail(ctx, ball) {
    if (!ball || !Array.isArray(ball.trail) || ball.trail.length < 2) return;
    for (let i = 0; i < ball.trail.length; i++) {
      const pt = ball.trail[i];
      const alpha = ((i + 1) / ball.trail.length) * 0.42;
      const radius = FIELD.BALL_RADIUS * ((i + 1) / ball.trail.length) * 0.85;
      ctx.fillStyle =
        Math.abs(pt.spin) > 0.2
          ? `rgba(255, 213, 79, ${alpha})`
          : `rgba(0, 229, 255, ${alpha})`;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawPlayers(ctx, state) {
    const { players, homeKit, awayKit, controlledHomeId, controlledAwayId } = state;
    if (!Array.isArray(players)) return;

    for (const p of players) {
      if (!p) continue;
      const isHome = p.team === 'HOME';
      const kit = isHome ? homeKit : awayKit;
      const isControlled = p.id === controlledHomeId || p.id === controlledAwayId;

      // Ground shadow
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + 5, FIELD.PLAYER_RADIUS, FIELD.PLAYER_RADIUS * 0.65, 0, 0, Math.PI * 2);
      ctx.fill();

      // Active player tactical cursor ring (eFootball style)
      if (isControlled) {
        ctx.strokeStyle = isHome ? '#00e676' : '#00e5ff';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, FIELD.PLAYER_RADIUS + 5.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Player body circle
      ctx.fillStyle = p.role === 'GK' ? '#1e293b' : kit.primaryColor;
      ctx.strokeStyle = p.role === 'GK' ? '#ffd54f' : kit.accentColor;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, FIELD.PLAYER_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Jersey number
      ctx.fillStyle = '#ffffff';
      ctx.font = '800 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = 3;
      ctx.fillText(String(p.number), p.x, p.y + 0.5);
      ctx.shadowBlur = 0;

      // Player name tag below
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.font = '700 9.5px system-ui, sans-serif';
      ctx.fillText(p.name, p.x, p.y + FIELD.PLAYER_RADIUS + 11);
    }
  }

  _drawBall(ctx, ball) {
    if (!ball) return;

    // Shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
    ctx.beginPath();
    ctx.ellipse(ball.x + 2, ball.y + 4, FIELD.BALL_RADIUS, FIELD.BALL_RADIUS * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();

    // Futsal ball
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, FIELD.BALL_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Pentagon accent dot
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
}
