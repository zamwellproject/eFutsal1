// ============================================================================
// network.js — PeerJS multiplayer manager with default ICE/TURN config,
// explicit diagnostics, safer timeouts, and cleanup.
// NOTE: PeerJS's default ICE configuration is intentionally used here. Passing a
// custom STUN-only config would replace that default and remove its TURN entries.
// For production, replace the public default relay with provider-issued,
// short-lived TURN credentials from a backend endpoint.
// ============================================================================
import { generateRoomCode } from './utils.js';


const PEER_OPTIONS = {
  debug: 1,
  pingInterval: 5000,
};
const CONNECT_TIMEOUT_MS = 30000;
const ICE_DISCONNECT_GRACE_MS = 9000;


export class NetworkManager {
  constructor() {
    this.peer = null;
    this.conn = null;
    this.role = null;
    this.status = 'IDLE';
    this.roomCode = '';
    this.connectTimer = null;
    this.hostOpenTimer = null;
    this.iceGraceTimer = null;
    this.onStatusChange = null;
    this.onData = null;
    this.onConnectedReady = null;
    this.lastDiagnostics = {};
  }


  _setStatus(status, message = '', diagnostics = null) {
    this.status = status;
    if (diagnostics && typeof diagnostics === 'object') this.lastDiagnostics = diagnostics;
    if (status === 'IDLE') this.lastDiagnostics = {};
    if (typeof this.onStatusChange === 'function') {
      try { this.onStatusChange(status, message, this.roomCode, this.lastDiagnostics); } catch {}
    }
  }


  _clearTimers() {
    for (const key of ['connectTimer', 'hostOpenTimer', 'iceGraceTimer']) {
      if (this[key]) clearTimeout(this[key]);
      this[key] = null;
    }
  }


  cleanup({ silent = false } = {}) {
    this._clearTimers();
    try { this.conn?.close(); } catch {}
    try { if (this.peer && !this.peer.destroyed) this.peer.destroy(); } catch {}
    this.conn = null;
    this.peer = null;
    this.role = null;
    this.roomCode = '';
    this.lastDiagnostics = {};
    if (!silent) this._setStatus('IDLE', 'Koneksi ditutup.');
  }


  _createPeer(id = undefined) {
    // Do not pass a custom `config.iceServers` here: that overrides PeerJS's
    // default ICE configuration (including its default TURN relay entries).
    return id ? new window.Peer(id, PEER_OPTIONS) : new window.Peer(PEER_OPTIONS);
  }


  createRoom() {
    this.cleanup();
    if (typeof window.Peer !== 'function') {
      this._setStatus('FAILED', 'PeerJS gagal dimuat. Periksa internet lalu refresh halaman.');
      return;
    }

    this.role = 'HOST';
    this.roomCode = generateRoomCode(6);
    const peerId = `efutsal26-${this.roomCode}`;
    this._setStatus('CONNECTING', `Mendaftarkan room ${this.roomCode} ke server...`);

    try { this.peer = this._createPeer(peerId); }
    catch (err) {
      this._setStatus('FAILED', `PeerJS tidak dapat dimulai: ${err?.message || 'error'}`);
      return;
    }

    this.hostOpenTimer = setTimeout(() => {
      if (this.status === 'CONNECTING') {
        this._setStatus('FAILED', 'Server signaling belum merespons. Periksa internet, VPN, DNS, atau coba lagi.');
      }
    }, CONNECT_TIMEOUT_MS);


    this.peer.on('open', () => {
      if (this.hostOpenTimer) { clearTimeout(this.hostOpenTimer); this.hostOpenTimer = null; }
      this._setStatus('CONNECTING', `Room ${this.roomCode} aktif. Bagikan kode dan tunggu lawan.`, { signaling: 'connected' });
    });


    this.peer.on('connection', (dataConn) => {
      if (this.conn && this.conn.open) {
        try { dataConn.close(); } catch {}
        return;
      }
      this._attachConnection(dataConn);
    });


    this.peer.on('error', (err) => {
      const type = err?.type || 'unknown';
      let msg = `Error signaling Host (${type}).`;
      if (type === 'unavailable-id') msg = 'Kode room bentrok. Buat room baru.';
      else if (type === 'server-error') msg = 'Server signaling bermasalah. Coba lagi beberapa saat.';
      else if (type === 'network') msg = 'Tidak dapat mencapai server signaling. Periksa koneksi internet/VPN.';
      this._setStatus('FAILED', msg, { signalingError: type, detail: err?.message || '' });
    });

  }


  joinRoom(rawCode) {
    this.cleanup();
    const code = String(rawCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6) {
      this._setStatus('FAILED', 'Kode room harus terdiri dari 6 karakter.');
      return;
    }
    if (typeof window.Peer !== 'function') {
      this._setStatus('FAILED', 'PeerJS gagal dimuat. Periksa internet lalu refresh halaman.');
      return;
    }

    this.role = 'GUEST';
    this.roomCode = code;
    this._setStatus('CONNECTING', `Menghubungkan ke room ${code}...`);
    try { this.peer = this._createPeer(); }
    catch (err) {
      this._setStatus('FAILED', `PeerJS tidak dapat dimulai: ${err?.message || 'error'}`);
      return;
    }

    this.connectTimer = setTimeout(() => {
      if (this.status !== 'CONNECTED') {
        this._setStatus('FAILED', 'Koneksi timeout (30 detik). Room mungkin salah/tutup, signaling terblokir, atau jalur ICE/NAT tidak berhasil.', this._getDiagnostics());
        try { this.conn?.close(); } catch {}
      }
    }, CONNECT_TIMEOUT_MS);


    this.peer.on('open', () => {
      try {
        const dataConn = this.peer.connect(`efutsal26-${code}`, { reliable: true });
        if (!dataConn) this._setStatus('FAILED', 'PeerJS tidak membuat koneksi data ke Host.');
        else this._attachConnection(dataConn);
      } catch (err) {
        this._setStatus('FAILED', `Gagal memulai koneksi ke Host: ${err?.message || 'error'}`);
      }
    });


    this.peer.on('error', (err) => {
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
      const type = err?.type || 'network-error';
      const msg = type === 'peer-unavailable'
        ? `Room ${code} tidak ditemukan atau Host belum aktif.`
        : type === 'network'
          ? 'Server signaling tidak dapat dijangkau. Periksa internet/VPN atau coba lagi.'
          : `Koneksi gagal pada signaling (${type}).`;
      this._setStatus('FAILED', msg, { signalingError: type, detail: err?.message || '' });
    });
  }


  _getDiagnostics() {
    const pc = this.conn?.peerConnection;
    return {
      signaling: this.peer ? (this.peer.disconnected ? 'disconnected' : 'connected') : 'none',
      dataChannel: this.conn?.open ? 'open' : 'closed',
      connectionState: pc?.connectionState || 'unknown',
      iceConnectionState: pc?.iceConnectionState || 'unknown',
      iceGatheringState: pc?.iceGatheringState || 'unknown',
    };
  }


  _attachConnection(dataConn) {
    this.conn = dataConn;
    dataConn.on('open', () => {
      this._clearTimers();
      this.lastDiagnostics = this._getDiagnostics();
      this._setStatus('CONNECTED', `Terhubung ke Room ${this.roomCode}.`, this.lastDiagnostics);
      if (typeof this.onConnectedReady === 'function') {
        try { this.onConnectedReady(this.role, this.roomCode); } catch {}
      }
      const pc = dataConn.peerConnection;
      if (pc) {
        const refresh = () => {
          this.lastDiagnostics = this._getDiagnostics();
          if (pc.iceConnectionState === 'disconnected') {
            if (!this.iceGraceTimer) {
              this.iceGraceTimer = setTimeout(() => {
                if (pc.iceConnectionState === 'disconnected') {
                  this._setStatus('FAILED', 'ICE terputus cukup lama. Coba pindah jaringan atau sambungkan ulang.', this._getDiagnostics());
                this.iceGraceTimer = null;
              }, ICE_DISCONNECT_GRACE_MS);
            }
          } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            if (this.iceGraceTimer) clearTimeout(this.iceGraceTimer);
            this.iceGraceTimer = null;
            this._setStatus('CONNECTED', 'Koneksi online stabil.', this.lastDiagnostics);
          } else if (pc.iceConnectionState === 'failed') {
            this._setStatus('FAILED', 'ICE gagal membangun jalur. NAT/firewall atau TURN mungkin diperlukan.', this.lastDiagnostics);
          }
        };
        pc.addEventListener?.('connectionstatechange', refresh);
        pc.addEventListener?.('iceconnectionstatechange', refresh);
        pc.addEventListener?.('icegatheringstatechange', refresh);
        refresh();
      }
    });

    dataConn.on('data', (payload) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
      if (typeof this.onData === 'function') {
        try { this.onData(payload); } catch {}
      }
    });

    dataConn.on('close', () => {
      this._clearTimers();
      this._setStatus('FAILED', 'Koneksi lawan terputus. Pertandingan online tidak lagi tersinkron.', this._getDiagnostics());
    });
    dataConn.on('error', (err) => {
      this._setStatus('FAILED', `Gangguan DataChannel: ${err?.type || err?.message || 'error'}`, this._getDiagnostics());
    });
  }


  send(payload) {
    if (!this.conn || !this.conn.open) return false;
    try {
      this.conn.send(payload);
      return true;
    } catch {
      return false;
    }
  }
}
