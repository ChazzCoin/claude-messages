// Visual date+time picker.
// mountDatePicker(container, { defaultTs }) → { getMs, getDate }
// Self-contained: presets + month grid + AM/PM time picker.

import { escapeHtml } from '../utils.js';

const DT_DAY_NAMES = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DT_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function mountDatePicker(container, opts = {}) {
  const initial = new Date(opts.defaultTs || Date.now() + 60 * 60 * 1000);
  let selectedDate = new Date(initial);
  selectedDate.setHours(0, 0, 0, 0);
  let viewMonth = new Date(selectedDate);
  viewMonth.setDate(1);
  let hour12 = (initial.getHours() % 12) || 12;
  let minute = (Math.round(initial.getMinutes() / 5) * 5) % 60;
  let ampm = initial.getHours() >= 12 ? 'PM' : 'AM';

  function chosenDate() {
    const d = new Date(selectedDate);
    let h = hour12 % 12;
    if (ampm === 'PM') h += 12;
    d.setHours(h, minute, 0, 0);
    return d;
  }

  function monthGridHTML() {
    const y = viewMonth.getFullYear();
    const m = viewMonth.getMonth();
    const first = new Date(y, m, 1);
    const startDow = first.getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const daysInPrev = new Date(y, m, 0).getDate();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cells = [];
    for (let i = 0; i < startDow; i++) {
      const day = daysInPrev - startDow + 1 + i;
      cells.push({ day, muted: true, disabled: true });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const dt = new Date(y, m, d);
      const isPast = dt.getTime() < today.getTime();
      const isToday = dt.getTime() === today.getTime();
      const isSelected =
        dt.getFullYear() === selectedDate.getFullYear() &&
        dt.getMonth() === selectedDate.getMonth() &&
        dt.getDate() === selectedDate.getDate();
      cells.push({ day: d, today: isToday, selected: isSelected, past: isPast });
    }
    while (cells.length % 7 !== 0) {
      cells.push({ day: cells.length - daysInMonth - startDow + 1, muted: true, disabled: true });
    }
    const headers = DT_DAY_NAMES.map((d) => `<div class="dt-cal-dow">${d}</div>`).join('');
    const days = cells.map((c) => {
      const cls = ['dt-cal-day'];
      if (c.muted) cls.push('muted');
      if (c.today) cls.push('today');
      if (c.selected) cls.push('selected');
      if (c.past) cls.push('past');
      const interactive = !c.disabled && !c.past;
      return `<div class="${cls.join(' ')}" ${interactive ? `data-action="dt-pick-day" data-day="${c.day}"` : ''}>${c.day}</div>`;
    }).join('');
    return headers + days;
  }

  function fmtSelected() {
    const d = chosenDate();
    return d.toLocaleString(undefined, {
      weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  function render() {
    const hourOpts = Array.from({ length: 12 }, (_, i) =>
      `<option value="${i + 1}" ${(i + 1) === hour12 ? 'selected' : ''}>${(i + 1).toString().padStart(2, '0')}</option>`,
    ).join('');
    const minuteOpts = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]
      .map((m) => `<option value="${m}" ${m === minute ? 'selected' : ''}>${m.toString().padStart(2, '0')}</option>`)
      .join('');
    container.innerHTML = `
      <div class="dt-picker">
        <div class="dt-presets">
          <button type="button" class="dt-preset" data-action="dt-preset" data-preset="1h">in 1 hour</button>
          <button type="button" class="dt-preset" data-action="dt-preset" data-preset="3h">in 3 hours</button>
          <button type="button" class="dt-preset" data-action="dt-preset" data-preset="tonight">tonight 8pm</button>
          <button type="button" class="dt-preset" data-action="dt-preset" data-preset="tom-am">tomorrow 9am</button>
          <button type="button" class="dt-preset" data-action="dt-preset" data-preset="tom-pm">tomorrow 7pm</button>
          <button type="button" class="dt-preset" data-action="dt-preset" data-preset="next-week">next week</button>
        </div>
        <div class="dt-cal">
          <div class="dt-cal-head">
            <button type="button" data-action="dt-prev-month" aria-label="previous">‹</button>
            <span>${escapeHtml(DT_MONTH_NAMES[viewMonth.getMonth()])} ${viewMonth.getFullYear()}</span>
            <button type="button" data-action="dt-next-month" aria-label="next">›</button>
          </div>
          <div class="dt-cal-grid">${monthGridHTML()}</div>
        </div>
        <div class="dt-time-row">
          <span style="color:var(--text-faint);font-size:11px;text-transform:uppercase;letter-spacing:0.6px;">time</span>
          <select data-dt-hour>${hourOpts}</select>
          <span class="colon">:</span>
          <select data-dt-min>${minuteOpts}</select>
          <select data-dt-ampm>
            <option value="AM" ${ampm === 'AM' ? 'selected' : ''}>AM</option>
            <option value="PM" ${ampm === 'PM' ? 'selected' : ''}>PM</option>
          </select>
        </div>
        <div class="dt-result"><span class="label">selected:</span><span data-dt-display>${escapeHtml(fmtSelected())}</span></div>
      </div>
    `;
  }

  function applyPreset(preset) {
    const now = new Date();
    let target = new Date();
    switch (preset) {
      case '1h':       target = new Date(now.getTime() + 60 * 60 * 1000); break;
      case '3h':       target = new Date(now.getTime() + 3 * 60 * 60 * 1000); break;
      case 'tonight':  target.setHours(20, 0, 0, 0); if (target <= now) target.setDate(target.getDate() + 1); break;
      case 'tom-am':   target.setDate(now.getDate() + 1); target.setHours(9, 0, 0, 0); break;
      case 'tom-pm':   target.setDate(now.getDate() + 1); target.setHours(19, 0, 0, 0); break;
      case 'next-week':target.setDate(now.getDate() + 7); break;
      default: return;
    }
    selectedDate = new Date(target);
    selectedDate.setHours(0, 0, 0, 0);
    viewMonth = new Date(selectedDate);
    viewMonth.setDate(1);
    hour12 = (target.getHours() % 12) || 12;
    minute = (Math.round(target.getMinutes() / 5) * 5) % 60;
    ampm = target.getHours() >= 12 ? 'PM' : 'AM';
    render();
  }

  container.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const a = target.closest('[data-action]');
    if (!a) return;
    const act = a.getAttribute('data-action');
    if (act === 'dt-preset') { applyPreset(a.getAttribute('data-preset')); return; }
    if (act === 'dt-prev-month') { viewMonth.setMonth(viewMonth.getMonth() - 1); render(); return; }
    if (act === 'dt-next-month') { viewMonth.setMonth(viewMonth.getMonth() + 1); render(); return; }
    if (act === 'dt-pick-day') {
      const day = parseInt(a.getAttribute('data-day'), 10);
      if (Number.isFinite(day)) {
        selectedDate = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), day);
        render();
      }
      return;
    }
  });

  container.addEventListener('change', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLSelectElement)) return;
    if (target.matches('[data-dt-hour]')) hour12 = parseInt(target.value, 10);
    else if (target.matches('[data-dt-min]')) minute = parseInt(target.value, 10);
    else if (target.matches('[data-dt-ampm]')) ampm = target.value;
    const disp = container.querySelector('[data-dt-display]');
    if (disp) disp.textContent = fmtSelected();
  });

  render();
  return {
    getMs: () => chosenDate().getTime(),
    getDate: () => chosenDate(),
  };
}
