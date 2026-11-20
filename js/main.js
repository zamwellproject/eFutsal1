// ============================================================================
// main.js — Application Orchestrator, UI Controllers, Squad Timer & Admin
// ============================================================================
import {
  ADMIN_PASSWORD,
  OFFICIAL_TEAMS,
  buildDefaultLineup,
  computeOverall,
  loadRosterDatabase,
  resetRosterDatabase,
  resolveDuplicateNumbers,
  saveRosterDatabase,
} from './data.js';
import { clamp, deepClone } from './utils.js';
import { InputController } from './input.js';
import { ArenaRenderer } from './renderer.js';
import { NetworkManager } from './network.js';
import { MatchEngine } from './engine.js';

class FutsalApp {
  constructor() {
    this.roster = loadRosterDatabase();
    this.mode = 'AI'; // 'AI' | 'ONLINE'
    this.localSide = 'HOME'; // 'HOME' | 'AWAY'

    // Squad customization state
    this.selectedTeamId = OFFICIAL_TEAMS[0].id;
    this.aiTeamId = OFFICIAL_TEAMS[1].id;
    this.primaryColor = OFFICIAL_TEAMS[0].primaryColor;
    this.accentColor = OFFICIAL_TEAMS[0].accentColor;
    this.durationMinutes = 4;
    this.selectedLineup = buildDefaultLineup(this.roster);
    this.poolFilter = 'ALL';

    // Online customization state
    this.localSquadLocked = false;
    this.remoteSquadConfig = null;
    this.onlineCountdown = 60;
    this.onlineTimerInterval = null;

    // Core subsystems
    this.input = new InputController();
    this.renderer = new ArenaRenderer(document.getElementById('game-canvas'));
    this.network = new NetworkManager();
    this.engine = new MatchEngine({
      renderer: this.renderer,
      input: this.input,
      network: this.network,
      callbacks: this._createEngineCallbacks(),
    });

    this._initUI();
    this._bindNetworkEvents();

    window.addEventListener('resize', () => this.renderer.resize());
    window.addEventListener('orientationchange', () => {
      setTimeout(() => this.renderer.resize(), 120);
    });
  }

  _showScreen(screenId) {
    document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
    const target = document.getElementById(screenId);
    if (target) target.classList.add('active');
    if (screenId === 'screen-game') {
      this.renderer.resize();
    }
  }

  _initUI() {
    // Main Menu navigation
    document.getElementById('btn-mode-ai')?.addEventListener('click', () => {
      this.mode = 'AI';
      this.localSide = 'HOME';
      this._openSquadScreen();
    });

    document.getElementById('btn-mode-online')?.addEventListener('click', () => {
      this.mode = 'ONLINE';
      this.network.cleanup();
      this._showScreen('screen-lobby');
    });

    // Online Lobby actions
    document.getElementById('btn-lobby-back')?.addEventListener('click', () => {
      this.network.cleanup();
      this._showScreen('screen-menu');
    });

    document.getElementById('btn-create-room')?.addEventListener('click', () => {
      this.network.createRoom();
    });

    document.getElementById('btn-join-room')?.addEventListener('click', () => {
      const code = document.getElementById('input-room-code')?.value || '';
      this.network.joinRoom(code);
    });

    document.getElementById('btn-lobby-retry')?.addEventListener('click', () => {
      const role = this.network.role;
      const code = this.network.roomCode;
      if (role === 'HOST') {
        this.network.createRoom(); // Create a fresh room ID after a collision/failure.
      } else if (role === 'GUEST' && code) {
        this.network.joinRoom(code); // Retry the same room code.
      } else {
        this.network.cleanup();
        document.getElementById('lobby-message').textContent = 'Siap membuat atau bergabung ke room baru.';
      }
    });


    document.getElementById('btn-copy-code')?.addEventListener('click', async () => {
      const code = this.network.roomCode;
      if (!code) return;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(code);
        } else {
          const temp = document.createElement('textarea');
          temp.value = code;
          temp.setAttribute('readonly', '');
          temp.style.position = 'fixed';
          temp.style.opacity = '0';
          document.body.appendChild(temp);
          temp.select();
          const copied = document.execCommand('copy');
          temp.remove();
          if (!copied) throw new Error('copy-failed');
        }
        document.getElementById('lobby-message').textContent = `Kode ${code} berhasil disalin.`;
      } catch {
        document.getElementById('lobby-message').textContent = `Salin kode room ini secara manual: ${code}`;
      }
    });

    // Squad screen controls
    this._populateTeamSelectors();

    document.getElementById('btn-squad-back')?.addEventListener('click', () => {
      this._stopOnlineCountdown();
      if (this.mode === 'ONLINE') this.network.cleanup();
      this._showScreen('screen-menu');
    });

    document.getElementById('select-team')?.addEventListener('change', (e) => {
      this.selectedTeamId = e.target.value;
      const team = OFFICIAL_TEAMS.find((t) => t.id === this.selectedTeamId) || OFFICIAL_TEAMS[0];
      this.primaryColor = team.primaryColor;
      this.accentColor = team.accentColor;
      document.getElementById('color-primary').value = this.primaryColor;
      document.getElementById('color-accent').value = this.accentColor;
      this._updateKitPreview();
    });

    document.getElementById('select-ai-team')?.addEventListener('change', (e) => {
      this.aiTeamId = e.target.value;
    });

    document.getElementById('color-primary')?.addEventListener('input', (e) => {
      this.primaryColor = e.target.value;
      this._updateKitPreview();
    });

    document.getElementById('color-accent')?.addEventListener('input', (e) => {
      this.accentColor = e.target.value;
      this._updateKitPreview();
    });

    document.getElementById('range-duration')?.addEventListener('input', (e) => {
      this.durationMinutes = clamp(Number(e.target.value) || 4, 3, 7);
      document.getElementById('label-duration').textContent = `${this.durationMinutes} Menit`;
      document.getElementById('label-half-sec').textContent = String((this.durationMinutes * 60) / 2);
    });

    document.getElementById('btn-auto-squad')?.addEventListener('click', () => {
      this.selectedLineup = buildDefaultLineup(this.roster);
      this._renderSquadUI();
    });

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.poolFilter = btn.dataset.filter || 'ALL';
        this._renderPlayerPool();
      });
    });

    document.getElementById('btn-confirm-squad')?.addEventListener('click', () => {
      this._confirmLocalSquad();
    });

    // Gameplay HUD & Overlays
    document.getElementById('btn-pause-game')?.addEventListener('click', () => {
      if (this.mode === 'ONLINE' && this.localSide === 'AWAY') {
        this.network.send({ type: 'PAUSE_REQUEST', paused: !this.engine.paused });
        const btn = document.getElementById('btn-pause-game');
        if (btn) { btn.textContent = 'WAIT'; setTimeout(() => { btn.textContent = 'II'; }, 900); }
        return;
      }
      this.engine.togglePause();
    });

    document.getElementById('btn-resume-game')?.addEventListener('click', () => {
      if (this.mode === 'ONLINE' && this.localSide === 'AWAY') {
        this.network.send({ type: 'PAUSE_REQUEST', paused: false });
        return;
      }
      this.engine.togglePause(false);
    });

    document.getElementById('btn-quit-match')?.addEventListener('click', () => {
      this.engine.stop();
      document.getElementById('overlay-pause')?.classList.add('hidden');
      document.getElementById('overlay-penalty')?.classList.add('hidden');
      document.getElementById('overlay-suit')?.classList.add('hidden');
      if (this.mode === 'ONLINE') this.network.cleanup();
      this._showScreen('screen-menu');
    });

    document.querySelectorAll('.pen-zone').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dir = Number(btn.dataset.dir) || 0;
        this.engine.submitPenaltyChoice(this.localSide, dir);
      });
    });

    document.querySelectorAll('.btn-suit').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pick = btn.dataset.suit;
        if (pick) this.engine.submitSuitChoice(pick);
      });
    });

    document.querySelectorAll('#suit-role-choices button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const role = btn.dataset.role;
        if (role) this.engine.submitSuitRole(role);
      });
    });

    // Admin Editor Modal
    this._initAdminModal();
  }

  _populateTeamSelectors() {
    const selTeam = document.getElementById('select-team');
    const selAi = document.getElementById('select-ai-team');
    if (!selTeam || !selAi) return;

    selTeam.innerHTML = '';
    selAi.innerHTML = '';

    OFFICIAL_TEAMS.forEach((team) => {
      const opt1 = document.createElement('option');
      opt1.value = team.id;
      opt1.textContent = `${team.name} (${team.abbr})`;
      selTeam.appendChild(opt1);

      const opt2 = document.createElement('option');
      opt2.value = team.id;
      opt2.textContent = `${team.name} (${team.abbr})`;
      selAi.appendChild(opt2);
    });

    selTeam.value = this.selectedTeamId;
    selAi.value = this.aiTeamId;
    this._updateKitPreview();
  }

  _updateKitPreview() {
    const team = OFFICIAL_TEAMS.find((t) => t.id === this.selectedTeamId) || OFFICIAL_TEAMS[0];
    const badge = document.getElementById('kit-preview-badge');
    const abbr = document.getElementById('kit-preview-abbr');
    if (badge) {
      badge.style.background = this.primaryColor;
      badge.style.borderColor = this.accentColor;
    }
    if (abbr) abbr.textContent = team.abbr;
  }

  _openSquadScreen() {
    this.localSquadLocked = false;
    this.remoteSquadConfig = null;
    this.selectedLineup = resolveDuplicateNumbers(this.selectedLineup);

    const isOnline = this.mode === 'ONLINE';
    document.getElementById('squad-mode-label').textContent = isOnline
      ? `ONLINE (${this.localSide === 'HOME' ? 'HOST' : 'GUEST'})`
      : 'MODE: VS AI BOT';

    document.getElementById('ai-opponent-box')?.classList.toggle('hidden', isOnline);
    document.getElementById('online-timer-box')?.classList.toggle('hidden', !isOnline);

    // Only Host or Single Player sets match duration
    const durInput = document.getElementById('range-duration');
    if (durInput) durInput.disabled = isOnline && this.localSide === 'AWAY';

    const confirmBtn = document.getElementById('btn-confirm-squad');
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = isOnline ? 'KUNCI SKUAD & SIAP' : 'KUNCI SKUAD & KICK-OFF';
    }

    document.getElementById('opponent-ready-status').textContent = isOnline
      ? 'Menunggu kedua pemain mengunci skuad sebelum waktu 60 detik habis...'
      : 'Pilih 4 Outfield + 1 GK untuk memulai pertandingan.';

    this._renderSquadUI();
    this._showScreen('screen-squad');

    if (isOnline) {
      this._startOnlineCountdown();
    } else {
      this._stopOnlineCountdown();
    }
  }

  _startOnlineCountdown() {
    this._stopOnlineCountdown();
    this.onlineCountdown = 60;
    const el = document.getElementById('online-countdown');
    if (el) el.textContent = `${this.onlineCountdown}s`;

    this.onlineTimerInterval = setInterval(() => {
      this.onlineCountdown -= 1;
      if (el) el.textContent = `${Math.max(0, this.onlineCountdown)}s`;

      if (this.onlineCountdown <= 0) {
        this._stopOnlineCountdown();
        // Auto-lock valid/default squad so online flow never stalls
        if (!this._isLineupValid()) {
          this.selectedLineup = buildDefaultLineup(this.roster);
        }
        if (!this.localSquadLocked) {
          this._confirmLocalSquad(true);
        }
        if (this.localSide === 'HOME' && !this.remoteSquadConfig) {
          this.remoteSquadConfig = this._buildFallbackRemoteConfig();
          this._tryLaunchOnlineMatch();
        }
      }
    }, 1000);
  }

  _stopOnlineCountdown() {
    if (this.onlineTimerInterval) {
      clearInterval(this.onlineTimerInterval);
      this.onlineTimerInterval = null;
    }
  }

  _isLineupValid() {
    const outCount = this.selectedLineup.filter((p) => p.role === 'OUTFIELD').length;
    const gkCount = this.selectedLineup.filter((p) => p.role === 'GK').length;
    return outCount === 4 && gkCount === 1;
  }

  _renderSquadUI() {
    this._renderLineupSlots();
    this._renderPlayerPool();
  }

  _renderLineupSlots() {
    const container = document.getElementById('active-lineup-list');
    const countEl = document.getElementById('selected-count');
    const valMsg = document.getElementById('squad-validation-msg');
    if (!container) return;

    this.selectedLineup = resolveDuplicateNumbers(this.selectedLineup);
    if (countEl) countEl.textContent = String(this.selectedLineup.length);

    container.innerHTML = '';
    this.selectedLineup.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = 'slot-item';
      row.innerHTML = `
        <span><strong>${p.role === 'GK' ? 'GK' : p.pos}</strong> • ${p.name}</span>
        <div style="display:flex;align-items:center;gap:6px;">
          <input type="number" min="1" max="99" value="${p.number}" class="jersey-num-input" title="Nomor Punggung" />
          <button type="button" class="btn btn-danger btn-small" style="padding:2px 7px;">✕</button>
        </div>
      `;

      const numInput = row.querySelector('input');
      numInput?.addEventListener('change', (e) => {
        const raw = clamp(Math.round(Number(e.target.value) || 1), 1, 99);
        this.selectedLineup[idx].number = raw;
        this.selectedLineup = resolveDuplicateNumbers(this.selectedLineup);
        this._renderLineupSlots();
      });

      const removeBtn = row.querySelector('button');
      removeBtn?.addEventListener('click', () => {
        if (this.localSquadLocked) return;
        this.selectedLineup.splice(idx, 1);
        this._renderSquadUI();
      });

      container.appendChild(row);
    });

    const outCount = this.selectedLineup.filter((p) => p.role === 'OUTFIELD').length;
    const gkCount = this.selectedLineup.filter((p) => p.role === 'GK').length;
    if (valMsg) {
      if (outCount === 4 && gkCount === 1) {
        valMsg.textContent = 'Skuad valid (4 Outfield + 1 GK). Nomor punggung unik terverifikasi.';
        valMsg.style.color = '#00e676';
      } else {
        valMsg.textContent = `Butuh tepat 4 Outfield & 1 GK (Saat ini: ${outCount} Outfield, ${gkCount} GK).`;
        valMsg.style.color = '#ffd54f';
      }
    }
  }

  _renderPlayerPool() {
    const grid = document.getElementById('player-pool-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const selectedIds = new Set(this.selectedLineup.map((p) => p.id));
    const filtered = this.roster.filter((p) => {
      if (this.poolFilter === 'OUTFIELD') return p.role === 'OUTFIELD';
      if (this.poolFilter === 'GK') return p.role === 'GK';
      return true;
    });

    filtered.forEach((p) => {
      const isSelected = selectedIds.has(p.id);
      const ovr = computeOverall(p);
      const card = document.createElement('div');
      card.className = `player-card ${isSelected ? 'selected' : ''}`;
      card.innerHTML = `
        <div class="pcard-top">
          <span class="pcard-pos">${p.role === 'GK' ? 'GK' : p.pos}</span>
          <span class="pcard-ovr">OVR ${ovr}</span>
        </div>
        <div class="pcard-name">#${p.number} ${p.name}</div>
        <div class="pcard-stats">
          <span>SPD ${p.speed}</span>
          <span>SHT ${p.shoot}</span>
          <span>PAS ${p.pass}</span>
          <span>DRB ${p.dribble}</span>
          <span>DEF ${p.defense}</span>
          <span>GKH ${p.gkHandling}</span>
        </div>
      `;

      card.addEventListener('click', () => {
        if (this.localSquadLocked) return;
        const existIdx = this.selectedLineup.findIndex((item) => item.id === p.id);
        if (existIdx >= 0) {
          this.selectedLineup.splice(existIdx, 1);
        } else {
          const outCount = this.selectedLineup.filter((item) => item.role === 'OUTFIELD').length;
          const gkCount = this.selectedLineup.filter((item) => item.role === 'GK').length;
          if (p.role === 'GK' && gkCount >= 1) {
            // Replace existing GK smoothly
            const oldGkIdx = this.selectedLineup.findIndex((item) => item.role === 'GK');
            if (oldGkIdx >= 0) this.selectedLineup.splice(oldGkIdx, 1);
          } else if (p.role === 'OUTFIELD' && outCount >= 4) {
            return;
          }
          this.selectedLineup.push(deepClone(p));
        }
        this._renderSquadUI();
      });

      grid.appendChild(card);
    });
  }

  _buildLocalTeamConfig() {
    const team = OFFICIAL_TEAMS.find((t) => t.id === this.selectedTeamId) || OFFICIAL_TEAMS[0];
    const validLineup = this._isLineupValid()
      ? resolveDuplicateNumbers(this.selectedLineup)
      : buildDefaultLineup(this.roster);

    return {
      id: team.id,
      name: team.name,
      abbr: team.abbr,
      primaryColor: this.primaryColor,
      accentColor: this.accentColor,
      lineup: validLineup,
    };
  }

  _buildFallbackRemoteConfig() {
    const oppTeam = OFFICIAL_TEAMS.find((t) => t.id !== this.selectedTeamId) || OFFICIAL_TEAMS[1];
    return {
      id: oppTeam.id,
      name: oppTeam.name,
      abbr: oppTeam.abbr,
      primaryColor: oppTeam.primaryColor,
      accentColor: oppTeam.accentColor,
      lineup: buildDefaultLineup(this.roster),
    };
  }

  _confirmLocalSquad(forceAuto = false) {
    if (!forceAuto && !this._isLineupValid()) {
      document.getElementById('squad-validation-msg').textContent =
        'Pilih tepat 4 pemain Outfield dan 1 Goalkeeper terlebih dahulu!';
      return;
    }

    const localConfig = this._buildLocalTeamConfig();

    if (this.mode === 'AI') {
      const aiBase = OFFICIAL_TEAMS.find((t) => t.id === this.aiTeamId) || OFFICIAL_TEAMS[1];
      const aiColor =
        aiBase.primaryColor.toLowerCase() === localConfig.primaryColor.toLowerCase()
          ? '#ff5252'
          : aiBase.primaryColor;

      const awayConfig = {
        id: aiBase.id,
        name: aiBase.name,
        abbr: aiBase.abbr,
        primaryColor: aiColor,
        accentColor: aiBase.accentColor,
        lineup: buildDefaultLineup(this.roster),
      };

      this._launchMatch(localConfig, awayConfig, this.durationMinutes);
      return;
    }

    // ONLINE MULTIPLAYER
    this.localSquadLocked = true;
    const btn = document.getElementById('btn-confirm-squad');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'SKUAD TERKUNCI ✓';
    }
    document.getElementById('opponent-ready-status').textContent =
      'Skuad Anda terkunci! Menunggu konfirmasi lawan...';

    this.network.send({
      type: 'SQUAD_LOCK',
      config: localConfig,
      durationMinutes: this.durationMinutes,
    });

    if (this.localSide === 'HOME') {
      this._tryLaunchOnlineMatch();
    }
  }

  _tryLaunchOnlineMatch() {
    if (this.localSide !== 'HOME') return;
    if (!this.localSquadLocked || !this.remoteSquadConfig) return;

    this._stopOnlineCountdown();
    const homeConfig = this._buildLocalTeamConfig();
    const awayConfig = this.remoteSquadConfig;

    // Ensure distinct jersey colors if identical
    if (homeConfig.primaryColor.toLowerCase() === awayConfig.primaryColor.toLowerCase()) {
      awayConfig.primaryColor = '#ff5252';
    }

    this.network.send({
      type: 'START_MATCH',
      homeConfig,
      awayConfig,
      durationMinutes: this.durationMinutes,
    });

    this._launchMatch(homeConfig, awayConfig, this.durationMinutes);
  }

  _launchMatch(homeConfig, awayConfig, durationMinutes) {
    this._stopOnlineCountdown();

    document.getElementById('hud-home-abbr').textContent = homeConfig.abbr;
    document.getElementById('hud-home-swatch').style.background = homeConfig.primaryColor;
    document.getElementById('hud-away-abbr').textContent = awayConfig.abbr;
    document.getElementById('hud-away-swatch').style.background = awayConfig.primaryColor;

    const netBadge = document.getElementById('hud-net-badge');
    if (netBadge) {
      netBadge.classList.toggle('hidden', this.mode !== 'ONLINE');
      netBadge.textContent = `ONLINE • ${this.localSide}`;
      netBadge.className = 'status-pill status-connected';
    }

    this._showScreen('screen-game');
    this.engine.startMatch({
      mode: this.mode,
      localSide: this.localSide,
      durationMinutes,
      homeConfig,
      awayConfig,
    });
  }

  // ==================== NETWORK EVENT HANDLERS ====================
  _bindNetworkEvents() {
    this.network.onStatusChange = (status, message, code, diagnostics) => {
      const pill = document.getElementById('net-status-pill');
      const msgEl = document.getElementById('lobby-message');
      const codeEl = document.getElementById('host-room-code');
      const copyBtn = document.getElementById('btn-copy-code');
      const retryBtn = document.getElementById('btn-lobby-retry');

      if (pill) {
        pill.textContent = status;
        pill.className = `status-pill status-${status.toLowerCase()}`;
      }
      if (msgEl) {
        const diagnosticText = status === 'FAILED' && diagnostics
          ? `\nICE: ${diagnostics.iceConnectionState || 'unknown'} • Data: ${diagnostics.dataChannel || 'unknown'}`
          : '';
        msgEl.textContent = `${message || ''}${diagnosticText}`;
      }
      if (codeEl && code) codeEl.textContent = code;
      if (copyBtn) copyBtn.disabled = !code || status === 'IDLE';
      if (retryBtn) retryBtn.classList.toggle('hidden', status !== 'FAILED');

      // Update in-game badge if disconnected mid-match
      const hudBadge = document.getElementById('hud-net-badge');
      if (hudBadge && this.mode === 'ONLINE' && status === 'FAILED') {
        hudBadge.textContent = 'DISCONNECTED';
        hudBadge.className = 'status-pill status-failed';
      }
    };

    // Smoothly transition from lobby to squad customization once data channel opens
    this.network.onConnectedReady = (role) => {
      this.mode = 'ONLINE';
      this.localSide = role === 'HOST' ? 'HOME' : 'AWAY';
      setTimeout(() => {
        this._openSquadScreen();
      }, 350);
    };

    this.network.onData = (packet) => {
      switch (packet.type) {
        case 'SQUAD_LOCK':
          this.remoteSquadConfig = packet.config;
          document.getElementById('opponent-ready-status').textContent =
            'Lawan sudah mengunci skuad!';
          if (this.localSide === 'HOME') {
            this._tryLaunchOnlineMatch();
          }
          break;

        case 'START_MATCH':
          if (this.localSide === 'AWAY' && packet.homeConfig && packet.awayConfig) {
            this._launchMatch(packet.homeConfig, packet.awayConfig, packet.durationMinutes || 4);
          }
          break;

        case 'INPUT':
          if (this.localSide === 'HOME' && packet.input) {
            this.engine.remoteInput = packet.input;
          }
          break;

        case 'STATE':
          if (this.localSide === 'AWAY' && packet.snapshot) {
            this.engine.applyNetworkSnapshot(packet.snapshot);
          }
          break;

        case 'PENALTY_CHOICE':
          if (this.localSide === 'HOME') {
            this.engine.submitPenaltyChoice('AWAY', packet.dir);
          }
          break;

        case 'SUIT_PICK':
          if (this.localSide === 'HOME') {
            this.engine.receiveRemoteSuitPick(packet.pick);
          }
          break;

        case 'SUIT_ROLE':
          if (this.localSide === 'HOME') {
            this.engine.submitSuitRole(packet.role);
          }
          break;

        case 'PAUSE_REQUEST':
          if (this.mode === 'ONLINE' && this.localSide === 'HOME') {
            this.engine.togglePause(Boolean(packet.paused));
          }
          break;

        case 'PAUSE_STATE':
          if (this.mode === 'ONLINE' && this.localSide === 'AWAY') {
            this.engine.togglePause(Boolean(packet.paused));
          }
          break;

        default:
          break;
      }
    };
  }

  // ==================== ENGINE CALLBACKS ====================
  _createEngineCallbacks() {
    return {
      onHudUpdate: ({ homeScore, awayScore, periodLabel, clockText, activePlayer, chargeRatio, curveActive }) => {
        document.getElementById('hud-home-score').textContent = String(homeScore);
        document.getElementById('hud-away-score').textContent = String(awayScore);
        document.getElementById('hud-period').textContent = periodLabel;
        document.getElementById('hud-clock').textContent = clockText;

        if (activePlayer) {
          document.getElementById('hud-player-pos').textContent =
            activePlayer.role === 'GK' ? 'GK' : activePlayer.pos.slice(0, 3).toUpperCase();
          document.getElementById('hud-player-name').textContent =
            `#${activePlayer.number} ${activePlayer.name.toUpperCase()}`;
          document.getElementById('hud-stamina-fill').style.width = `${clamp(activePlayer.stamina, 0, 100)}%`;
        }

        document.getElementById('hud-power-fill').style.width = `${Math.round(chargeRatio * 100)}%`;
        const curveEl = document.getElementById('hud-curve-indicator');
        if (curveEl) {
          curveEl.textContent = curveActive ? 'CURVE: ON' : 'CURVE: OFF';
          curveEl.classList.toggle('active', curveActive);
        }
      },

      onBanner: (sub, title, visible) => {
        const banner = document.getElementById('event-banner');
        if (!banner) return;
        banner.classList.toggle('hidden', !visible);
        if (visible) {
          document.getElementById('event-banner-sub').textContent = sub;
          document.getElementById('event-banner-title').textContent = title;
        }
      },

      onPauseChange: (paused, eng) => {
        if (this.mode === 'ONLINE' && this.localSide === 'HOME') {
          this.network.send({ type: 'PAUSE_STATE', paused: Boolean(paused) });
        }
        const overlay = document.getElementById('overlay-pause');
        if (!overlay) return;
        overlay.classList.toggle('hidden', !paused);
        document.getElementById('pause-title').textContent = 'PERTANDINGAN DIJEDA';
        document.getElementById('pause-summary').textContent =
          `${eng.homeTeam.abbr} ${eng.score.HOME} - ${eng.score.AWAY} ${eng.awayTeam.abbr}`;
        document.getElementById('btn-resume-game')?.classList.remove('hidden');
      },

      onPenaltyUpdate: (st, eng) => {
        const overlay = document.getElementById('overlay-penalty');
        if (!overlay) return;
        overlay.classList.remove('hidden');

        document.getElementById('pen-mode-tag').textContent = st.isGoldenBall
          ? 'GOLDEN BALL DECISIVE KICK'
          : `ADU PENALTI • RONDE ${st.round}/${st.maxRounds}`;

        const turnName = st.turnTeam === 'HOME' ? eng.homeTeam.name : eng.awayTeam.name;
        document.getElementById('pen-title').textContent = `PENENDANG: ${turnName}`;
        document.getElementById('pen-scoreboard').textContent =
          `${eng.homeTeam.abbr}: ${st.homeGoals} | ${eng.awayTeam.abbr}: ${st.awayGoals}`;

        const isMyTurn = st.turnTeam === this.localSide;
        document.getElementById('pen-instruction').textContent = isMyTurn
          ? 'Pilih sudut tendangan Anda sekarang!'
          : 'Menunggu lawan melakukan tendangan...';

        document.querySelectorAll('.pen-zone').forEach((b) => {
          b.disabled = !isMyTurn;
        });
      },

      onPenaltyClose: () => {
        document.getElementById('overlay-penalty')?.classList.add('hidden');
      },

      onSuitUpdate: (st) => {
        const overlay = document.getElementById('overlay-suit');
        if (!overlay) return;
        overlay.classList.remove('hidden');
        document.getElementById('suit-status-text').textContent = st.statusText;

        const hasWinner = Boolean(st.winner);
        document.getElementById('suit-choices')?.classList.toggle('hidden', hasWinner);

        const roleRow = document.getElementById('suit-role-choices');
        if (roleRow) {
          const canPickRole = hasWinner && st.winner === this.localSide;
          roleRow.classList.toggle('hidden', !canPickRole);
        }
      },

      onSuitClose: () => {
        document.getElementById('overlay-suit')?.classList.add('hidden');
      },

      onMatchEnd: (winnerHeadline, score, homeTeam, awayTeam) => {
        const overlay = document.getElementById('overlay-pause');
        if (!overlay) return;
        overlay.classList.remove('hidden');
        document.getElementById('pause-title').textContent = `FULL TIME — ${winnerHeadline}`;
        document.getElementById('pause-summary').textContent =
          `Skor Akhir: ${homeTeam.name} ${score.HOME} - ${score.AWAY} ${awayTeam.name}`;
        document.getElementById('btn-resume-game')?.classList.add('hidden');
      },
    };
  }

  // ==================== ADMIN ATTRIBUTE EDITOR ====================
  _initAdminModal() {
    const modal = document.getElementById('modal-admin');
    const authView = document.getElementById('admin-auth-view');
    const editorView = document.getElementById('admin-editor-view');
    const passInput = document.getElementById('input-admin-pass');
    const errEl = document.getElementById('admin-auth-error');
    const selPlayer = document.getElementById('admin-select-player');
    const slidersBox = document.getElementById('admin-sliders');
    const saveMsg = document.getElementById('admin-save-msg');

    const renderAdminPlayerEditor = (playerId) => {
      const player = this.roster.find((p) => p.id === playerId) || this.roster[0];
      if (!player || !slidersBox) return;
      slidersBox.innerHTML = '';

      const attrs = [
        { key: 'speed', label: 'Speed' },
        { key: 'shoot', label: 'Shoot' },
        { key: 'pass', label: 'Pass' },
        { key: 'dribble', label: 'Dribble' },
        { key: 'defense', label: 'Defense' },
        { key: 'gkHandling', label: 'GK Handling' },
      ];

      attrs.forEach(({ key, label }) => {
        const row = document.createElement('div');
        row.className = 'slider-row';
        row.innerHTML = `
          <span>${label}</span>
          <input type="range" min="1" max="99" value="${player[key]}" data-attr="${key}" />
          <strong>${player[key]}</strong>
        `;
        const range = row.querySelector('input');
        const valLabel = row.querySelector('strong');
        range?.addEventListener('input', (e) => {
          const v = clamp(Number(e.target.value) || 50, 1, 99);
          player[key] = v;
          if (valLabel) valLabel.textContent = String(v);
        });
        slidersBox.appendChild(row);
      });
    };

    const populateAdminPlayers = () => {
      if (!selPlayer) return;
      selPlayer.innerHTML = '';
      this.roster.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `#${p.number} ${p.name} (${p.role === 'GK' ? 'GK' : p.pos})`;
        selPlayer.appendChild(opt);
      });
      renderAdminPlayerEditor(this.roster[0].id);
    };

    document.getElementById('btn-open-admin')?.addEventListener('click', () => {
      modal?.classList.remove('hidden');
      if (passInput) passInput.value = '';
      if (errEl) errEl.textContent = '';
      if (saveMsg) saveMsg.textContent = '';
    });

    document.getElementById('btn-close-admin')?.addEventListener('click', () => {
      modal?.classList.add('hidden');
    });

    document.getElementById('btn-admin-login')?.addEventListener('click', () => {
      if (passInput?.value === ADMIN_PASSWORD) {
        authView?.classList.add('hidden');
        editorView?.classList.remove('hidden');
        populateAdminPlayers();
      } else if (errEl) {
        errEl.textContent = 'Password Admin salah!';
      }
    });

    selPlayer?.addEventListener('change', (e) => {
      renderAdminPlayerEditor(e.target.value);
    });

    document.getElementById('btn-admin-save')?.addEventListener('click', () => {
      saveRosterDatabase(this.roster);
      // Sync updated attributes into currently selected lineup
      this.selectedLineup = this.selectedLineup.map((sel) => {
        const updated = this.roster.find((r) => r.id === sel.id);
        return updated ? { ...updated, number: sel.number } : sel;
      });
      if (saveMsg) saveMsg.textContent = 'Atribut berhasil disimpan!';
    });

    document.getElementById('btn-admin-reset')?.addEventListener('click', () => {
      this.roster = resetRosterDatabase();
      populateAdminPlayers();
      if (saveMsg) saveMsg.textContent = 'Seluruh atribut di-reset ke default.';
    });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.__efutsalApp = new FutsalApp();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Service worker registration skipped:', err?.message || err);
    });
  }
});
