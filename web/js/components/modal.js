// Generic modal overlay with Cancel / Confirm.
// Usage:
//   openModal({ title, contentEl, confirmLabel, onConfirm: async () => { ... } });

import { escapeHtml } from '../utils.js';

export function openModal({ title, contentEl, onConfirm, confirmLabel = 'Confirm' }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const card = document.createElement('div');
  card.className = 'modal-card';
  card.innerHTML = `<h3>${escapeHtml(title)}</h3>`;
  card.appendChild(contentEl);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn ghost';
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn primary';
  confirmBtn.type = 'button';
  confirmBtn.textContent = confirmLabel;

  actions.append(cancelBtn, confirmBtn);
  card.appendChild(actions);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  const onKey = (e) => {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);

  confirmBtn.addEventListener('click', async () => {
    try {
      await onConfirm();
      close();
    } catch (err) {
      alert(err.message || String(err));
    }
  });
}

// Read-only inspector. Same overlay chrome as openModal but only a
// "Close" button — no confirm/cancel pair. Used for surfacing details
// (e.g. message metadata) where the user just needs to look.
export function openInspector({ title, contentEl }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay inspector';
  const card = document.createElement('div');
  card.className = 'modal-card inspector-card';
  card.innerHTML = `<h3>${escapeHtml(title)}</h3>`;
  card.appendChild(contentEl);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn ghost';
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  actions.appendChild(closeBtn);
  card.appendChild(actions);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
}
