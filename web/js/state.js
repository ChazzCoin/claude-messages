// Module-level shared state. Imported by views, components, sse, router.
// Keep this small — anything view-specific belongs in that view's module.

// Caches populated from API on init / SSE updates.
export let chatsCache = [];
export let contactsCache = []; // [{full_name, first_name, last_name, organization, handles: [...]}]
export let settingsCache = {
  ai_context_count: 20,
  voice_profile: '',
  voice_profile_sample_count: 200,
  voice_profile_user_context: '',
  voice_profile_updated_at: 0,
  away_mode_enabled: 0,
  away_message: '',
  away_max_replies_per_session: 50,
  away_persona: '',
};
export let settingsBounds = {
  ai_context_count: { min: 1, max: 100 },
  voice_profile_sample_count: { min: 50, max: 2000 },
  away_max_replies_per_session: { min: 1, max: 200 },
};
export let radarHandlesCache = new Set();

// Current view tracking — set by router/setView.
export let currentView = 'inbox';
export let currentChatId = null;
export let currentRadarHandle = null;

// Tab state for views that have multiple sub-tabs.
export let radarSignalsTab = 'all';
export let calendarTab = 'pending';
export let flagsTab = 'unreviewed';

// Transient state.
export let pendingVariants = null; // { variants, chat_id, handle, source_msg_guid, model, usage, temperament, contextNote }
export let scheduleFormPicker = null; // returned by mountDatePicker for the inline schedule form
export let awayUnreviewedNotes = 0;

// Constants.
export const TEMPERAMENTS = [
  'normal', 'warm', 'casual', 'professional', 'enthusiastic', 'apologetic',
  'snarky', 'blunt', 'angry', 'sad', 'aggressive',
];

// --- mutators (so importing modules can update without reassigning bindings) ---
// ES module exports are live read-only bindings; consumers can read but the
// module that owns them must mutate. These setters keep state changes
// explicit and grep-able.

export function setChatsCache(v) { chatsCache = v; }
export function setContactsCache(v) { contactsCache = v; }
export function setSettingsCache(v) { settingsCache = { ...settingsCache, ...v }; }
export function setSettingsBounds(v) { settingsBounds = { ...settingsBounds, ...v }; }
export function setRadarHandlesCache(s) { radarHandlesCache = s; }

export function setCurrentView(v) { currentView = v; }
export function setCurrentChatId(v) { currentChatId = v; }
export function setCurrentRadarHandle(v) { currentRadarHandle = v; }

export function setRadarSignalsTab(v) { radarSignalsTab = v; }
export function setCalendarTab(v) { calendarTab = v; }
export function setFlagsTab(v) { flagsTab = v; }

export function setPendingVariants(v) { pendingVariants = v; }
export function setScheduleFormPicker(v) { scheduleFormPicker = v; }
export function setAwayUnreviewedNotes(n) { awayUnreviewedNotes = n; }
