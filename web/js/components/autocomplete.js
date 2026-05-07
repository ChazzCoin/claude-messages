// Contact autocomplete — single body-portaled dropdown shared across every
// input tagged with `data-contact-autocomplete`. Pure event delegation, so
// inputs that appear/disappear (form re-renders, modal opens, etc.) are
// handled with no per-input mount step.
//
// Usage: call installContactAutocomplete() once at startup. The contacts
// list it filters against is read live from state.contactsCache.

import { escapeHtml, initials, avatarClass } from '../utils.js';
import { contactsCache } from '../state.js';

let acDropdownEl = null;
let acCurrentInput = null;
let acMatches = [];
let acActiveIdx = -1;

function ensureAcDropdown() {
  if (acDropdownEl && acDropdownEl.isConnected) return acDropdownEl;
  acDropdownEl = document.createElement('div');
  acDropdownEl.className = 'contact-autocomplete ac-portal';
  document.body.appendChild(acDropdownEl);
  acDropdownEl.addEventListener('mousedown', (e) => {
    const item = e.target instanceof HTMLElement ? e.target.closest('.ac-item') : null;
    if (!item) return;
    e.preventDefault(); // keep input focus
    const idx = parseInt(item.getAttribute('data-idx') || '', 10);
    if (Number.isFinite(idx)) acPick(idx);
  });
  return acDropdownEl;
}

function acPositionDropdown(input) {
  const dropdown = ensureAcDropdown();
  const rect = input.getBoundingClientRect();
  dropdown.style.top = `${Math.round(rect.bottom + 4)}px`;
  dropdown.style.left = `${Math.round(rect.left)}px`;
  dropdown.style.width = `${Math.round(rect.width)}px`;
}

function acComputeMatches() {
  if (!acCurrentInput) { acMatches = []; acActiveIdx = -1; return; }
  const q = (acCurrentInput.value || '').trim().toLowerCase();
  const all = contactsCache.flatMap((c) =>
    (c.handles || []).map((h) => ({ name: c.full_name, handle: h })),
  );
  let pool = all;
  if (q.length > 0) {
    pool = all.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.handle.toLowerCase().includes(q),
    );
  }
  pool.sort((a, b) => {
    const ap = q && a.name.toLowerCase().startsWith(q) ? 0 : 1;
    const bp = q && b.name.toLowerCase().startsWith(q) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.name.localeCompare(b.name);
  });
  acMatches = pool.slice(0, 15);
  acActiveIdx = acMatches.length > 0 ? 0 : -1;
}

function acPaint() {
  const dropdown = ensureAcDropdown();
  if (!acCurrentInput) {
    dropdown.classList.remove('open');
    return;
  }
  if (acMatches.length === 0) {
    dropdown.innerHTML = `<div class="ac-empty">no matching contacts · ${contactsCache.length} loaded</div>`;
  } else {
    dropdown.innerHTML = acMatches.map((m, i) => `
      <div class="ac-item ${i === acActiveIdx ? 'active' : ''}" data-idx="${i}">
        <div class="avatar ${avatarClass(m.handle)}">${escapeHtml(initials(m.name, m.handle))}</div>
        <div>
          <div class="ac-name">${escapeHtml(m.name)}</div>
          <div class="ac-handle">${escapeHtml(m.handle)}</div>
        </div>
      </div>
    `).join('');
  }
  dropdown.classList.add('open');
}

function acHide() {
  if (acDropdownEl) acDropdownEl.classList.remove('open');
  acCurrentInput = null;
}

function acPick(idx) {
  const m = acMatches[idx];
  if (!m || !acCurrentInput) return;
  const input = acCurrentInput;
  input.value = m.handle;
  const form = input.closest('form');
  const labelInput = form?.querySelector('input[name="label"]');
  if (labelInput && !labelInput.value) labelInput.value = m.name;
  acHide();
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.focus();
}

/**
 * Install document-level event delegation for any input tagged
 * `[data-contact-autocomplete]`. Idempotent — guards against double-install.
 */
let installed = false;
export function installContactAutocomplete() {
  if (installed) return;
  installed = true;

  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (!t.matches('[data-contact-autocomplete]')) return;
    t.setAttribute('autocomplete', 'off');
    acCurrentInput = t;
    acComputeMatches();
    acPaint();
    acPositionDropdown(t);
  });

  document.addEventListener('focusout', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (!t.matches('[data-contact-autocomplete]')) return;
    // Delay so the dropdown's mousedown can land before the dropdown disappears.
    setTimeout(() => {
      if (acCurrentInput === t && document.activeElement !== t) acHide();
    }, 200);
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (!t.matches('[data-contact-autocomplete]')) return;
    acCurrentInput = t;
    acComputeMatches();
    acPaint();
    acPositionDropdown(t);
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (!t.matches('[data-contact-autocomplete]')) return;
    if (!acDropdownEl || !acDropdownEl.classList.contains('open')) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      acActiveIdx = Math.min(acMatches.length - 1, acActiveIdx + 1);
      acPaint();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      acActiveIdx = Math.max(0, acActiveIdx - 1);
      acPaint();
    } else if (e.key === 'Enter' && acActiveIdx >= 0) {
      e.preventDefault();
      acPick(acActiveIdx);
    } else if (e.key === 'Escape') {
      acHide();
    }
  });

  // Reposition on scroll/resize so the body-portaled dropdown tracks the input.
  window.addEventListener('scroll', () => {
    if (acCurrentInput) acPositionDropdown(acCurrentInput);
  }, true);
  window.addEventListener('resize', () => {
    if (acCurrentInput) acPositionDropdown(acCurrentInput);
  });
}
