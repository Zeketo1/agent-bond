// Reads the agent-bond contract straight from NEAR testnet RPC. No backend, no build step.

const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
const POLL_MS = 3000;
const YOCTO = 10n ** 24n;
const SLASH_KEEP = 0.75; // each upheld challenge keeps 75% of the bond

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const app = $("app");
const live = $("live");

let contract = params.get("contract") || "";
let selectedAgent = params.get("agent") || "";
let seen = null; // payment ids already on screen
let lastOk = 0;
let timer;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const near = (yocto, digits = 3) => {
  const v = BigInt(yocto);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, "0").slice(0, digits);
  return `${whole}.${frac}`;
};
const nearNum = (yocto) => Number(BigInt(yocto) / 10n ** 15n) / 1e9;

async function view(method, args = {}) {
  const args_base64 = btoa(JSON.stringify(args));
  let last;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "dash",
          method: "query",
          params: { request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method, args_base64 },
        }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.data || j.error.message || "rpc error");
      if (j.result.error) throw new Error(j.result.error);
      return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

function vesselHtml(agent, payments) {
  const bond = nearNum(agent.bond);
  const slashes = payments.filter((p) => p.agent === agent.id && p.status === "Rejected").length;
  const original = bond / Math.pow(SLASH_KEEP, slashes);
  const boost = Math.min(Math.max(agent.reputation, 0), 20);
  const cap = (bond / 10) * (10 + boost);
  const inflight = payments.filter((p) => p.agent === agent.id && (p.status === "Pending" || p.status === "Challenged"));
  const pendingTotal = nearNum(agent.pending_total);
  const max = Math.max(original, cap, pendingTotal, 0.001) * 1.15;
  const h = (n) => `${((n / max) * 100).toFixed(2)}%`;

  const slashed = original - bond;
  const bondCol =
    `<div class="col"><div class="bond-solid" style="height:${h(bond)}" title="Bond left: ${bond.toFixed(3)} NEAR"></div>` +
    (slashed > 0.0005 ? `<div class="bond-slashed" style="height:${h(slashed)}" title="Slashed: ${slashed.toFixed(3)} NEAR"></div>` : "") +
    `<span class="col-name">Bond</span></div>`;
  const blocks = inflight
    .map((p) => `<div class="block ${p.status === "Challenged" ? "challenged" : ""}" style="height:${h(nearNum(p.amount))}" title="${esc(p.status)}: ${near(p.amount)} NEAR"></div>`)
    .join("");
  const flightCol = `<div class="col">${blocks}<span class="col-name">In the challenge window</span></div>`;

  return (
    `<div class="vessel" role="img" aria-label="Bond ${bond.toFixed(3)} NEAR, exposure cap ${cap.toFixed(3)} NEAR, ${pendingTotal.toFixed(3)} NEAR in the challenge window">` +
    bondCol + flightCol +
    `<div class="cap" style="bottom:${h(cap)}"><span>Cap ${cap.toFixed(2)} NEAR</span></div></div>`
  );
}

function rowHtml(p, fresh) {
  const t = new Date(Number(BigInt(p.created_at) / 1_000_000n)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const evidence =
    p.status === "Rejected" && p.evidence
      ? `<p class="evidence">Guardian: ${esc(p.evidence)}</p>`
      : p.status === "Challenged"
        ? `<p class="evidence">Challenged by ${esc(p.challenger)}. Waiting for the guardian.</p>`
        : "";
  return (
    `<li class="row${fresh ? " fresh" : ""}"><time>${esc(t)}</time>` +
    `<div class="who"><div class="amount">${near(p.amount)} NEAR</div><div class="to" title="${esc(p.to)}">to ${esc(p.to)}</div>` +
    (p.memo ? `<p class="memo">${esc(p.memo)}</p>` : "") + evidence + `</div>` +
    `<span class="status ${esc(p.status)}">${esc(p.status)}</span></li>`
  );
}

function render(agents, payments, pool) {
  const agent = agents.find((a) => a.id === selectedAgent) ?? agents[0];
  if (!agent) {
    app.innerHTML = `<p class="empty">No agent is registered on this contract yet. Register one with <code>register_agent</code> and it will show up here.</p>`;
    return;
  }
  selectedAgent = agent.id;
  const mine = payments.filter((p) => p.agent === agent.id);
  const isFirst = seen === null;
  const fresh = new Set(isFirst ? [] : mine.filter((p) => !seen.has(p.id)).map((p) => p.id));
  seen = new Set(mine.map((p) => p.id));

  const picker =
    agents.length > 1
      ? `<p class="agent-pick"><select aria-label="Agent" id="agent-select">${agents
          .map((a) => `<option value="${esc(a.id)}"${a.id === agent.id ? " selected" : ""}>${esc(a.id)}</option>`)
          .join("")}</select></p>`
      : "";
  const frozen = agent.frozen
    ? `<div class="notice" role="alert"><strong>${esc(agent.id)} is frozen</strong>It was slashed and cannot pay anyone until its sponsor unfreezes it.</div>`
    : "";

  app.innerHTML =
    frozen +
    `<div class="layout"><section aria-labelledby="bond-h"><h2 id="bond-h">${esc(agent.id)}</h2>` +
    `<p class="sub">Backed by ${esc(agent.sponsor)}</p>${picker}` +
    vesselHtml(agent, payments) +
    `<dl class="facts">` +
    `<dt>Bond left</dt><dd>${near(agent.bond)} NEAR</dd>` +
    `<dt>Budget to spend</dt><dd>${near(agent.budget)} NEAR</dd>` +
    `<dt>Reputation</dt><dd class="${agent.reputation < 0 ? "slash" : ""}">${agent.reputation}</dd>` +
    `<dt>Insurance pool</dt><dd>${near(pool)} NEAR</dd></dl></section>` +
    `<section aria-labelledby="pay-h"><h2 id="pay-h">Payments</h2><p class="sub">Newest first. Large payments wait for a challenge before they leave the contract.</p>` +
    (mine.length
      ? `<ol class="ledger">${mine.map((p) => rowHtml(p, fresh.has(p.id))).join("")}</ol>`
      : `<p class="empty">This agent has not made a payment yet.</p>`) +
    `</section></div>`;

  const sel = $("agent-select");
  if (sel) sel.onchange = () => { selectedAgent = sel.value; seen = null; poll(); };
}

async function poll() {
  clearTimeout(timer);
  if (!contract) {
    app.innerHTML = `<p class="empty">Enter the contract account to watch. The setup script prints it, for example <code>bond-1234.testnet</code>.</p>`;
    live.textContent = "";
    return;
  }
  try {
    const [list, payments, pool] = await Promise.all([
      view("list_agents", { from_index: 0, limit: 20 }),
      view("recent_payments", { limit: 60 }),
      view("get_insurance_pool"),
    ]);
    const agents = list.map(([id, a]) => ({ id, ...a }));
    render(agents, payments, pool);
    lastOk = Date.now();
    live.classList.remove("bad");
  } catch (e) {
    live.classList.add("bad");
    live.textContent = `Can't read ${contract}. Check the account name and that the contract is deployed on testnet.`;
    timer = setTimeout(poll, POLL_MS * 2);
    return;
  }
  timer = setTimeout(poll, POLL_MS);
}

setInterval(() => {
  if (contract && lastOk && !live.classList.contains("bad")) {
    const s = Math.round((Date.now() - lastOk) / 1000);
    live.textContent = `Live, updated ${s}s ago`;
  }
}, 1000);

$("contract").value = contract;
$("watch").addEventListener("submit", (e) => {
  e.preventDefault();
  contract = $("contract").value.trim();
  selectedAgent = "";
  seen = null;
  lastOk = 0;
  const u = new URL(location.href);
  u.searchParams.set("contract", contract);
  history.replaceState(null, "", u);
  poll();
});

// Optional default contract, written by the setup step: dashboard/config.json {"contract": "..."}
if (!contract) {
  try {
    const cfg = await (await fetch("config.json")).json();
    if (cfg.contract) { contract = cfg.contract; $("contract").value = contract; }
  } catch { /* no config, show the prompt */ }
}
poll();
