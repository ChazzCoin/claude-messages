// Shared session-row component for away + summon (and any future per-chat
// session mode that surfaces here). The two modes had nearly-identical
// rendering — pulsing dot, contact name, meta line, dismiss button — with
// only cosmetic differences in labels, action names, and CSS classes.
//
// Pass `kind` to switch between modes:
//   'away'   — covering for the user. Status from the row, "greeting sent"
//              label massage, "End session" button.
//   'summon' — Galt joined the conversation. "summoned" status tag,
//              "Dismiss Galt" button.
//
// Pass `compact: true` for the one-liner layout used inside collapsed past-
// session lists.

import { escapeHtml, relTime } from '../utils.js';

const MODES = {
  away: {
    isActive: (s) => s.status !== 'ended',
    statusLabel: (s) => s.status === 'greeting_sent' ? 'greeting sent' : s.status,
    statusTagClass: (s) => s.status,
    startedVerb: 'started',
    dataAttr: 'session-id',
    dismissAction: 'end-away-session',
    dismissLabel: 'End session',
  },
  summon: {
    isActive: (s) => s.status === 'active',
    statusLabel: () => 'summoned',
    statusTagClass: () => 'replying',
    startedVerb: 'summoned',
    dataAttr: 'summon-id',
    dismissAction: 'end-summon-session',
    dismissLabel: 'Dismiss Galt',
  },
};

/**
 * Renders one session — either as a full active-session card (with pulsing
 * dot + dismiss button) or a compact one-line row for past sessions.
 */
export function renderSessionCard(session, opts) {
  const mode = MODES[opts.kind];
  if (!mode) throw new Error(`unknown session kind: ${opts.kind}`);
  const compact = !!opts.compact;
  const s = session;

  const name = s.contact_name || s.handle;
  const active = mode.isActive(s);
  const replyText = `${s.ai_reply_count} ${s.ai_reply_count === 1 ? 'reply' : 'replies'}`;
  const endedReason = s.ended_reason ? `ended: ${s.ended_reason}` : '';

  if (compact) {
    return `
      <div class="away-row ${active ? 'active' : 'ended'}" data-${mode.dataAttr}="${s.id}">
        <span class="away-row-dot"></span>
        <span class="away-row-name">${escapeHtml(name)}</span>
        <span class="away-row-meta">${escapeHtml(replyText)}${endedReason ? ' · ' + escapeHtml(endedReason) : ''}</span>
        <span class="away-row-time">${escapeHtml(relTime(s.started_at))}</span>
      </div>
    `;
  }

  const statusLabel = mode.statusLabel(s);
  const statusTagClass = mode.statusTagClass(s);
  const lastReply = s.last_ai_reply_at ? `last ${relTime(s.last_ai_reply_at)}` : '';

  return `
    <div class="away-session-card active" data-${mode.dataAttr}="${s.id}">
      <div class="session-pulse"></div>
      <div class="session-card-body">
        <div class="session-card-name">${escapeHtml(name)}</div>
        <div class="session-card-meta">${escapeHtml(s.handle)} · ${mode.startedVerb} ${escapeHtml(relTime(s.started_at))}</div>
        <div class="session-card-stats">
          <span class="status-tag ${escapeHtml(statusTagClass)}">${escapeHtml(statusLabel)}</span>
          <span>${escapeHtml(replyText)}</span>
          ${lastReply ? `<span>${escapeHtml(lastReply)}</span>` : ''}
        </div>
      </div>
      <button class="btn ghost" data-action="${mode.dismissAction}" data-id="${s.id}">${mode.dismissLabel}</button>
    </div>
  `;
}
