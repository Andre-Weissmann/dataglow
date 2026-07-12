// ============================================================
// DATAGLOW — Rooms: topbar UI layer (Batch 3 of 4)
// ============================================================
// WHAT THIS IS: the thin, DOM-mounting presentation layer that finally makes
// DataGlow Rooms VISIBLE to a human. Batch 1 (js/rooms/room-signaling.js) opened
// a Room (room codes + a peer-discovery/signaling contract + the WebRTC data
// channel); Batch 2 (js/rooms/room-broadcast.js) put Object Space entries and
// "who's viewing" tags on that channel. Both batches shipped as PURE, Node-
// testable data-layer modules with NO DOM. This batch surfaces exactly what
// those two already returned — it invents no new Room concept, no new signaling,
// no new broadcast payload, and it never moves a byte of anyone's data:
//   (a) a compact "Room pill" in the topbar showing the current room code when a
//       Room is joined, or a "Start a Room" affordance when not (and an honest
//       "Rooms unavailable" state when WebRTC isn't supported);
//   (b) small avatar/initials presence badges for the OTHER peers in the Room
//       (read straight off Batch 1's listPeers() + Batch 2's who's-viewing map);
//   (c) a live-update toast when a peer's Object Space entry arrives, reusing the
//       EXISTING toast() pattern (js/app-shell/utils.js) verbatim.
//
// WHAT IT DELIBERATELY DOES NOT DO: this batch ships dark behind the `roomsUi`
// flag (enabled:false); with the flag off nothing here mounts and the topbar /
// app shell is byte-for-byte unchanged. It builds NO new transport and holds NO
// Room lifecycle of its own — the caller (js/app-shell/main.js) owns the
// RoomSignalingCoordinator / RoomBroadcastCoordinator and hands this layer the
// already-computed state (room code, joined flag, peer list, viewing snapshot).
// Batch 4 (cross-language live resolution) is NOT built here.
//
// Identity split (same convention as glow-orb-ui.js / readiness-gate-ui.js /
// diplomacy-ui.js): the model builders (buildRoomPillModel / buildPresenceModel /
// buildRemoteEntryToast + the peerInitials/avatarColor helpers) are PURE, Node-
// testable functions with NO DOM; the renderer (renderRoomUi) turns those models
// into DOM and is thin enough to leave to the browser/e2e path. The flag itself
// is checked by the CALLER in main.js, never inside this module.

import { el } from '../app-shell/utils.js';

// A small, fixed avatar palette. These are the SAME accent hues the app already
// uses (coral primary + the trust-grade family) rather than a new color
// vocabulary; avatarColor() picks one deterministically from a peer's id/name so
// a given peer keeps the same color across renders without any stored state.
const AVATAR_PALETTE = ['#FF6B6B', '#2e7d32', '#1565c0', '#b8860b', '#6a1b9a', '#00838f'];

// Deterministic string -> palette index (a tiny, stable, dependency-free hash —
// NOT a security primitive, just a stable color pick). Never throws.
export function avatarColor(seed) {
  const s = seed == null ? '' : String(seed);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

// Up to two uppercase initials for a peer's avatar. Prefers the human display
// name (first letters of its first two words); falls back to the leading
// alphanumerics of the peer id; a nameless/idless peer yields '?'. Never throws.
export function peerInitials(peer) {
  const p = (peer && typeof peer === 'object') ? peer : {};
  const name = typeof p.displayName === 'string' ? p.displayName.trim() : '';
  if (name) {
    const words = name.split(/\s+/).filter(Boolean);
    // Multi-word: first letter of the first two words ("Ada Lovelace" -> "AL").
    // Single word: its first two letters ("Grace" -> "GR").
    const letters = words.length >= 2
      ? words.slice(0, 2).map(w => w[0]).join('')
      : words[0].slice(0, 2);
    if (letters) return letters.toUpperCase().slice(0, 2);
  }
  const id = p.id != null ? String(p.id) : '';
  const alnum = id.replace(/[^a-zA-Z0-9]/g, '');
  if (alnum) return alnum.slice(0, 2).toUpperCase();
  return '?';
}

/**
 * Pure view-model for the topbar Room pill. Reflects — never re-derives — the
 * Room state the caller already holds (a RoomSignalingCoordinator's roomCode /
 * joined, plus isRoomsSupported()). Never throws.
 * @param {{roomCode?:(string|null), joined?:boolean, supported?:boolean}} [input]
 * @returns {{
 *   state:'unsupported'|'idle'|'joined',
 *   label:string,
 *   roomCode:(string|null),
 *   actionKind:'start'|'leave'|'none',
 *   actionLabel:string,
 *   title:string
 * }}
 */
export function buildRoomPillModel(input = {}) {
  const i = (input && typeof input === 'object') ? input : {};
  const supported = i.supported !== false; // default: assume supported unless told otherwise
  if (!supported) {
    return {
      state: 'unsupported',
      label: 'Rooms unavailable',
      roomCode: null,
      actionKind: 'none',
      actionLabel: '',
      title: 'DataGlow Rooms needs WebRTC, which this browser does not support.',
    };
  }
  const joined = !!i.joined;
  const roomCode = joined && typeof i.roomCode === 'string' && i.roomCode ? i.roomCode : null;
  if (joined && roomCode) {
    return {
      state: 'joined',
      label: roomCode,
      roomCode,
      actionKind: 'leave',
      actionLabel: 'Leave',
      title: `In Room ${roomCode} — click the code to copy it, or Leave to disconnect.`,
    };
  }
  return {
    state: 'idle',
    label: 'Start a Room',
    roomCode: null,
    actionKind: 'start',
    actionLabel: 'Start a Room',
    title: 'Start a peer-to-peer Room so others can open this dataset live with you (zero upload).',
  };
}

/**
 * Pure view-model for the peer-presence badges. Composes Batch 1's peer list
 * with Batch 2's who's-viewing snapshot into one badge-per-peer array (never
 * self — listPeers() already excludes self). Never throws.
 * @param {{peers?:Array<object>, viewingSnapshot?:Object<string,string[]>}} [input]
 * @returns {{
 *   count:number,
 *   summaryLabel:string,
 *   badges:Array<{id:string, initials:string, displayName:(string|null), role:(string|null), color:string, viewing:string[], title:string}>
 * }}
 */
export function buildPresenceModel(input = {}) {
  const i = (input && typeof input === 'object') ? input : {};
  const peers = Array.isArray(i.peers) ? i.peers : [];
  const snapshot = (i.viewingSnapshot && typeof i.viewingSnapshot === 'object') ? i.viewingSnapshot : {};

  const badges = peers
    .filter(p => p && p.id != null)
    .map((p) => {
      const id = String(p.id);
      const viewing = Object.keys(snapshot)
        .filter(name => Array.isArray(snapshot[name]) && snapshot[name].map(String).includes(id))
        .sort();
      const displayName = typeof p.displayName === 'string' && p.displayName.trim() ? p.displayName.trim() : null;
      const role = typeof p.role === 'string' && p.role.trim() ? p.role.trim() : null;
      const who = displayName || `Peer ${id}`;
      const roleSuffix = role ? ` (${role})` : '';
      const viewingSuffix = viewing.length ? ` — viewing ${viewing.join(', ')}` : '';
      return {
        id,
        initials: peerInitials(p),
        displayName,
        role,
        color: avatarColor(displayName || id),
        viewing,
        title: `${who}${roleSuffix}${viewingSuffix}`,
      };
    });

  const count = badges.length;
  const summaryLabel = count === 0
    ? 'No one else here yet'
    : (count === 1 ? '1 peer' : `${count} peers`);
  return { count, summaryLabel, badges };
}

/**
 * Pure toast descriptor for an incoming remote Object Space entry (Batch 2's
 * receive() -> onRemoteEntry). Resolves the sender's display name from the peer
 * list when available, else a short peer id. Returns null when there is nothing
 * meaningful to announce (no entry name) so the caller shows no toast. Never
 * throws — it PRESENTS the entry, it does not re-apply it.
 * @param {{entry?:object, from?:*, peers?:Array<object>}} [input]
 * @returns {{message:string, type:string}|null}
 */
export function buildRemoteEntryToast(input = {}) {
  const i = (input && typeof input === 'object') ? input : {};
  const entry = (i.entry && typeof i.entry === 'object') ? i.entry : null;
  const name = entry && entry.name != null && String(entry.name) ? String(entry.name) : '';
  if (!name) return null;
  const peers = Array.isArray(i.peers) ? i.peers : [];
  const fromId = i.from != null ? String(i.from) : '';
  const match = peers.find(p => p && p.id != null && String(p.id) === fromId);
  const who = (match && typeof match.displayName === 'string' && match.displayName.trim())
    ? match.displayName.trim()
    : (fromId ? `Peer ${fromId}` : 'A peer');
  const lang = entry.originLanguage != null ? String(entry.originLanguage).toUpperCase() : '';
  const langSuffix = lang ? ` (${lang})` : '';
  return { message: `${who} shared "${name}"${langSuffix}`, type: 'success' };
}

/**
 * Fire a live-update toast for a remote entry, reusing the app's existing toast
 * primitive. Thin composition of buildRemoteEntryToast + the injected toast fn
 * (defaults to a no-op so it is safe to call headless / in tests). Returns the
 * toast descriptor that was shown, or null if nothing was shown.
 * @param {{entry?:object, from?:*, peers?:Array<object>, toast?:Function}} [opts]
 */
export function notifyRemoteEntry(opts = {}) {
  const { toast = () => {} } = opts;
  const t = buildRemoteEntryToast(opts);
  if (t && typeof toast === 'function') {
    try { toast(t.message, t.type); } catch (e) { /* a toast failure must never break receive */ }
  }
  return t;
}

/**
 * Render the Room pill + presence badges into `host`. Thin: it draws the two
 * pure models and wires the injected click handlers; it holds no Room state of
 * its own (the caller owns the coordinators and re-invokes this with fresh
 * models). Purely informational/collaborative — it never blocks or alters
 * anything it sits beside in the topbar.
 * @param {object} opts
 * @param {HTMLElement} opts.host
 * @param {ReturnType<typeof buildRoomPillModel>} opts.pillModel
 * @param {ReturnType<typeof buildPresenceModel>} [opts.presenceModel]
 * @param {Function} [opts.onStart]  clicked "Start a Room"
 * @param {Function} [opts.onLeave]  clicked "Leave"
 * @param {Function} [opts.onCopy]   clicked the room code (to copy it)
 * @returns {{pillModel:object, presenceModel:object}|undefined}
 */
export function renderRoomUi(opts = {}) {
  const { host, pillModel, presenceModel, onStart, onLeave, onCopy } = opts;
  if (!host) return;
  const pill = pillModel || buildRoomPillModel();
  const presence = presenceModel || buildPresenceModel();
  host.innerHTML = '';

  // ---- the pill itself ----
  const pillChildren = [];

  // A small status dot: green when in a Room, muted otherwise.
  const dotColor = pill.state === 'joined' ? '#2e7d32' : (pill.state === 'unsupported' ? '#9e9e9e' : '#b8860b');
  pillChildren.push(el('span', {
    'data-testid': 'room-pill-dot',
    style: `width:8px; height:8px; border-radius:50%; background:${dotColor}; display:inline-block; flex:none;`,
  }));

  // The label. When joined it is the room code (clickable to copy); otherwise a
  // plain label / affordance.
  if (pill.state === 'joined') {
    const code = el('button', {
      type: 'button',
      'data-testid': 'room-pill-code',
      title: pill.title,
      style: 'cursor:pointer; border:none; background:none; padding:0; font-family:var(--font-mono,monospace); font-size:var(--text-sm,13px); font-weight:600; color:var(--color-text,#111); letter-spacing:0.03em;',
    }, pill.label);
    if (typeof onCopy === 'function') code.addEventListener('click', () => onCopy(pill.roomCode));
    pillChildren.push(code);
  } else {
    pillChildren.push(el('span', {
      'data-testid': 'room-pill-label',
      style: `font-size:var(--text-sm,13px); color:var(--color-text-muted,#666);${pill.state === 'unsupported' ? '' : ' font-weight:600;'}`,
    }, pill.label));
  }

  // The action button (Start / Leave), when there is one.
  if (pill.actionKind === 'start' || pill.actionKind === 'leave') {
    const action = el('button', {
      type: 'button',
      'data-testid': 'room-pill-action',
      'data-action': pill.actionKind,
      title: pill.title,
      style: `cursor:pointer; border:1px solid var(--color-border,#e2e2e2); background:${pill.actionKind === 'leave' ? 'transparent' : 'var(--color-primary,#FF6B6B)'}; color:${pill.actionKind === 'leave' ? 'var(--color-text-muted,#666)' : '#fff'}; border-radius:var(--radius-full,999px); padding:2px 10px; font-size:var(--text-xs,12px); font-weight:600;`,
    }, pill.actionLabel);
    const handler = pill.actionKind === 'start' ? onStart : onLeave;
    if (typeof handler === 'function') action.addEventListener('click', () => handler());
    pillChildren.push(action);
  }

  const pillEl = el('div', {
    'data-testid': 'room-pill',
    class: 'room-pill',
    'data-state': pill.state,
    style: 'display:inline-flex; align-items:center; gap:var(--space-2,8px); padding:4px 10px; border:1px solid var(--color-border,#e2e2e2); border-radius:var(--radius-full,999px); background:var(--color-surface,#fff);',
  }, pillChildren);

  // ---- presence badges (only when in a Room) ----
  const badgeEls = [];
  if (pill.state === 'joined') {
    for (const b of presence.badges) {
      badgeEls.push(el('span', {
        class: 'room-avatar',
        'data-testid': 'room-avatar',
        'data-peer-id': b.id,
        title: b.title,
        style: `width:26px; height:26px; border-radius:50%; background:${b.color}; color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:var(--text-xs,12px); font-weight:700; margin-left:-6px; border:2px solid var(--color-surface,#fff); box-shadow:0 0 0 1px var(--color-border,#e2e2e2);`,
      }, b.initials));
    }
  }

  const badgeRow = el('div', {
    'data-testid': 'room-presence',
    class: 'room-presence',
    title: pill.state === 'joined' ? presence.summaryLabel : '',
    style: 'display:inline-flex; align-items:center; padding-left:8px;',
  }, badgeEls);

  const wrap = el('div', {
    'data-testid': 'room-ui-wrap',
    class: 'room-ui-wrap',
    style: 'display:inline-flex; align-items:center; gap:var(--space-2,8px);',
  }, [pillEl, badgeRow]);
  host.appendChild(wrap);
  return { pillModel: pill, presenceModel: presence };
}
