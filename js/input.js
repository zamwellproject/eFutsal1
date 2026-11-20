// ============================================================================
// input.js — Hybrid Keyboard + Virtual Touch Joystick & Action Buttons
// ============================================================================
import { clamp, isTouchDevice } from './utils.js';

export class InputController {
  constructor() {
    this.keys = new Set();
    this.justPressed = new Set();
    this.justReleased = new Set();

    // Virtual Touch State
    this.joyVec = { x: 0, y: 0 };
    this.joyPointerId = null;
    this.touchButtons = {
      pass: false,
      through: false,
      sprint: false,
      switch: false,
      shoot: false,
    };
    this.touchCurveToggle = false;
    this.shootCharging = false;
    this.shootChargeTime = 0;
    this.lastCurveDir = 0; // -1 left/up curve, +1 right/down curve

    this._bindKeyboard();
    this._bindTouch();
  }

  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      const code = e.code;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(code)) {
        e.preventDefault();
      }
      if (!this.keys.has(code)) {
        this.justPressed.add(code);
      }
      this.keys.add(code);
    }, { passive: false });

    window.addEventListener('keyup', (e) => {
      const code = e.code;
      this.keys.delete(code);
      this.justReleased.add(code);
    });

    window.addEventListener('blur', () => {
      this.keys.clear();
      this.shootCharging = false;
      this.shootChargeTime = 0;
    });
  }

  _bindTouch() {
    if (isTouchDevice()) {
      document.body.classList.add('is-touch');
    }

    const joyZone = document.getElementById('joystick-zone');
    const joyStick = document.getElementById('joystick-stick');

    if (joyZone && joyStick) {
      const updateStick = (clientX, clientY) => {
        const rect = joyZone.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const maxR = Math.max(24, rect.width * 0.36);
        let dx = clientX - cx;
        let dy = clientY - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > maxR) {
          dx = (dx / dist) * maxR;
          dy = (dy / dist) * maxR;
        }
        this.joyVec.x = clamp(dx / maxR, -1, 1);
        this.joyVec.y = clamp(dy / maxR, -1, 1);
        joyStick.style.transform = `translate(${dx}px, ${dy}px)`;
      };

      const resetStick = () => {
        this.joyPointerId = null;
        this.joyVec.x = 0;
        this.joyVec.y = 0;
        joyStick.style.transform = 'translate(0px, 0px)';
      };

      joyZone.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.joyPointerId = e.pointerId;
        joyZone.setPointerCapture?.(e.pointerId);
        updateStick(e.clientX, e.clientY);
      }, { passive: false });

      joyZone.addEventListener('pointermove', (e) => {
        if (e.pointerId !== this.joyPointerId) return;
        e.preventDefault();
        updateStick(e.clientX, e.clientY);
      }, { passive: false });

      joyZone.addEventListener('pointerup', (e) => {
        if (e.pointerId === this.joyPointerId) resetStick();
      });
      joyZone.addEventListener('pointercancel', (e) => {
        if (e.pointerId === this.joyPointerId) resetStick();
      });
    }

    const bindBtn = (id, keyName, onTap = null) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.classList.add('pressed');
        if (keyName) this.touchButtons[keyName] = true;
        if (onTap) onTap(el);
      }, { passive: false });

      const release = () => {
        el.classList.remove('pressed');
        if (keyName) this.touchButtons[keyName] = false;
      };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('pointerleave', release);
    };

    bindBtn('tbtn-pass', 'pass', () => this.justPressed.add('TOUCH_PASS'));
    bindBtn('tbtn-through', 'through', () => this.justPressed.add('TOUCH_THROUGH'));
    bindBtn('tbtn-switch', 'switch', () => this.justPressed.add('TOUCH_SWITCH'));
    bindBtn('tbtn-sprint', 'sprint');
    bindBtn('tbtn-shoot', 'shoot');

    const curveBtn = document.getElementById('tbtn-curve');
    if (curveBtn) {
      curveBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.touchCurveToggle = !this.touchCurveToggle;
        curveBtn.classList.toggle('active', this.touchCurveToggle);
      }, { passive: false });
    }
  }

  sample(dt) {
    // Movement axis
    let mx = this.joyVec.x;
    let my = this.joyVec.y;

    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) my -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) my += 1;

    const len = Math.hypot(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }

    const sprint =
      this.keys.has('KeyE') ||
      this.keys.has('ShiftLeft') ||
      this.keys.has('ShiftRight') ||
      this.touchButtons.sprint;

    const passPressed =
      this.justPressed.has('KeyJ') || this.justPressed.has('TOUCH_PASS');
    const throughPressed =
      this.justPressed.has('KeyL') || this.justPressed.has('TOUCH_THROUGH');
    const switchPressed =
      this.justPressed.has('KeyQ') || this.justPressed.has('TOUCH_SWITCH');

    const shootHeld =
      this.keys.has('KeyK') ||
      this.keys.has('Space') ||
      this.touchButtons.shoot;

    let shootReleased = false;
    let shootPower = 0;
    let curveFactor = 0;

    if (shootHeld) {
      if (!this.shootCharging) {
        this.shootCharging = true;
        this.shootChargeTime = 0;
        this.lastCurveDir = 0;
      }
      this.shootChargeTime = clamp(this.shootChargeTime + dt, 0, 1.15);
      // Track directional bend while charging shot
      if (Math.abs(my) > 0.25) {
        this.lastCurveDir = Math.sign(my);
      } else if (Math.abs(mx) > 0.25) {
        this.lastCurveDir = Math.sign(mx);
      }
    } else if (this.shootCharging) {
      shootReleased = true;
      shootPower = clamp(0.32 + (this.shootChargeTime / 1.05) * 0.68, 0.32, 1.0);
      if (this.touchCurveToggle && this.lastCurveDir === 0) {
        curveFactor = my !== 0 ? Math.sign(my) : 1;
      } else {
        curveFactor = this.lastCurveDir;
      }
      this.shootCharging = false;
      this.shootChargeTime = 0;
    }

    const currentCharge = this.shootCharging
      ? clamp(0.32 + (this.shootChargeTime / 1.05) * 0.68, 0, 1)
      : 0;

    const curveActive =
      (this.shootCharging && this.lastCurveDir !== 0) || this.touchCurveToggle;

    this.justPressed.clear();
    this.justReleased.clear();

    return {
      mx: clamp(mx, -1, 1),
      my: clamp(my, -1, 1),
      sprint,
      passPressed,
      throughPressed,
      switchPressed,
      shootHeld,
      shootReleased,
      shootPower,
      curveFactor,
      currentCharge,
      curveActive,
    };
  }
}
