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
