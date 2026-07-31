let state = null;
let activeView = "all";
let selectedEventId = new URLSearchParams(window.location.search).get("event") || "";
let staticMode = false;
let supabaseMode = false;
let authSession = null;
const STATIC_STORE_KEY = "eventPlannerStaticStore";
const AUTH_STORAGE_KEY = "eventPlannerSupabaseSession";
const MAX_STATIC_ENTRIES = 10000;
const SUPABASE_CONFIG = window.EVENT_PLANNER_SUPABASE || {};
const DANCER_GROUPS = ["Ladies", "Men", "Kids", "Girls", "Boys", "Couples", "Parents & Kids"];

const nodes = {
  homeView: document.querySelector("#homeView"),
  plannerView: document.querySelector("#plannerView"),
  plannerTabs: document.querySelector("#plannerTabs"),
  homeButton: document.querySelector("#homeButton"),
  backButton: document.querySelector("#backButton"),
  eventCards: document.querySelector("#eventCards"),
  eventName: document.querySelector("#eventName"),
  plannerTitle: document.querySelector("#plannerTitle"),
  eventMeta: document.querySelector("#eventMeta"),
  entryCount: document.querySelector("#entryCount"),
  finalizedCount: document.querySelector("#finalizedCount"),
  voteCount: document.querySelector("#voteCount"),
  practiceCount: document.querySelector("#practiceCount"),
  cards: document.querySelector("#cards"),
  practiceView: document.querySelector("#practiceView"),
  practiceLogs: document.querySelector("#practiceLogs"),
  practicePerformance: document.querySelector("#practicePerformance"),
  panelTitle: document.querySelector("#panelTitle"),
  panelSubtitle: document.querySelector("#panelSubtitle"),
  statusText: document.querySelector("#statusText"),
  createEventForm: document.querySelector("#createEventForm"),
  joinEventForm: document.querySelector("#joinEventForm"),
  eventForm: document.querySelector("#eventForm"),
  performanceForm: document.querySelector("#performanceForm"),
  practiceForm: document.querySelector("#practiceForm"),
};

function setStatus(message) {
  nodes.statusText.textContent = message;
}

function currentUser() {
  return authSession?.user || null;
}

function setStoredSession(session) {
  authSession = session;
  if (session) localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  else localStorage.removeItem(AUTH_STORAGE_KEY);
}

async function api(path, payload) {
  if (!state) {
    await initialization;
  }

  if (supabaseMode) {
    return supabaseApi(path, payload);
  }

  if (staticMode) {
    return staticApi(path, payload);
  }

  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": state.csrfToken,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

async function loadState() {
  if (isSupabaseConfigured()) {
    if (!currentUser()) {
      throw new Error("Anonymous sign-ins are not enabled in Supabase yet.");
    }
    supabaseMode = true;
    staticMode = false;
    state = await readSupabaseState();
    if (selectedEventId && !state.event) {
      selectedEventId = "";
      updateUrl();
      state = await readSupabaseState();
    }
    render();
    setStatus("Live shared data");
    return;
  }

  const query = selectedEventId ? `?eventId=${encodeURIComponent(selectedEventId)}` : "";
  try {
    const response = await fetch(`/api/state${query}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Could not load event data.");
    }
    state = normalizeState(await response.json());
  } catch (error) {
    staticMode = true;
    state = readStaticState();
    render();
    setStatus("Saved in this browser");
    return;
  }
  if (selectedEventId && !state.event) {
    selectedEventId = "";
    updateUrl();
    await loadState();
    return;
  }
  render();
}

function isSupabaseConfigured() {
  return Boolean(SUPABASE_CONFIG.url && SUPABASE_CONFIG.anonKey);
}

async function supabaseAuth(path, options = {}) {
  const response = await fetch(`${SUPABASE_CONFIG.url.replace(/\/$/, "")}/auth/v1/${path}`, {
    ...options,
    headers: { apikey: SUPABASE_CONFIG.anonKey, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.msg || data.message || data.error_description || "Authentication failed.");
  return data;
}

async function restoreSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null");
    if (!saved?.access_token) return;
    const user = await supabaseAuth("user", { headers: { Authorization: `Bearer ${saved.access_token}` } });
    setStoredSession({ ...saved, user });
  } catch {
    setStoredSession(null);
  }
}

async function supabaseRequest(path, options = {}) {
  const url = `${SUPABASE_CONFIG.url.replace(/\/$/, "")}/rest/v1/${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_CONFIG.anonKey,
      Authorization: `Bearer ${authSession?.access_token || SUPABASE_CONFIG.anonKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(details || "Supabase request failed.");
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

async function readSupabaseState() {
  const events = await supabaseRequest("events?select=*&order=updated_at.desc");
  const eventRows = events.map(fromSupabaseEvent);
  const event = selectedEventId ? eventRows.find((item) => item.id === selectedEventId) || null : null;
  const [performances, practiceLogs] = event
    ? await Promise.all([
        supabaseRequest(`performances?select=*&event_id=eq.${encodeURIComponent(event.id)}&order=created_at.desc`),
        supabaseRequest(`practice_logs?select=*&event_id=eq.${encodeURIComponent(event.id)}&order=created_at.desc&limit=80`),
      ])
    : [[], []];

  const performanceRows = performances.map(fromSupabasePerformance);
  const practiceRows = practiceLogs.map(fromSupabasePracticeLog);
  const summaries = await Promise.all(
    eventRows.map(async (item) => {
      const [eventPerformances, eventLogs] = await Promise.all([
        supabaseRequest(`performances?select=id,finalized&event_id=eq.${encodeURIComponent(item.id)}`),
        supabaseRequest(`practice_logs?select=id&event_id=eq.${encodeURIComponent(item.id)}`),
      ]);
      return {
        ...item,
        entries: eventPerformances.length,
        finalized: eventPerformances.filter((performance) => performance.finalized).length,
        practiceLogs: eventLogs.length,
      };
    }),
  );

  return normalizeState({
    csrfToken: "supabase",
    events: summaries,
    event,
    metrics: {
      entries: performanceRows.length,
      pending: performanceRows.filter((item) => !item.finalized).length,
      finalized: performanceRows.filter((item) => item.finalized).length,
      votes: performanceRows.reduce((total, item) => total + (Array.isArray(item.votes) ? item.votes.length : 0), 0),
      practiceLogs: practiceRows.length,
      homePracticedPeople: new Set(practiceRows.filter((log) => log.practicedAtHome).map((log) => log.person)).size,
    },
    performances: performanceRows.sort((left, right) =>
      (Number(Boolean(left.finalized)) - Number(Boolean(right.finalized))) ||
      ((Array.isArray(right.votes) ? right.votes.length : 0) - (Array.isArray(left.votes) ? left.votes.length : 0)) ||
      String(right.createdAt || "").localeCompare(String(left.createdAt || "")),
    ),
    practiceLogs: practiceRows,
  });
}

async function supabaseApi(path, payload) {
  const now = new Date().toISOString();

  if (path === "/api/events") {
    const rows = await supabaseRequest("rpc/create_event_with_code", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        p_name: cleanInput(payload.name, 80) || "New Event",
        p_event_date: cleanInput(payload.eventDate, 20) || null,
        p_practice_goal: clampNumber(payload.practiceGoalPerPerson, 1, 100, 5),
        p_event_code: cleanInput(payload.eventCode, 64),
      }),
    });
    return { ok: true, event: fromSupabaseEvent(rows[0]) };
  }

  if (path === "/api/join") {
    const rows = await supabaseRequest("rpc/join_event_with_code", {
      method: "POST",
      body: JSON.stringify({ p_event_code: cleanInput(payload.eventCode, 64) }),
    });
    return { ok: true, eventId: rows?.[0]?.event_id || rows?.event_id };
  }

  if (path === "/api/dancer-group") {
    await supabaseRequest(`performances?id=eq.${encodeURIComponent(payload.performanceId)}&event_id=eq.${encodeURIComponent(payload.eventId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ dancer_group: cleanInput(payload.dancerGroup, 40) }),
    });
    return { ok: true };
  }

  if (path === "/api/event") {
    await supabaseRequest(`events?id=eq.${encodeURIComponent(payload.eventId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        name: cleanInput(payload.name, 80) || "Event Planner",
        event_date: cleanInput(payload.eventDate, 20) || null,
        practice_goal_per_person: clampNumber(payload.practiceGoalPerPerson, 1, 100, 5),
      }),
    });
    return { ok: true };
  }

  if (path === "/api/performances") {
    const rows = await supabaseRequest("performances?select=*", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        event_id: payload.eventId,
        title: cleanInput(payload.title, 100),
        dance_style: cleanInput(payload.danceStyle, 80),
        dancer_group: null,
        instagram_url: validateInstagramUrl(payload.instagramUrl),
        added_by: cleanInput(payload.addedBy, 60) || "Guest",
        notes: cleanInput(payload.notes, 500),
      }),
    });
    return { ok: true, performance: fromSupabasePerformance(rows[0]) };
  }

  if (path === "/api/performance") {
    await supabaseRequest(`performances?id=eq.${encodeURIComponent(payload.performanceId)}&event_id=eq.${encodeURIComponent(payload.eventId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        title: cleanInput(payload.title, 100),
        dance_style: cleanInput(payload.danceStyle, 80),
        instagram_url: validateInstagramUrl(payload.instagramUrl),
        added_by: cleanInput(payload.addedBy, 60) || "Guest",
        notes: cleanInput(payload.notes, 500),
      }),
    });
    return { ok: true };
  }

  if (path === "/api/delete-performance") {
    const deleted = await supabaseRequest(`performances?id=eq.${encodeURIComponent(payload.performanceId)}&event_id=eq.${encodeURIComponent(payload.eventId)}&select=id`, {
      method: "DELETE",
      headers: { Prefer: "return=representation" },
    });
    if (!Array.isArray(deleted) || deleted.length !== 1) {
      throw new Error("This link was not deleted. Run the latest Supabase schema to enable the delete permission, then try again.");
    }
    return { ok: true };
  }

  if (path === "/api/vote") {
    const rows = await supabaseRequest(`performances?select=id,votes&event_id=eq.${encodeURIComponent(payload.eventId)}&id=eq.${encodeURIComponent(payload.performanceId)}`);
    const performance = rows[0];
    if (!performance) {
      throw new Error("Performance not found.");
    }
    const voter = cleanInput(payload.voter, 60);
    if (!voter) {
      throw new Error("Name is required.");
    }
    const votes = Array.isArray(performance.votes) ? performance.votes : [];
    if (!votes.includes(voter)) {
      votes.push(voter);
    }
    await supabaseRequest(`performances?id=eq.${encodeURIComponent(payload.performanceId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ votes }),
    });
    return { ok: true, votes: votes.length };
  }

  if (path === "/api/finalize") {
    await supabaseRequest(`performances?id=eq.${encodeURIComponent(payload.performanceId)}&event_id=eq.${encodeURIComponent(payload.eventId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        finalized: true,
        finalized_by: cleanInput(payload.finalizer, 60),
        finalized_at: now,
      }),
    });
    return { ok: true };
  }

  if (path === "/api/practice") {
    await supabaseRequest("practice_logs", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        event_id: payload.eventId,
        performance_id: cleanInput(payload.performanceId, 40) || null,
        person: cleanInput(payload.person, 60) || "Guest",
        minutes: clampNumber(payload.minutes, 1, 600, 20),
        practiced_at_home: Boolean(payload.practicedAtHome),
        notes: cleanInput(payload.notes, 180),
      }),
    });
    return { ok: true };
  }

  throw new Error("Unknown endpoint.");
}

function fromSupabaseEvent(row) {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    eventDate: row.event_date || "",
    practiceGoalPerPerson: row.practice_goal_per_person || 5,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fromSupabasePerformance(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    title: row.title,
    danceStyle: row.dance_style,
    dancerGroup: row.dancer_group || "",
    instagramUrl: row.instagram_url,
    addedBy: row.added_by,
    notes: row.notes || "",
    votes: Array.isArray(row.votes) ? row.votes : [],
    finalized: Boolean(row.finalized),
    finalizedBy: row.finalized_by,
    finalizedAt: row.finalized_at,
    createdAt: row.created_at,
  };
}

function fromSupabasePracticeLog(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    performanceId: row.performance_id || "",
    person: row.person,
    minutes: row.minutes,
    practicedAtHome: Boolean(row.practiced_at_home),
    notes: row.notes || "",
    createdAt: row.created_at,
  };
}

function readStaticStore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STATIC_STORE_KEY) || "{}");
    return {
      events: Array.isArray(saved.events) ? saved.events : [],
      performances: Array.isArray(saved.performances) ? saved.performances : [],
      practiceLogs: Array.isArray(saved.practiceLogs) ? saved.practiceLogs : [],
    };
  } catch (error) {
    return { events: [], performances: [], practiceLogs: [] };
  }
}

function writeStaticStore(store) {
  localStorage.setItem(STATIC_STORE_KEY, JSON.stringify(store));
}

function readStaticState() {
  const store = readStaticStore();
  const event = selectedEventId ? store.events.find((item) => item.id === selectedEventId) || null : null;
  return publicStaticState(store, event);
}

function publicStaticState(store, event) {
  const eventPerformances = event ? store.performances.filter((item) => item.eventId === event.id) : [];
  const eventLogs = event ? store.practiceLogs.filter((item) => item.eventId === event.id) : [];
  const summaries = store.events
    .map((item) => {
      const performances = store.performances.filter((performance) => performance.eventId === item.id);
      const logs = store.practiceLogs.filter((log) => log.eventId === item.id);
      return {
        id: item.id,
        name: item.name,
        eventDate: item.eventDate,
        practiceGoalPerPerson: item.practiceGoalPerPerson,
        entries: performances.length,
        finalized: performances.filter((performance) => performance.finalized).length,
        practiceLogs: logs.length,
        updatedAt: item.updatedAt || item.createdAt || "",
      };
    })
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));

  return normalizeState({
    csrfToken: "static",
    events: summaries,
    event,
    metrics: {
      entries: eventPerformances.length,
      pending: eventPerformances.filter((item) => !item.finalized).length,
      finalized: eventPerformances.filter((item) => item.finalized).length,
      votes: eventPerformances.reduce((total, item) => total + (Array.isArray(item.votes) ? item.votes.length : 0), 0),
      practiceLogs: eventLogs.length,
      homePracticedPeople: new Set(eventLogs.filter((log) => log.practicedAtHome).map((log) => log.person)).size,
    },
    performances: eventPerformances.sort((left, right) =>
      (Number(Boolean(left.finalized)) - Number(Boolean(right.finalized))) ||
      ((Array.isArray(right.votes) ? right.votes.length : 0) - (Array.isArray(left.votes) ? left.votes.length : 0)) ||
      String(right.createdAt || "").localeCompare(String(left.createdAt || "")),
    ),
    practiceLogs: eventLogs.sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || ""))).slice(0, 80),
  });
}

function staticApi(path, payload) {
  const store = readStaticStore();
  const now = new Date().toISOString();
  const event = payload.eventId ? store.events.find((item) => item.id === payload.eventId) : null;

  if (path === "/api/events") {
    const created = {
      id: createId(),
      name: cleanInput(payload.name, 80) || "New Event",
      eventDate: cleanInput(payload.eventDate, 20),
      practiceGoalPerPerson: clampNumber(payload.practiceGoalPerPerson, 1, 100, 5),
      createdAt: now,
      updatedAt: now,
    };
    store.events.push(created);
    writeStaticStore(store);
    return { ok: true, event: created };
  }

  if (!event) {
    throw new Error("Event not found.");
  }

  if (path === "/api/event") {
    event.name = cleanInput(payload.name, 80) || "Event Planner";
    event.eventDate = cleanInput(payload.eventDate, 20);
    event.practiceGoalPerPerson = clampNumber(payload.practiceGoalPerPerson, 1, 100, 5);
    event.updatedAt = now;
    writeStaticStore(store);
    return { ok: true };
  }

  if (path === "/api/dancer-group") {
    const performance = store.performances.find((item) => item.eventId === event.id && item.id === payload.performanceId);
    if (!performance) throw new Error("Performance not found.");
    performance.dancerGroup = cleanInput(payload.dancerGroup, 40);
    event.updatedAt = now;
    writeStaticStore(store);
    return { ok: true };
  }

  if (path === "/api/performances") {
    if (store.performances.length >= MAX_STATIC_ENTRIES) {
      throw new Error("The performance list is full.");
    }
    const title = cleanInput(payload.title, 100);
    const danceStyle = cleanInput(payload.danceStyle, 80);
    if (!title || !danceStyle) {
      throw new Error("Title and dance style are required.");
    }
    const performance = {
      id: createId(),
      eventId: event.id,
      title,
      danceStyle,
      dancerGroup: "",
      instagramUrl: validateInstagramUrl(payload.instagramUrl),
      addedBy: cleanInput(payload.addedBy, 60) || "Guest",
      notes: cleanInput(payload.notes, 500),
      votes: [],
      finalized: false,
      createdAt: now,
    };
    store.performances.push(performance);
    event.updatedAt = now;
    writeStaticStore(store);
    return { ok: true, performance };
  }

  if (path === "/api/performance") {
    const performance = store.performances.find((item) => item.eventId === event.id && item.id === payload.performanceId);
    if (!performance) throw new Error("Performance not found.");
    performance.title = cleanInput(payload.title, 100);
    performance.danceStyle = cleanInput(payload.danceStyle, 80);
    performance.instagramUrl = validateInstagramUrl(payload.instagramUrl);
    performance.addedBy = cleanInput(payload.addedBy, 60) || "Guest";
    performance.notes = cleanInput(payload.notes, 500);
    event.updatedAt = now;
    writeStaticStore(store);
    return { ok: true };
  }

  if (path === "/api/delete-performance") {
    const index = store.performances.findIndex((item) => item.eventId === event.id && item.id === payload.performanceId);
    if (index === -1) throw new Error("Performance not found.");
    store.performances.splice(index, 1);
    event.updatedAt = now;
    writeStaticStore(store);
    return { ok: true };
  }

  if (path === "/api/vote") {
    const performance = store.performances.find((item) => item.eventId === event.id && item.id === payload.performanceId);
    if (!performance) {
      throw new Error("Performance not found.");
    }
    const voter = cleanInput(payload.voter, 60);
    if (!voter) {
      throw new Error("Name is required.");
    }
    performance.votes = Array.isArray(performance.votes) ? performance.votes : [];
    if (!performance.votes.includes(voter)) {
      performance.votes.push(voter);
    }
    event.updatedAt = now;
    writeStaticStore(store);
    return { ok: true, votes: performance.votes.length };
  }

  if (path === "/api/finalize") {
    const performance = store.performances.find((item) => item.eventId === event.id && item.id === payload.performanceId);
    if (!performance) {
      throw new Error("Performance not found.");
    }
    performance.finalized = true;
    performance.finalizedBy = cleanInput(payload.finalizer, 60);
    performance.finalizedAt = now;
    event.updatedAt = now;
    writeStaticStore(store);
    return { ok: true };
  }

  if (path === "/api/practice") {
    const performanceId = cleanInput(payload.performanceId, 40);
    if (performanceId && !store.performances.some((item) => item.eventId === event.id && item.id === performanceId)) {
      throw new Error("Performance not found.");
    }
    store.practiceLogs.push({
      id: createId(),
      eventId: event.id,
      person: cleanInput(payload.person, 60) || "Guest",
      performanceId,
      minutes: clampNumber(payload.minutes, 1, 600, 20),
      practicedAtHome: Boolean(payload.practicedAtHome),
      notes: cleanInput(payload.notes, 180),
      createdAt: now,
    });
    event.updatedAt = now;
    writeStaticStore(store);
    return { ok: true };
  }

  throw new Error("Unknown endpoint.");
}

function createId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cleanInput(value, limit) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, limit);
}

function clampNumber(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}

function validateInstagramUrl(value) {
  const url = cleanInput(value, 500);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(parsed.hostname.toLowerCase()) || parsed.pathname === "/") {
      throw new Error();
    }
  } catch (error) {
    throw new Error("Use a public https://instagram.com/... link.");
  }
  return url;
}

function normalizeState(data) {
  const performances = Array.isArray(data.performances) ? data.performances : [];
  const practiceLogs = Array.isArray(data.practiceLogs) ? data.practiceLogs : [];
  let events = Array.isArray(data.events) ? data.events : [];
  let event = data.event && typeof data.event === "object" ? data.event : null;

  if (events.length === 0 && event) {
    const eventId = event.id || selectedEventId || "main-event";
    events = [
      {
        id: eventId,
        name: event.name || "Event Planner",
        eventDate: event.eventDate || "",
        practiceGoalPerPerson: event.practiceGoalPerPerson || 5,
        entries: performances.length,
        finalized: performances.filter((item) => item.finalized).length,
        practiceLogs: practiceLogs.length,
        updatedAt: event.updatedAt || "",
      },
    ];
    event = { ...event, id: eventId };
  }

  return {
    csrfToken: data.csrfToken || "",
    events,
    event,
    metrics: {
      entries: Number(data.metrics?.entries ?? performances.length),
      pending: Number(data.metrics?.pending ?? performances.filter((item) => !item.finalized).length),
      finalized: Number(data.metrics?.finalized ?? performances.filter((item) => item.finalized).length),
      votes: Number(data.metrics?.votes ?? performances.reduce((total, item) => total + (Array.isArray(item.votes) ? item.votes.length : 0), 0)),
      practiceLogs: Number(data.metrics?.practiceLogs ?? practiceLogs.length),
      homePracticedPeople: Number(data.metrics?.homePracticedPeople ?? 0),
    },
    performances,
    practiceLogs,
  };
}

function updateUrl() {
  const url = selectedEventId ? `?event=${encodeURIComponent(selectedEventId)}` : window.location.pathname;
  window.history.replaceState({}, "", url);
}

function render() {
  const hasSelectedEvent = Boolean(selectedEventId && state.event);
  nodes.joinEventForm.hidden = !supabaseMode;
  nodes.homeView.classList.toggle("hidden", hasSelectedEvent);
  nodes.plannerView.classList.toggle("hidden", !hasSelectedEvent);
  nodes.plannerTabs.classList.toggle("hidden", !hasSelectedEvent);
  nodes.eventName.textContent = hasSelectedEvent ? state.event.name : "Event Planner";
  renderEventCards();

  if (!hasSelectedEvent) {
    return;
  }

  renderEvent();
  renderStats();
  renderPracticeOptions();
  renderMainPanel();
}

function renderEventCards() {
  if (state.events.length === 0) {
    nodes.eventCards.innerHTML = `<div class="empty large">No events yet. Create the first event to start collecting performance links.</div>`;
    return;
  }

  nodes.eventCards.replaceChildren(
    ...state.events.map((event) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "event-card";
      card.addEventListener("click", () => selectEvent(event.id));

      const top = document.createElement("div");
      top.className = "event-card-top";
      const avatar = document.createElement("span");
      avatar.className = "avatar";
      avatar.textContent = initials(event.name);
      const meta = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = event.name;
      const date = document.createElement("span");
      date.textContent = event.eventDate ? `Event date: ${event.eventDate}` : "Date not set";
      meta.append(title, date);
      top.append(avatar, meta);

      const stats = document.createElement("div");
      stats.className = "event-card-stats";
      stats.append(statChip("Entries", event.entries), statChip("Final", event.finalized), statChip("Practice", event.practiceLogs));

      const action = document.createElement("span");
      action.className = "open-event";
      action.textContent = "Open planner";
      card.append(top, stats, action);
      return card;
    }),
  );
}

function statChip(label, value) {
  const chip = document.createElement("span");
  chip.innerHTML = `<strong>${value}</strong>${label}`;
  return chip;
}

function selectEvent(eventId) {
  selectedEventId = eventId;
  activeView = "all";
  document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item.dataset.view === "all"));
  updateUrl();
  loadState().catch((error) => setStatus(error.message));
}

function showHome() {
  selectedEventId = "";
  updateUrl();
  loadState().catch((error) => setStatus(error.message));
}

function renderEvent() {
  const event = state.event;
  const dateText = event.eventDate ? `Event date: ${event.eventDate}` : "Event date not set";
  nodes.plannerTitle.textContent = event.name || "Event Planner";
  nodes.eventMeta.textContent = `${dateText} | Practice goal: ${event.practiceGoalPerPerson || 5} check-ins per person`;
  nodes.eventForm.name.value = event.name || "";
  nodes.eventForm.eventDate.value = event.eventDate || "";
  nodes.eventForm.practiceGoalPerPerson.value = event.practiceGoalPerPerson || 5;
}

function renderStats() {
  nodes.entryCount.textContent = state.metrics.entries;
  nodes.finalizedCount.textContent = state.metrics.finalized;
  nodes.voteCount.textContent = state.metrics.votes;
  nodes.practiceCount.textContent = state.metrics.homePracticedPeople;
}

function filteredPerformances() {
  if (activeView === "finalized") {
    return state.performances.filter((item) => item.finalized);
  }
  return state.performances;
}

function renderMainPanel() {
  const isPractice = activeView === "practice";
  nodes.cards.classList.toggle("hidden", isPractice);
  nodes.practiceView.classList.toggle("hidden", !isPractice);

  if (isPractice) {
    nodes.panelTitle.textContent = "Practice Tracker";
    nodes.panelSubtitle.textContent = "Log home practice and keep the group ready before event day.";
    renderPracticeLogs();
    return;
  }

  nodes.panelTitle.textContent = activeView === "finalized" ? "Finalized Performance List" : "Performance Links";
  nodes.panelSubtitle.textContent =
    activeView === "finalized"
      ? "Locked-in dances for the event program."
      : "Vote on Instagram references, finalize dances, and keep the shortlist moving.";

  const performances = filteredPerformances();
  if (performances.length === 0) {
    nodes.cards.innerHTML = `<div class="empty">No performances in this view yet.</div>`;
    return;
  }

  nodes.cards.replaceChildren(...performances.map(renderCard));
}

function renderCard(item) {
  const card = document.createElement("article");
  card.className = `card ${item.finalized ? "finalized" : ""}`;
  const votes = Array.isArray(item.votes) ? item.votes : [];

  const content = document.createElement("div");
  content.className = "post-body";
  const postHeader = document.createElement("div");
  postHeader.className = "post-header";
  const heading = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = item.title;
  const author = document.createElement("span");
  author.textContent = `Posted by ${item.addedBy}`;
  heading.append(title, author);
  postHeader.append(heading);
  if (item.finalized) {
    postHeader.append(pill("Finalized"));
  }

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.append(pill(item.danceStyle), textSpan(`${votes.length} vote${votes.length === 1 ? "" : "s"}`));

  const dancers = document.createElement("label");
  dancers.className = "dancer-group";
  const dancerLabel = document.createElement("span");
  dancerLabel.textContent = "Who will dance?";
  const dancerSelect = document.createElement("select");
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose dancers";
  dancerSelect.append(placeholder, ...DANCER_GROUPS.map((group) => {
    const option = document.createElement("option");
    option.value = group;
    option.textContent = group;
    return option;
  }));
  dancerSelect.value = item.dancerGroup || "";
  dancerSelect.addEventListener("change", () => {
    updateDancerGroup(item.id, dancerSelect.value).catch((error) => {
      setStatus(error.message);
      dancerSelect.value = item.dancerGroup || "";
    });
  });
  dancers.append(dancerLabel, dancerSelect);
  content.append(postHeader, meta, dancers);
  if (item.notes) {
    const notes = document.createElement("p");
    notes.className = "performance-notes";
    notes.textContent = item.notes;
    content.append(notes);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const open = document.createElement("a");
  open.href = item.instagramUrl;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.textContent = "Open reference";
  open.className = "open-reference";
  const vote = actionButton(`Vote (${votes.length})`, () => voteFor(item.id));
  const edit = actionButton("Edit", () => editPerformance(item));
  const remove = actionButton("Delete", () => deletePerformance(item.id), "destructive");
  const finalize = actionButton("Finalize", () => finalizeItem(item.id), "danger");
  actions.append(open, vote, edit, remove);
  if (!item.finalized) {
    actions.append(finalize);
  }
  content.append(actions);

  card.append(content);
  return card;
}

function initials(name) {
  return String(name || "EP")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

function pill(text) {
  const element = document.createElement("span");
  element.className = "pill";
  element.textContent = text;
  return element;
}

function textSpan(text) {
  const element = document.createElement("span");
  element.textContent = text;
  return element;
}

function actionButton(label, handler, className = "secondary") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", () => {
    Promise.resolve(handler()).catch((error) => {
      setStatus(error.message || "That action could not be completed.");
    });
  });
  return button;
}

function getPersonName(promptText) {
  const saved = localStorage.getItem("eventPlannerName") || localStorage.getItem("dancePartyName") || "";
  const name = window.prompt(promptText, saved);
  if (name) {
    localStorage.setItem("eventPlannerName", name);
  }
  return name;
}

async function voteFor(performanceId) {
  const voter = getPersonName("Your name for this vote");
  if (!voter) return;
  await api("/api/vote", { eventId: selectedEventId, performanceId, voter });
  setStatus("Vote saved");
  await loadState();
}

async function finalizeItem(performanceId) {
  const finalizer = getPersonName("Your name to finalize this dance");
  if (!finalizer) return;
  await api("/api/finalize", { eventId: selectedEventId, performanceId, finalizer });
  setStatus("Performance finalized");
  await loadState();
}

async function updateDancerGroup(performanceId, dancerGroup) {
  await api("/api/dancer-group", { eventId: selectedEventId, performanceId, dancerGroup });
  setStatus("Dancers updated");
  await loadState();
}

async function editPerformance(item) {
  const title = window.prompt("Performance title", item.title);
  if (title === null) return;
  const danceStyle = window.prompt("Dance style", item.danceStyle);
  if (danceStyle === null) return;
  const instagramUrl = window.prompt("Instagram link", item.instagramUrl);
  if (instagramUrl === null) return;
  const addedBy = window.prompt("Added by", item.addedBy);
  if (addedBy === null) return;
  const notes = window.prompt("Notes", item.notes || "");
  if (notes === null) return;
  await api("/api/performance", { eventId: selectedEventId, performanceId: item.id, title, danceStyle, instagramUrl, addedBy, notes });
  setStatus("Performance updated");
  await loadState();
}

async function deletePerformance(performanceId) {
  if (!window.confirm("Delete this performance link? This cannot be undone.")) return;
  await api("/api/delete-performance", { eventId: selectedEventId, performanceId });
  setStatus("Performance deleted");
  await loadState();
}

function renderPracticeOptions() {
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "General practice";
  const options = state.performances.map((item) => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.title} (${item.danceStyle})`;
    return option;
  });
  nodes.practicePerformance.replaceChildren(placeholder, ...options);
}

function renderPracticeLogs() {
  if (state.practiceLogs.length === 0) {
    nodes.practiceLogs.innerHTML = `<div class="empty">No practice check-ins yet.</div>`;
    return;
  }
  nodes.practiceLogs.replaceChildren(
    ...state.practiceLogs.map((log) => {
      const item = state.performances.find((performance) => performance.id === log.performanceId);
      const element = document.createElement("div");
      element.className = "log";
      const avatar = document.createElement("div");
      avatar.className = "avatar small";
      avatar.textContent = initials(log.person);
      const body = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = `${log.person} practiced ${log.minutes} minutes`;
      const meta = document.createElement("div");
      meta.className = "log-meta";
      meta.textContent = `${item ? item.title : "General practice"} | ${log.practicedAtHome ? "Home" : "Group"} | ${new Date(log.createdAt).toLocaleString()}`;
      const notes = document.createElement("p");
      notes.textContent = log.notes || "";
      body.append(title, meta, notes);
      element.append(avatar, body);
      return element;
    }),
  );
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    activeView = button.dataset.view;
    renderMainPanel();
  });
});

nodes.homeButton.addEventListener("click", showHome);
nodes.backButton.addEventListener("click", showHome);

nodes.createEventForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(nodes.createEventForm);
  const result = await api("/api/events", Object.fromEntries(form));
  nodes.createEventForm.reset();
  selectedEventId = result.event.id;
  setStatus("Event created");
  updateUrl();
  await loadState();
});

nodes.joinEventForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(nodes.joinEventForm);
  const result = await api("/api/join", { eventCode: form.get("eventCode") });
  nodes.joinEventForm.reset();
  selectedEventId = result.eventId;
  updateUrl();
  setStatus("Joined event");
  await loadState();
});

nodes.eventForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(nodes.eventForm);
  await api("/api/event", { ...Object.fromEntries(form), eventId: selectedEventId });
  setStatus("Event saved");
  await loadState();
});

nodes.performanceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(nodes.performanceForm);
  await api("/api/performances", { ...Object.fromEntries(form), eventId: selectedEventId });
  nodes.performanceForm.reset();
  setStatus("Performance added");
  await loadState();
});

nodes.practiceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(nodes.practiceForm);
  const payload = Object.fromEntries(form);
  payload.eventId = selectedEventId;
  payload.practicedAtHome = form.has("practicedAtHome");
  await api("/api/practice", payload);
  nodes.practiceForm.reset();
  setStatus("Practice logged");
  await loadState();
});

async function initialize() {
  if (isSupabaseConfigured()) {
    await restoreSession();
    if (!currentUser()) {
      const session = await supabaseAuth("signup", { method: "POST", body: JSON.stringify({}) });
      const anonymousSession = session.session || session;
      if (!anonymousSession.access_token) throw new Error("Anonymous sign-ins are not enabled in Supabase yet.");
      setStoredSession(anonymousSession);
    }
  }
  await loadState();
}

const initialization = initialize();

initialization.catch((error) => {
  setStatus(error.message);
});
