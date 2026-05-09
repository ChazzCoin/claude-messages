// Thread view — chat foundation + AI workbench panel deck on the right.
//
// Layout shape:
//   ┌───────────────┬─────────────────────────────────┬────────────────┐
//   │   sidebar     │   thread header + messages      │   WORKBENCH    │
//   │               │   ────────────────────────────  │   ┌──────────┐ │
//   │               │   [bubble]    [bubble]          │   │ Identity │ │
//   │               │   [bubble]                      │   ├──────────┤ │
//   │               │   ▲ scroll                      │   │ Profile  │ │
//   │               │                                 │   ├──────────┤ │
//   │               │   ────────────────────────────  │   │ Notes    │ │
//   │               │   compose bar (sticky)          │   ├──────────┤ │
//   │               │                                 │   │ Radar*   │ │
//   │               │                                 │   ├──────────┤ │
//   │               │                                 │   │ Tools    │ │
//   │               │                                 │   └──────────┘ │
//   └───────────────┴─────────────────────────────────┴────────────────┘
//      *Radar only renders when the contact is on radar.
//
// Each workbench card is a glass-morphism <details> that expands inline.
// Identity stays expanded as the always-on context strip; Notes default-
// expanded because edits happen often; Profile / Radar / Tools default-
// collapsed (one click to engage).
//
// Manual AI draft + temperament selector + variants UI are gone. Direct
// send only on the compose bar; AI generation is mode-driven (away/summon).

import { api } from '../api.js';
import { setMainHeader } from '../shell.js';
import { escapeHtml, initials, avatarClass, relTime, fmtBytes } from '../utils.js';
import {
  chatsCache, radarHandlesCache,
} from '../state.js';
import { renderProfileBlock, renderNotesBlock } from './inbox.js';
import { openInspector } from '../components/modal.js';

/* ─── message inspector — clicking any bubble opens this ────────── */

// Apple's expressive_send_style_id is a bundle identifier; map the
// well-known ones to a human label. Anything we don't recognize falls
// through with the raw id displayed as-is.
const EXPRESSIVE_LABELS = {
  'com.apple.MobileSMS.expressivesend.gentle':       'Gentle',
  'com.apple.MobileSMS.expressivesend.impact':       'Slam',
  'com.apple.MobileSMS.expressivesend.invisibleink': 'Invisible Ink',
  'com.apple.MobileSMS.expressivesend.loud':         'Loud',
  'com.apple.MobileSMS.expressivesend.echo':         'Echo',
  'com.apple.messages.effect.CKConfettiEffect':      'Confetti screen',
  'com.apple.messages.effect.CKHeartEffect':         'Heart screen',
  'com.apple.messages.effect.CKLasersEffect':        'Lasers screen',
  'com.apple.messages.effect.CKFireworksEffect':     'Fireworks screen',
  'com.apple.messages.effect.CKShootingStarEffect':  'Shooting Star',
  'com.apple.messages.effect.CKSparklesEffect':      'Sparkles',
  'com.apple.messages.effect.CKSpotlightEffect':     'Spotlight',
};

// chat.db's message.group_action_type — system-message variants for
// group-membership changes. 0/null = normal user message.
const GROUP_ACTION_LABELS = {
  0: 'normal message',
  1: 'participant added',
  2: 'participant removed',
  3: 'group renamed',
  5: 'group photo changed',
};

// Friendly labels for some commonly-seen balloon_bundle_id values
// (iMessage Apps payload identifiers). The full ID is shown beneath.
function balloonLabel(id) {
  if (!id) return null;
  if (id.includes('PassbookUIService.PeerPaymentMessages')) return 'Apple Cash / Apple Pay';
  if (id.includes('Stickers.UserGenerated'))                return 'User-generated sticker';
  if (id.includes('URLBalloonProvider'))                    return 'Rich link preview';
  if (id.includes('audioMessage'))                          return 'Audio message';
  if (id.includes('Handwriting'))                           return 'Handwritten note';
  if (id.includes('DigitalTouchBalloonProvider'))           return 'Digital Touch';
  if (id.includes('Polls'))                                 return 'Poll';
  if (id.includes('MSMessageExtensionBalloonPlugin'))       return 'iMessage app';
  return null;
}

function fmtAbs(ms) {
  if (!ms) return null;
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
  });
}

function inspRow(label, value, opts = {}) {
  if (value == null || value === '' || value === '—') {
    return `<div class="insp-row muted"><span class="insp-key">${escapeHtml(label)}</span><span class="insp-val">—</span></div>`;
  }
  const cls = opts.mono ? 'insp-val mono' : 'insp-val';
  const sub = opts.sub ? `<div class="insp-sub">${escapeHtml(opts.sub)}</div>` : '';
  return `
    <div class="insp-row">
      <span class="insp-key">${escapeHtml(label)}</span>
      <span class="${cls}">${escapeHtml(String(value))}${sub}</span>
    </div>
  `;
}

function inspTsRow(label, ms) {
  if (!ms) return inspRow(label, null);
  return `
    <div class="insp-row">
      <span class="insp-key">${escapeHtml(label)}</span>
      <span class="insp-val">
        ${escapeHtml(fmtAbs(ms))}
        <div class="insp-sub">${escapeHtml(relTime(ms))} · <span class="mono">${ms}</span></div>
      </span>
    </div>
  `;
}

// Drop a section if every row resolved to muted "—" — keeps the
// inspector tight on plain messages.
function inspSection(title, rows) {
  const nonEmpty = rows.filter((r) => r && !r.includes('insp-row muted'));
  if (nonEmpty.length === 0) return '';
  return `
    <div class="insp-section">
      <div class="insp-section-title">${escapeHtml(title)}</div>
      ${rows.join('')}
    </div>
  `;
}

function renderInspectorBody(m) {
  const senderName = m.is_from_me === 1
    ? 'You'
    : (m.contact_name || m.handle || '(unknown)');

  const expressive = m.expressive_send_style_id
    ? (EXPRESSIVE_LABELS[m.expressive_send_style_id] || m.expressive_send_style_id)
    : null;
  const expressiveSub = m.expressive_send_style_id && EXPRESSIVE_LABELS[m.expressive_send_style_id]
    ? m.expressive_send_style_id
    : null;

  const balloon = balloonLabel(m.balloon_bundle_id);
  const balloonSub = balloon && m.balloon_bundle_id ? m.balloon_bundle_id : null;

  const groupAction = m.group_action_type != null
    ? (GROUP_ACTION_LABELS[m.group_action_type] || `unknown (${m.group_action_type})`)
    : null;

  const reactionsBlock = m.reactions && m.reactions.length
    ? m.reactions.map((r) => {
        const who = r.is_from_me ? 'You' : (r.sender_contact_name || r.sender_handle || '?');
        return `<div class="insp-reaction"><span class="insp-emoji">${escapeHtml(r.emoji)}</span> ${escapeHtml(r.type_name)} from <strong>${escapeHtml(who)}</strong></div>`;
      }).join('')
    : null;

  const attBlock = m.attachments && m.attachments.length
    ? m.attachments.map((a) => {
        const name = a.transfer_name || a.filename?.split('/').pop() || 'file';
        const size = fmtBytes(a.total_bytes);
        const mime = a.mime_type || '?';
        return `<div class="insp-att"><span class="mono">${escapeHtml(name)}</span> · ${escapeHtml(mime)}${size ? ' · ' + escapeHtml(size) : ''}</div>`;
      }).join('')
    : null;

  return `
    <div class="insp-body">

      ${inspSection('Identity', [
        inspRow('Sender', senderName, { sub: m.handle || undefined }),
        inspRow('Direction', m.is_from_me === 1 ? 'outgoing' : 'incoming'),
        inspRow('GUID', m.guid, { mono: true }),
        inspRow('ROWID', String(m.id), { mono: true }),
      ])}

      ${inspSection('Timing', [
        inspTsRow('Sent', m.date_ms),
        inspTsRow('Delivered', m.date_delivered_ms),
        inspTsRow('Read', m.date_read_ms),
      ])}

      ${inspSection('Edit history', [
        inspTsRow('Edited', m.date_edited_ms),
        inspTsRow('Retracted (unsent)', m.date_retracted_ms),
      ])}

      ${inspSection('Threaded reply', [
        inspRow('Reply to GUID', m.thread_originator_guid, { mono: true }),
        inspRow('Reply to part', m.thread_originator_part != null ? String(m.thread_originator_part) : null, { mono: true }),
      ])}

      ${inspSection('Effects', [
        inspRow('Expressive style', expressive, { sub: expressiveSub }),
      ])}

      ${inspSection('iMessage Apps payload', [
        inspRow('Balloon kind', balloon, { sub: balloonSub }),
        inspRow('Audio message', m.is_audio_message === 1 ? 'yes' : null),
      ])}

      ${inspSection('Data Detectors', [
        inspRow('Apple-detected entities', m.has_dd_results === 1 ? 'yes (dates/addresses/etc. parsed)' : null),
      ])}

      ${inspSection('Group / system', [
        inspRow('Group action', groupAction === 'normal message' ? null : groupAction),
        inspRow('SMS subject', m.subject),
      ])}

      ${inspSection('Account / send status', [
        inspRow('Service', m.service),
        inspRow('Account', m.account, { sub: m.account_guid || undefined }),
        inspRow('Send error', m.error && m.error !== 0 ? `code ${m.error}` : null),
      ])}

      ${reactionsBlock ? inspSection('Reactions', [`<div class="insp-reactions-list">${reactionsBlock}</div>`]) : ''}

      ${attBlock ? inspSection('Attachments', [`<div class="insp-att-list">${attBlock}</div>`]) : ''}

      ${m.text ? `
        <div class="insp-section">
          <div class="insp-section-title">Text</div>
          <pre class="insp-text">${escapeHtml(m.text)}</pre>
        </div>
      ` : ''}

    </div>
  `;
}

function openMessageInspector(m) {
  const wrap = document.createElement('div');
  wrap.innerHTML = renderInspectorBody(m);
  const senderName = m.is_from_me === 1
    ? 'You'
    : (m.contact_name || m.handle || '(unknown)');
  openInspector({
    title: `Message details · ${senderName}`,
    contentEl: wrap,
  });
}

// Lookup table: rebuilt every time renderThreadView paints a thread.
// The bubble carries data-msg-guid; the click handler reads from here.
const _messagesByGuid = new Map();

/* ─── message bubbles (chat foundation) ─────────────────────────── */

function renderReactions(reactions) {
  if (!reactions || reactions.length === 0) return '';
  const groups = new Map();
  for (const r of reactions) {
    const key = r.emoji || '·';
    const entry = groups.get(key) || { emoji: key, count: 0, senders: [] };
    entry.count++;
    const who = r.is_from_me ? 'You' : (r.sender_contact_name || r.sender_handle || '?');
    entry.senders.push(who);
    groups.set(key, entry);
  }
  const badges = [...groups.values()].map((g) => {
    const tooltip = `${g.senders.join(', ')}`;
    return `<span class="reaction-badge" title="${escapeHtml(tooltip)}"><span class="emoji">${escapeHtml(g.emoji)}</span>${g.count > 1 ? `<span class="count">${g.count}</span>` : ''}</span>`;
  });
  return `<div class="reactions">${badges.join('')}</div>`;
}

function renderAttachments(attachments) {
  if (!attachments || attachments.length === 0) return '';
  return `<div class="attachments">${attachments.map((a) => {
    const name = a.transfer_name || a.filename?.split('/').pop() || 'file';
    const size = fmtBytes(a.total_bytes);
    if (a.is_image) {
      return `<a href="/api/attachments/${a.rowid}" target="_blank" rel="noopener"><img class="att-image" src="/api/attachments/${a.rowid}" alt="${escapeHtml(name)}" loading="lazy" /></a>`;
    }
    return `<a class="att-file" href="/api/attachments/${a.rowid}" target="_blank" rel="noopener" title="${escapeHtml(name)}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span class="name">${escapeHtml(name)}</span>
      ${size ? `<span class="size">${size}</span>` : ''}
    </a>`;
  }).join('')}</div>`;
}

// iMessage-style receipt label for sent messages. "Read" wins over
// "Delivered" — Apple shows whichever is freshest, with read receipts
// only present when the recipient has them on. Empty string for
// incoming messages and for sends still in flight.
function receiptLabel(m) {
  if (m.is_from_me !== 1) return '';
  if (m.date_read_ms)      return `Read ${relTime(m.date_read_ms)}`;
  if (m.date_delivered_ms) return `Delivered ${relTime(m.date_delivered_ms)}`;
  return '';
}

function renderMessageBubble(m) {
  const fromMe = m.is_from_me === 1;
  const time = relTime(m.date_ms);
  const text = m.text ?? '';
  const senderLabel = fromMe ? '' : (m.contact_name || m.handle || '');
  const hasText = text && text.trim().length > 0 && text !== '￼';
  const bubbleInner = hasText
    ? escapeHtml(text)
    : (m.attachments && m.attachments.length
        ? '' // attachments below stand on their own
        : '<span class="bubble-empty">[encoded message — decoder skipped]</span>');
  const receipt = receiptLabel(m);
  // data-msg-guid is the inspector-handler's hook; the lookup is in
  // _messagesByGuid which renderThreadView populates on every paint.
  return `
    <div class="bubble-row ${fromMe ? 'me' : ''}" data-msg-guid="${escapeHtml(m.guid)}" title="Click for message details">
      <div>
        ${hasText || !(m.attachments && m.attachments.length)
          ? `<div class="bubble ${fromMe ? 'me' : 'them'}">${bubbleInner}</div>` : ''}
        ${renderAttachments(m.attachments)}
        ${renderReactions(m.reactions)}
        <div class="bubble-meta ${fromMe ? 'right' : ''}">${escapeHtml(time)}${senderLabel ? ' · ' + escapeHtml(senderLabel) : ''}</div>
        ${receipt ? `<div class="bubble-receipt"${m.date_read_ms ? ' data-read="true"' : ''}>${escapeHtml(receipt)}</div>` : ''}
      </div>
    </div>
  `;
}

// Document-level delegated click handler for bubbles. Idempotent —
// calling installBubbleClickHandler() multiple times is a no-op (a
// flag on document avoids re-binding).
function installBubbleClickHandler() {
  if (document.__galtBubbleHandlerInstalled) return;
  document.__galtBubbleHandlerInstalled = true;
  document.addEventListener('click', (e) => {
    // Don't intercept clicks on links or images inside the bubble —
    // those have their own behavior (open attachment, copy text, etc.).
    if (e.target.closest('a, img, button, input, textarea')) return;
    const row = e.target.closest('.bubble-row[data-msg-guid]');
    if (!row) return;
    const guid = row.dataset.msgGuid;
    const m = _messagesByGuid.get(guid);
    if (!m) return;
    openMessageInspector(m);
  });
}

/* ─── compose bar (sticky bottom of chat area) ──────────────────── */

export function renderThreadCompose(chatId) {
  return `
    <div class="compose-bar">
      <textarea data-compose-input placeholder="Type a message. ⌘+Enter sends."></textarea>
      <div class="compose-actions">
        <button class="btn primary" data-action="send-direct" data-chat-id="${chatId}" title="Send what you typed directly.">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
          Send
        </button>
        <span class="compose-status" data-compose-status></span>
      </div>
    </div>
  `;
}

/* ─── icons used in workbench cards ─────────────────────────────── */

const ICONS = {
  identity:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M5 21v-1a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v1"/></svg>`,
  profile:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>`,
  notes:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6l3 12h12l3-12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="14" x2="14" y2="14"/></svg>`,
  radar:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/><line x1="12" y1="12" x2="20.5" y2="3.5"/></svg>`,
  tools:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.6 4.9L18 8l-4.4 1.1L12 14l-1.6-4.9L6 8l4.4-1.1L12 2z"/><path d="M3 22l3.3-3.3"/></svg>`,
};
const CHEV = `<svg class="wb-card-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

/* ─── workbench card chrome ─────────────────────────────────────── */

/** Wraps body content in a glass-morphism <details> card. */
function wbCard({ icon, title, meta = '', body, open = false, mode = 'neutral', type = '' }) {
  return `
    <details class="wb-card" data-mode="${escapeHtml(mode)}" data-type="${escapeHtml(type)}" ${open ? 'open' : ''}>
      <summary class="wb-card-head">
        <span class="wb-card-icon">${icon}</span>
        <span class="wb-card-title">${title}</span>
        ${meta ? `<span class="wb-card-meta">${meta}</span>` : ''}
        ${CHEV}
      </summary>
      <div class="wb-card-body">${body}</div>
    </details>
  `;
}

/* ─── Identity card (always at top, default-open) ───────────────── */

// Apple stores `chat.chat_identifier` as `chat<numeric>` for group chats
// and as the recipient handle for 1:1 chats — useful for a synchronous
// group/1:1 check at render time without any API fetch.
function isGroupChatMeta(meta) {
  const id = meta?.identifier ?? '';
  return /^chat\d+$/i.test(id);
}

// awayChat: { id, enabled } if this chat is currently in the away_chats
// watch list, null otherwise. Populated async by mountWorkbench.
function renderIdentityCard(meta, handle, awayChat = null) {
  const isGroup = isGroupChatMeta(meta);
  const name = meta?.contact_name || meta?.display_name || meta?.identifier || '(unknown)';
  const seed = handle || meta?.identifier || meta?.guid || `${meta?.id ?? ''}`;
  const av = avatarClass(seed);
  const init = isGroup
    ? (meta?.display_name
        ? meta.display_name.split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase()
        : 'GR')
    : initials(meta?.contact_name, meta?.display_name, meta?.identifier);
  const onRadar = !isGroup && !!radarHandlesCache.has(handle);
  const subline = isGroup
    ? `group chat${meta?.service_name ? ' · ' + escapeHtml(meta.service_name) : ''}`
    : handle && handle !== name
      ? `${escapeHtml(handle)}${meta?.service_name ? ' · ' + escapeHtml(meta.service_name) : ''}`
      : (meta?.service_name ? escapeHtml(meta.service_name) : '');

  // Pills:
  //   1:1 chat   → Radar toggle (existing)
  //   group chat → Away watch toggle (new in Stage 2)
  // Radar today is per-handle (per-contact), so it doesn't make sense
  // for groups — hide the radar pill on group threads.
  let pills = '';
  if (isGroup) {
    pills = awayChat
      ? `<button class="wb-pill on" data-action="remove-current-chat-from-away" data-id="${awayChat.id}" data-chat-id="${meta.id}" title="Galt covers this group when Away — click to remove"><span class="wb-pill-dot"></span>Away watching</button>`
      : `<button class="wb-pill" data-action="add-current-chat-to-away" data-chat-id="${meta.id}" title="Opt this group into Away mode so Galt auto-replies here when you're out">+ Add to Away</button>`;
  } else {
    pills = onRadar
      ? `<button class="wb-pill on" data-action="toggle-radar" data-handle="${escapeHtml(handle)}" title="On radar — click to remove"><span class="wb-pill-dot"></span>Radar on</button>`
      : `<button class="wb-pill" data-action="toggle-radar" data-handle="${escapeHtml(handle)}" title="Add to radar — start tracking signals from this contact">+ Add to Radar</button>`;
  }

  const body = `
    <div class="wb-identity">
      <div class="wb-identity-row">
        <div class="avatar lg ${av}">${escapeHtml(init)}</div>
        <div class="wb-identity-text">
          <div class="wb-identity-name">${escapeHtml(name)}</div>
          ${subline ? `<div class="wb-identity-sub">${subline}</div>` : ''}
        </div>
      </div>
      <div class="wb-identity-pills">
        ${pills}
      </div>
    </div>
  `;

  return wbCard({
    icon: ICONS.identity,
    title: isGroup ? 'Group chat' : 'Contact',
    meta: '',
    body,
    open: true,
    mode: 'identity',
    type: 'identity',
  });
}

/* ─── Profile / Notes cards — wrap existing form blocks ─────────── */

function renderProfileCardSlot(handle, profile, updatedAt) {
  const updatedLabel = updatedAt > 0 ? `updated ${relTime(updatedAt)}` : 'unwritten';
  const filled = (profile || '').trim().length > 0;
  return wbCard({
    icon: ICONS.profile,
    title: 'About this contact',
    meta: filled ? `<span class="wb-meta-ok">●</span> ${updatedLabel}` : `<span class="wb-meta-faint">○</span> ${updatedLabel}`,
    body: renderProfileBlock(handle, profile, updatedAt),
    open: false,
    mode: 'profile',
    type: 'profile',
  });
}

function renderNotesCardSlot(handle, notes) {
  const count = notes.length;
  return wbCard({
    icon: ICONS.notes,
    title: 'Memory notes',
    meta: count > 0 ? `<span class="wb-meta-num">${count}</span>` : '<span class="wb-meta-faint">empty</span>',
    body: renderNotesBlock(handle, notes),
    open: count > 0, // open by default when there ARE notes (so they're skim-able)
    mode: 'notes',
    type: 'notes',
  });
}

/* ─── Radar card — only renders when the contact is on radar ───── */

function renderRadarSignalRow(s) {
  return `
    <div class="wb-radar-signal">
      <span class="wb-radar-cat">${escapeHtml(s.category)}</span>
      <span class="wb-radar-text">${escapeHtml(s.content)}</span>
      <span class="wb-radar-time">${escapeHtml(relTime(s.extracted_at))}</span>
    </div>
  `;
}

function renderRadarCardSlot(handle, radarData) {
  const { contact, signals, signal_counts: counts } = radarData;
  const total = signals.length;
  const lastN = signals.slice(0, 6);
  const profileText = (contact.profile || '').trim();
  const profileBlock = profileText
    ? `<details class="wb-radar-profile" open>
         <summary>distilled profile <span class="wb-meta-faint">${profileText.length} chars</span></summary>
         <pre class="wb-radar-profile-body">${escapeHtml(profileText)}</pre>
         <div class="wb-radar-actions">
           <button class="btn ghost small" data-action="radar-regenerate" data-handle="${escapeHtml(handle)}">Regenerate from signals</button>
         </div>
       </details>`
    : `<div class="wb-radar-empty">no distilled profile yet · <button class="link-btn" data-action="radar-regenerate" data-handle="${escapeHtml(handle)}">regenerate from signals</button></div>`;

  const signalsBlock = total === 0
    ? '<div class="wb-radar-empty">no signals captured yet — every incoming message gets analyzed automatically</div>'
    : `<div class="wb-radar-signals">${lastN.map(renderRadarSignalRow).join('')}${total > lastN.length ? `<a class="wb-radar-more" href="#/radar/${encodeURIComponent(handle)}">view all ${total} →</a>` : ''}</div>`;

  const catSummary = Object.entries(counts || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([cat, n]) => `<span class="wb-radar-catpill">${escapeHtml(cat)} ${n}</span>`)
    .join('');

  const body = `
    <div class="wb-radar">
      ${catSummary ? `<div class="wb-radar-catbar">${catSummary}</div>` : ''}
      ${profileBlock}
      ${signalsBlock}
    </div>
  `;

  return wbCard({
    icon: ICONS.radar,
    title: 'Radar',
    meta: total > 0 ? `<span class="wb-meta-num">${total}</span> signals` : '<span class="wb-meta-faint">tracking</span>',
    body,
    open: true, // radar's the headline thing when on — keep visible
    mode: 'radar',
    type: 'radar',
  });
}

/* ─── AI Tools card — Summarize + future ─────────────────────────── */

function renderToolsCard(chatId) {
  const body = `
    <div class="wb-tools">
      <button class="btn" data-action="ai-summarize" data-chat-id="${chatId}" title="Quick AI summary of recent messages">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
        Summarize this thread
      </button>
      <span class="wb-tools-status toolbar-status" data-toolbar-status></span>
      <div class="summary-panel" data-summary-panel hidden></div>
    </div>
  `;
  return wbCard({
    icon: ICONS.tools,
    title: 'AI tools',
    meta: '',
    body,
    open: false,
    mode: 'tools',
    type: 'tools',
  });
}

/* ─── workbench mount: fetches data + renders all cards ────────── */

async function mountWorkbench(meta, chatId, handle) {
  const slot = (id) => document.getElementById(id);

  // Identity renders immediately with no away-chat info; if the chat is
  // a group, we fetch /api/away/chats next and re-render with the watch
  // status so the pill shows correct state.
  if (slot('workbench-identity')) {
    slot('workbench-identity').innerHTML = renderIdentityCard(meta, handle, null);
  }
  if (isGroupChatMeta(meta)) {
    api('/api/away/chats')
      .then((r) => {
        const match = (r.chats || []).find((c) => c.chat_id === chatId);
        const el = slot('workbench-identity');
        if (el) el.innerHTML = renderIdentityCard(meta, handle, match || null);
      })
      .catch((e) => console.warn('[workbench] away/chats fetch failed:', e));
  }

  // Tools are also synchronous (just buttons + a summary target).
  if (slot('workbench-tools')) {
    slot('workbench-tools').innerHTML = renderToolsCard(chatId);
  }

  // Profile + Notes + Radar fetch in parallel and update their slots
  // when ready. Each tolerates fetch failure independently.
  const onRadar = !!radarHandlesCache.has(handle);

  // Profile
  api(`/api/contacts/profile?handle=${encodeURIComponent(handle)}`)
    .then((r) => {
      const el = slot('workbench-profile');
      if (el) el.innerHTML = renderProfileCardSlot(handle, r.profile || '', r.updated_at || 0);
    })
    .catch((e) => {
      const el = slot('workbench-profile');
      if (el) el.innerHTML = renderProfileCardSlot(handle, '', 0);
      console.warn('[workbench] profile fetch failed:', e);
    });

  // Notes
  api(`/api/contacts/notes?handle=${encodeURIComponent(handle)}`)
    .then((r) => {
      const el = slot('workbench-notes');
      if (el) el.innerHTML = renderNotesCardSlot(handle, r.notes || []);
    })
    .catch((e) => {
      const el = slot('workbench-notes');
      if (el) el.innerHTML = renderNotesCardSlot(handle, []);
      console.warn('[workbench] notes fetch failed:', e);
    });

  // Radar — only if on radar. The slot stays empty otherwise.
  const radarSlot = slot('workbench-radar');
  if (radarSlot) {
    if (onRadar) {
      radarSlot.innerHTML = '<div class="wb-card-skeleton">loading radar…</div>';
      api(`/api/radar/contacts/by-handle/${encodeURIComponent(handle)}`)
        .then((r) => {
          if (!radarSlot) return;
          radarSlot.innerHTML = renderRadarCardSlot(handle, r);
        })
        .catch((e) => {
          if (!radarSlot) return;
          radarSlot.innerHTML = '';
          console.warn('[workbench] radar fetch failed:', e);
        });
    } else {
      radarSlot.innerHTML = '';
    }
  }
}

/** Public re-render hook for a single workbench panel — used by action
 *  handlers that mutate data and need to refresh the card. */
export async function refreshWorkbenchPanel(kind, handle, chatId) {
  if (!handle) return;
  const slot = (id) => document.getElementById(id);
  if (kind === 'profile') {
    try {
      const r = await api(`/api/contacts/profile?handle=${encodeURIComponent(handle)}`);
      const el = slot('workbench-profile');
      if (el) el.innerHTML = renderProfileCardSlot(handle, r.profile || '', r.updated_at || 0);
    } catch { /* keep prior */ }
  } else if (kind === 'notes') {
    try {
      const r = await api(`/api/contacts/notes?handle=${encodeURIComponent(handle)}`);
      const el = slot('workbench-notes');
      if (el) el.innerHTML = renderNotesCardSlot(handle, r.notes || []);
    } catch { /* keep prior */ }
  } else if (kind === 'radar') {
    const onRadar = !!radarHandlesCache.has(handle);
    const radarSlot = slot('workbench-radar');
    if (!radarSlot) return;
    if (!onRadar) { radarSlot.innerHTML = ''; return; }
    try {
      const r = await api(`/api/radar/contacts/by-handle/${encodeURIComponent(handle)}`);
      radarSlot.innerHTML = renderRadarCardSlot(handle, r);
    } catch { radarSlot.innerHTML = ''; }
  } else if (kind === 'identity') {
    if (chatId == null) return;
    const meta = chatsCache.find((c) => c.id === chatId);
    if (!meta) return;
    if (!slot('workbench-identity')) return;
    // Group chats need an awayChat lookup before re-render so the pill
    // reflects the new state. 1:1 has no equivalent (radar pill is
    // always-correct from radarHandlesCache which is updated by the
    // radar toggle handler).
    if (isGroupChatMeta(meta)) {
      try {
        const r = await api('/api/away/chats');
        const match = (r.chats || []).find((c) => c.chat_id === chatId);
        slot('workbench-identity').innerHTML = renderIdentityCard(meta, handle, match || null);
      } catch {
        slot('workbench-identity').innerHTML = renderIdentityCard(meta, handle, null);
      }
    } else {
      slot('workbench-identity').innerHTML = renderIdentityCard(meta, handle, null);
    }
  }
}

/* ─── top-level thread render ───────────────────────────────────── */

export async function renderThreadView(chatId) {
  const meta = chatsCache.find((c) => c.id === chatId);
  const handle = meta?.identifier || '';
  const isGroup = isGroupChatMeta(meta);
  // Group chats: prefer the human-set display_name; fall back to a
  // friendly "Group chat" rather than the raw `chat123456789` id.
  // 1:1: existing precedence (contact_name → display_name → handle).
  const title = isGroup
    ? (meta?.display_name || `Group chat (${meta?.identifier || chatId})`)
    : (meta?.contact_name || meta?.display_name || meta?.identifier || `Chat #${chatId}`);
  const subInfo = isGroup
    ? `${escapeHtml(meta?.identifier || `chat${chatId}`)} · group`
    : (handle ? escapeHtml(handle) : '');
  setMainHeader({
    title,
    subHTML: `<a class="back-link" data-action="back-to-inbox">← back to inbox</a>${subInfo ? ' · ' + subInfo : ''}`,
  });

  const compose = document.getElementById('thread-compose-bar');
  if (compose) compose.innerHTML = renderThreadCompose(chatId);

  // Mount the workbench (right panel cards). Identity + Tools render
  // sync; Profile/Notes/Radar fire async fetches that fill their slots
  // when data arrives.
  if (handle) await mountWorkbench(meta, chatId, handle);

  // Chat messages — primary content, full main column.
  const list = document.getElementById('drafts-list');
  if (list) list.innerHTML = '<div class="empty"><div class="empty-title">loading…</div></div>';

  try {
    const { messages } = await api(`/api/chats/${chatId}/messages?limit=200`);
    if (!list) return;
    if (!messages.length) {
      list.innerHTML = '<div class="empty"><div class="empty-title">No messages in this chat.</div></div>';
      return;
    }
    // Repopulate the inspector lookup table — last-write-wins on guid
    // collisions (shouldn't happen, but harmless if it does).
    _messagesByGuid.clear();
    for (const m of messages) _messagesByGuid.set(m.guid, m);
    installBubbleClickHandler();

    const ascending = messages.slice().reverse();
    list.innerHTML = ascending.map(renderMessageBubble).join('');
    requestAnimationFrame(() => {
      const main = document.querySelector('.main');
      if (main) main.scrollTop = main.scrollHeight;
    });
  } catch (e) {
    if (list) {
      list.innerHTML = `<div class="empty"><div class="empty-title">Failed to load messages.</div><div class="empty-sub">${escapeHtml(e.message)}</div></div>`;
    }
  }
}

/** Legacy export — older callers expected a `renderThreadToolbar` that
 *  wrote into #thread-toolbar. The toolbar concept moved into the
 *  workbench (Identity card carries the radar toggle; Tools card holds
 *  Summarize). This stub is a no-op so anything that still calls it
 *  doesn't break. */
export function renderThreadToolbar() {
  return '';
}
