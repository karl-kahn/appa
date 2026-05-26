// Appa UI shell. Loads team.json, lets user pick, renders chat + module tabs.

const state = {
  members: [],
  currentUserId: null,
  tabs: [],
  activeTab: "chat",
  sessionName: "",
};

// Wrap fetch so every request carries X-Appa-User. The dev-auth resolver
// on the server reads this header (or the body field, for POSTs); a real
// deployment swaps that resolver for one backed by a proxy/SSO.
function aFetch(input, init = {}) {
  const headers = new Headers(init.headers || {});
  if (state.currentUserId) headers.set("X-Appa-User", state.currentUserId);
  return fetch(input, { ...init, headers });
}

async function init() {
  // /api/bootstrap is the unauthenticated picker source — it ships
  // id+name+role only so the UI can render before identity is set.
  // Once a user is picked, all subsequent requests carry X-Appa-User.
  const teamData = await fetch("/api/bootstrap").then((r) => r.json());
  state.members = teamData.members ?? [];
  const url = new URL(window.location.href);
  const urlUser = url.searchParams.get("asUserId");
  const initial = urlUser
    ? state.members.find((m) => m.id === urlUser)
    : state.members[0];
  if (initial) {
    state.currentUserId = initial.id;
    state.sessionName = initial.id;
    window.appaCurrentUserId = initial.id;
  }
  const tabsResp = await aFetch("/api/tabs").then((r) => r.json());
  state.tabs = tabsResp.tabs ?? [];
  buildUserPicker();
  buildTabs();
  selectTab("chat");
}

function buildUserPicker() {
  const sel = document.querySelector("#appa-user-select");
  sel.innerHTML = "";
  for (const m of state.members) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = `${m.name} (${m.role})`;
    sel.appendChild(opt);
  }
  if (state.members[0]) {
    state.currentUserId = state.members[0].id;
    state.sessionName = state.members[0].id;
    window.appaCurrentUserId = state.currentUserId;
    sel.value = state.currentUserId;
  }
  sel.addEventListener("change", () => {
    state.currentUserId = sel.value;
    state.sessionName = sel.value;
    window.appaCurrentUserId = state.currentUserId;
    clearChat();
  });
}

function buildTabs() {
  const nav = document.querySelector("#appa-tabs");
  nav.innerHTML = "";
  const baseTabs = [{ id: "chat", label: "Chat", moduleName: null }, ...state.tabs];
  for (const t of baseTabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = t.label;
    btn.dataset.tab = t.id;
    if (t.id === state.activeTab) btn.classList.add("active");
    btn.addEventListener("click", () => selectTab(t.id, t.moduleName));
    nav.appendChild(btn);
  }
}

async function selectTab(id, moduleName) {
  state.activeTab = id;
  document.querySelectorAll("#appa-tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === id);
  });
  const chat = document.querySelector("#appa-tab-chat");
  const host = document.querySelector("#appa-tab-host");
  if (id === "chat") {
    chat.hidden = false;
    host.hidden = true;
    return;
  }
  chat.hidden = true;
  host.hidden = false;
  host.innerHTML = "";
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  const url = `/tabs/${tab.moduleName ?? moduleName}/${tab.htmlPath ?? "tab.html"}`;
  try {
    const html = await fetch(url).then((r) => r.text());
    host.innerHTML = html;
    // Activate inline <script type="module"> tags — innerHTML doesn't run them.
    activateScripts(host);
  } catch (err) {
    host.textContent = `Failed to load tab: ${err.message}`;
  }
}

function activateScripts(root) {
  const scripts = root.querySelectorAll("script");
  for (const s of scripts) {
    const fresh = document.createElement("script");
    for (const a of s.attributes) fresh.setAttribute(a.name, a.value);
    fresh.textContent = s.textContent;
    s.replaceWith(fresh);
  }
}

function clearChat() {
  document.querySelector("#appa-chat-log").innerHTML = "";
}

function appendMsg(role, text) {
  const log = document.querySelector("#appa-chat-log");
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

async function send(message) {
  if (!message.trim()) return;
  appendMsg("user", message);
  const live = appendMsg("assistant", "");
  const res = await fetch(`/api/chat/${encodeURIComponent(state.sessionName)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, asUserId: state.currentUserId }),
  });
  if (!res.ok || !res.body) {
    appendMsg("error", `HTTP ${res.status}`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop() ?? "";
    for (const block of events) {
      const eventLine = block.split("\n").find((l) => l.startsWith("event:"));
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (!eventLine || !dataLine) continue;
      const evt = eventLine.slice(6).trim();
      const data = JSON.parse(dataLine.slice(5).trim());
      if (evt === "text") {
        live.textContent += data.text;
      } else if (evt === "tool") {
        const t = appendMsg("tool", `[${data.tool}] ${data.ok ? "✓" : "✗"} ${data.ok ? "" : data.error}`);
        t.scrollIntoView();
      } else if (evt === "error") {
        appendMsg("error", data.error ?? "error");
      } else if (evt === "done") {
        // no-op
      }
    }
  }
}

document.querySelector("#appa-chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.querySelector("#appa-chat-input");
  const text = input.value;
  input.value = "";
  send(text);
});

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div style="background:#2d1a1a;color:#ffb3b3;padding:0.6rem 1rem;">Init failed: ${err.message}</div>`,
  );
});
