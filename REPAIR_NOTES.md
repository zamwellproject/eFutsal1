# eFutsal patch notes and validation limits


## Changes made

1. Removed the explicit STUN-only ICE config from PeerJS constructor options. PeerJS default ICE config is allowed to apply, including its default relay entries. This avoids overriding default TURN entries with a STUN-only list.
2. Added longer connection timeout and host signaling timeout, clearer errors, diagnostics, ICE disconnect grace period, and retry behavior.
3. Lobby retry button now retries as Host (new room) or Guest (same code) instead of only clearing status.
4. Copy-room-code action now has a clipboard fallback and manual-code message.
5. Multiplayer state now includes restart marker, penalty/suit state, player facing/velocity/stun data; Guest phase callbacks display penalty, suit, and full-time overlays.
6. Pause requests from Guest are routed to Host and pause/resume state is broadcast back.
7. Host sends final state immediately at full-time, because paused host simulation no longer emits periodic snapshots.
8. Added viewport fallback, safe-area control placement, small-screen/landscape CSS adjustments, accessibility zoom permission, PWA manifest, icons, and service worker.


## Validation performed

- JavaScript syntax check with Node.js `--check` for all source modules.
- Static check that literal `getElementById()` references match IDs in the HTML.
- ZIP structure checked after packaging.


## Not validated

- Real two-device WebRTC connectivity on Wi-Fi/mobile networks.
- Browser visual and touch testing on iOS Safari, Android Chrome, desktop Chrome/Edge/Firefox.
- Relay availability/quality, firewall restrictions, and latency under real match conditions.
- TURN credentials/provider setup for a production deployment.


## Production networking recommendation

Use a TURN provider/server and short-lived credentials returned by a backend endpoint. Never publish long-lived TURN secrets in client JavaScript. Public PeerJS relay is best-effort only.
