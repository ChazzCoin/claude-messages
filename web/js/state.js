// Module-level shared state. Imported by views, components, sse, router.
// Keep this small — anything view-specific belongs in that view's module.

// Caches populated from API on init / SSE updates.
export let chatsCache = [];
export let contactsCache = []; // [{full_name, first_name, last_name, organization, handles: [...]}]
export let settingsCache = {
  ai_context_count: 20,
  away_mode_enabled: 0,
  away_message: '',
  away_max_replies_per_session: 50,
  away_persona: '',
  auto_notes_enabled: 1,
  auto_notes_min_confidence: 0,
  auto_notes_excluded_handles: '[]',
};
export let settingsBounds = {
  ai_context_count: { min: 1, max: 100 },
  away_max_replies_per_session: { min: 1, max: 200 },
};
export let radarHandlesCache = new Set();
// Built-in prompt/wrapper defaults from /api/settings response. Read-only
// for the UI — used to render "Built-in default" panes alongside the
// editable override textareas on the Galt page.
export let promptDefaults = {};

// Current view tracking — set by router/setView.
export let currentView = 'inbox';
export let currentChatId = null;
export let currentRadarHandle = null;

// Tab state for views that have multiple sub-tabs.
export let radarSignalsTab = 'all';
export let calendarTab = 'pending';
export let flagsTab = 'unreviewed';
export let queueTab = 'calendar'; // which Queue sub-tab is active (calendar|flags|scheduled)

// Transient state.
// pendingVariants and TEMPERAMENTS were retired with the manual AI draft
// flow. (TEMPERAMENTS still lives server-side in ai.ts for future internal
// use; nothing in the frontend references it today.)
export let scheduleFormPicker = null; // returned by mountDatePicker for the inline schedule form
export let autoUnreviewedNotes = 0;

// --- mutators (so importing modules can update without reassigning bindings) ---
// ES module exports are live read-only bindings; consumers can read but the
// module that owns them must mutate. These setters keep state changes
// explicit and grep-able.

export function setChatsCache(v) { chatsCache = v; }
export function setContactsCache(v) { contactsCache = v; }
export function setPromptDefaults(v) { promptDefaults = v ?? {}; }
export function setSettingsCache(v) { settingsCache = { ...settingsCache, ...v }; }
export function setSettingsBounds(v) { settingsBounds = { ...settingsBounds, ...v }; }
export function setRadarHandlesCache(s) { radarHandlesCache = s; }

export function setCurrentView(v) { currentView = v; }
export function setCurrentChatId(v) { currentChatId = v; }
export function setCurrentRadarHandle(v) { currentRadarHandle = v; }

export function setRadarSignalsTab(v) { radarSignalsTab = v; }
export function setCalendarTab(v) { calendarTab = v; }
export function setFlagsTab(v) { flagsTab = v; }
export function setQueueTab(v) { queueTab = v; }

export function setScheduleFormPicker(v) { scheduleFormPicker = v; }
export function setAutoUnreviewedNotes(n) { autoUnreviewedNotes = n; }
