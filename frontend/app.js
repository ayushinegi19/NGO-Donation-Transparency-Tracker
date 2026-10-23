// NGO Donation Tracker frontend (plain JS + ethers.js v6)
//
// Reads use a direct connection to the local Hardhat node, so anyone can view
// causes and the activity feed without a wallet. Transactions are signed with MetaMask.
//
// Roles (decided by the connected wallet):
//   NGO     - created the cause; spends its funds (each payment is audited automatically)
//   Owner   - platform admin; verifies cause creators (organisation / individual); cannot create causes
//   Donor   - anyone; donates, and claims a refund if the goal is missed
//
// Automatic audit of every expenditure:
//   - in the browser: the receipt PDF is read and its "Total Amount" and "Pay to wallet" lines must
//     match the amount and recipient entered (a smart contract cannot read a PDF);
//   - on-chain (enforced by the contract): receipt required and never reused, recipient is not the
//     NGO or the owner, amount within the remaining balance, goal reached, only the cause's NGO.

const RPC_URL = "http://127.0.0.1:8545";
const HARDHAT_CHAIN_ID = 31337;

const CATEGORIES = ["Disaster relief", "Education", "Health", "Food", "Other"];
const CREATOR_TYPES = ["Unverified", "Verified organisation", "Verified individual"];

let provider;       // read-only connection to the node
let readContract;   // read-only contract (no wallet needed)
let writeContract;  // contract connected to the MetaMask signer
let account;
let ownerAddress;
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;

const $ = (id) => document.getElementById(id);

function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").className = isError ? "error" : "";
}

// Escape on-chain strings before inserting into HTML
function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

const fmtEth = (wei) => `${ethers.formatEther(wei)} ETH`;
const fmtDate = (ts) => new Date(Number(ts) * 1000).toLocaleString();
const short = (addr) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// Only allow http(s) and ipfs links in receipt URLs
function safeLink(uri) {
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  return /^https?:\/\//i.test(uri) ? uri : null;
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - Number(ts)));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// SHA-256 of a file's bytes, as a bytes32 hex string
async function hashFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return ethers.sha256(bytes);
}

async function init() {
  const config = await (await fetch("contract-config.json")).json();
  provider = new ethers.JsonRpcProvider(RPC_URL);
  readContract = new ethers.Contract(config.address, config.abi, provider);
  $("contractAddress").textContent = config.address;
  ownerAddress = await readContract.owner();

  await refresh();
  // Refresh the page data on every new block, so totals and the feed update live
  provider.on("block", () => refresh());
}

async function refresh() {
  await Promise.all([loadCauses(), loadActivity()]);
}

async function connectWallet() {
  if (!window.ethereum) {
    setStatus("MetaMask not found. Please install it.", true);
    return;
  }
  const browserProvider = new ethers.BrowserProvider(window.ethereum);
  await browserProvider.send("eth_requestAccounts", []);

  const { chainId } = await browserProvider.getNetwork();
  if (Number(chainId) !== HARDHAT_CHAIN_ID) {
    setStatus(`Please switch MetaMask to the Hardhat network (chain ID ${HARDHAT_CHAIN_ID}).`, true);
    return;
  }

  const signer = await browserProvider.getSigner();
  account = await signer.getAddress();
  writeContract = readContract.connect(signer);
  $("account").textContent = `Connected: ${short(account)}`;
  $("connectBtn").style.display = "none";
  const isOwner = same(account, ownerAddress);
  $("ownerPanel").hidden = !isOwner;
  $("tabAdmin").hidden = !isOwner;
  $("adminLocked").hidden = isOwner;
  setStatus("");
  await refresh();
}

// Sends a transaction and waits for it to be mined, showing status messages
async function sendTx(label, txPromise) {
  if (!writeContract) {
    setStatus("Connect MetaMask first.", true);
    return false;
  }
  try {
    setStatus(`${label}: waiting for MetaMask confirmation...`);
    const tx = await txPromise();
    setStatus(`${label}: transaction sent, waiting to be mined...`);
    await tx.wait();
    setStatus(`${label}: success!`);
    await refresh();
    return true;
  } catch (err) {
    const msg = `${err.code || ""} ${err.shortMessage || ""} ${err.message || ""}`;
    if (/NONCE_EXPIRED|nonce/i.test(msg)) {
      // MetaMask keeps its own per-account transaction counter. It goes out of date when the
      // Hardhat node is restarted (the chain starts again from zero).
      setStatus(`${label} failed: MetaMask's transaction counter (nonce) is out of date, usually because the Hardhat node was restarted. Fix: MetaMask → Settings → Advanced → "Clear activity tab data", then try again.`, true);
    } else {
      setStatus(`${label} failed: ${err.reason || err.shortMessage || err.message}`, true);
    }
    return false;
  }
}

// ---------------------------------------------------------------- Owner

// type: 1 = organisation, 2 = individual, 0 = remove verification
async function setVerification(type) {
  const creator = $("verifyAddress").value.trim();
  if (!ethers.isAddress(creator)) {
    setStatus("Enter a valid wallet address (0x...).", true);
    return;
  }
  const label = type === 0 ? "Remove verification" : type === 1 ? "Verify organisation" : "Verify individual";
  const ok = await sendTx(label, () => writeContract.setCreatorType(creator, type));
  if (ok) $("verifyAddress").value = "";
}

// ---------------------------------------------------------------- Causes and donations

async function createCause(event) {
  event.preventDefault();
  const title = $("title").value.trim();
  const description = $("description").value.trim();
  const category = Number($("category").value);
  const goal = ethers.parseEther($("goal").value);
  const deadline = Math.floor(new Date($("deadline").value).getTime() / 1000);
  if (same(account, ownerAddress)) {
    setStatus("The platform owner cannot create causes. Switch MetaMask to the NGO's account.", true);
    return;
  }
  const ok = await sendTx("Create cause", () =>
    writeContract.createCause(title, description, category, goal, deadline)
  );
  if (ok) {
    $("createForm").reset();
    location.hash = "#causes"; // show the new cause
  }
}

async function donate(causeId) {
  const amount = $(`donate-${causeId}`).value;
  if (!amount || Number(amount) <= 0) {
    setStatus("Enter a donation amount greater than 0.", true);
    return;
  }
  const ok = await sendTx("Donate", () => writeContract.donate(causeId, { value: ethers.parseEther(amount) }));
  // The box is gone if this donation reached the goal (donations closed)
  if (ok && $(`donate-${causeId}`)) $(`donate-${causeId}`).value = "";
}

async function claimRefund(causeId) {
  await sendTx("Claim refund", () => writeContract.claimRefund(causeId));
}

// ---------------------------------------------------------------- Spending with automatic audit

// Receipts chosen in the NGO form, kept across re-renders: causeId => { name, hash, amount, wallet, used, error }
const receipts = {};
// Data the audit checklist needs for each cause (filled while rendering)
const causeInfo = {};

// Extracts the text of a PDF with pdf.js
async function readPdfText(file) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    text += (await page.getTextContent()).items.map((item) => item.str).join(" ") + " ";
  }
  return text;
}

async function onReceiptChosen(causeId, input) {
  const file = input.files[0];
  if (!file) return;
  const r = { name: file.name, hash: await hashFile(file), amount: null, wallet: null, used: false, error: "" };
  if (!/\.pdf$/i.test(file.name)) {
    r.error = "The receipt must be a PDF file.";
  } else {
    try {
      // The receipt must state its total and the supplier's wallet (see docs/demo-receipts)
      const text = await readPdfText(file);
      const amount = text.match(/Total\s*Amount\s*:?\s*([\d.,]+)\s*ETH/i);
      const wallet = text.replace(/\s+/g, "").match(/Paytowallet:?(0x[a-fA-F0-9]{40})/i);
      r.amount = amount ? amount[1].replace(/,/g, "") : null;
      r.wallet = wallet ? wallet[1] : null;
    } catch (err) {
      console.error(err);
      r.error = "Could not read the PDF (is pdf.js loaded? an internet connection is needed for it).";
    }
  }
  r.used = await readContract.receiptUsed(r.hash);
  receipts[causeId] = r;

  // Convenience: fill empty fields from the receipt
  if (r.amount && !$(`exp-amount-${causeId}`).value) $(`exp-amount-${causeId}`).value = r.amount;
  if (r.wallet && !$(`exp-recipient-${causeId}`).value) $(`exp-recipient-${causeId}`).value = r.wallet;
  updateAudit(causeId);
}

// The automatic audit: every check must pass before the payment can be sent
function auditChecks(causeId) {
  const r = receipts[causeId];
  const info = causeInfo[causeId];
  const amountText = ($(`exp-amount-${causeId}`) || {}).value || "";
  const recipient = (($(`exp-recipient-${causeId}`) || {}).value || "").trim();
  const description = (($(`exp-desc-${causeId}`) || {}).value || "").trim();
  let amountWei = null;
  try { if (Number(amountText) > 0) amountWei = ethers.parseEther(amountText); } catch { /* invalid number */ }
  const validRecipient = ethers.isAddress(recipient);

  return [
    { ok: !!description, text: "Description entered" },
    { ok: !!r && !r.error, text: r ? (r.error || `Receipt attached: ${r.name} (SHA-256 ${r.hash.slice(0, 12)}…)`) : "Receipt PDF attached (compulsory)" },
    { ok: !!r && !r.error && !r.used, text: r && r.used ? "This receipt has already been used for another payment" : "Receipt not used before (checked on-chain)" },
    { ok: !!r && !!r.amount && amountWei !== null && ethers.parseEther(r.amount) === amountWei,
      text: r && r.amount ? `Amount on receipt (${r.amount} ETH) matches the amount entered` : "Amount on receipt matches the amount entered" },
    { ok: !!r && !!r.wallet && validRecipient && same(r.wallet, recipient),
      text: r && r.wallet ? `Recipient on receipt (${short(r.wallet)}) matches the recipient entered` : "Recipient on receipt matches the recipient entered" },
    { ok: validRecipient && !same(recipient, info.ngo) && !same(recipient, ownerAddress), text: "Recipient is not the NGO itself or the platform owner" },
    { ok: amountWei !== null && amountWei <= info.remaining, text: `Amount within the remaining balance (${fmtEth(info.remaining)})` },
  ];
}

function renderChecklist(causeId) {
  return auditChecks(causeId)
    .map((c) => `<li class="${c.ok ? "check-ok" : "check-fail"}">${esc(c.text)}</li>`)
    .join("");
}

// Re-evaluates the checklist and enables the pay button only when every check passes
function updateAudit(causeId) {
  if (!$(`audit-${causeId}`)) return;
  $(`audit-${causeId}`).innerHTML = renderChecklist(causeId);
  const passed = auditChecks(causeId).every((c) => c.ok);
  $(`pay-${causeId}`).disabled = !passed;
  $(`audit-result-${causeId}`).textContent = passed
    ? "Audit passed. Payment can be sent; the contract re-checks the on-chain rules."
    : "Audit not passed yet. Payment is locked until every check is green.";
  $(`audit-result-${causeId}`).className = passed ? "audit-result pass" : "audit-result fail";
}

// Only the cause's NGO sees this form; the contract also enforces it (onlyNGO)
async function logExpenditure(causeId) {
  if (!auditChecks(causeId).every((c) => c.ok)) {
    setStatus("Automatic audit failed: fix the red checks before paying.", true);
    return;
  }
  const r = receipts[causeId];
  const description = $(`exp-desc-${causeId}`).value.trim();
  const amount = ethers.parseEther($(`exp-amount-${causeId}`).value);
  const recipient = $(`exp-recipient-${causeId}`).value.trim();
  const receiptURI = $(`exp-uri-${causeId}`).value.trim();

  const ok = await sendTx("Audit & pay", () =>
    writeContract.logExpenditure(causeId, description, amount, recipient, r.hash, receiptURI)
  );
  if (ok) {
    // The form is gone if this payment used up the last of the funds
    for (const f of ["desc", "amount", "recipient", "uri"]) if ($(`exp-${f}-${causeId}`)) $(`exp-${f}-${causeId}`).value = "";
    delete receipts[causeId];
    updateAudit(causeId);
  }
}

// Anyone can check a receipt file against the hash stored on-chain
let verifyTarget = null;

function verifyReceipt(hash) {
  verifyTarget = hash;
  $("verifyFile").value = "";
  $("verifyFile").click();
}

async function onVerifyFileChosen() {
  const file = $("verifyFile").files[0];
  if (!file || !verifyTarget) return;
  const hash = await hashFile(file);
  if (hash === verifyTarget) {
    setStatus(`Receipt verified: "${file.name}" matches the hash stored on-chain.`);
  } else {
    setStatus(`Receipt does NOT match: "${file.name}" has a different hash than the one on-chain.`, true);
  }
}

// ---------------------------------------------------------------- Rendering causes

// Remember which causes have their details open across refreshes
const openDetails = new Set();

function toggleDetails(causeId) {
  openDetails.has(causeId) ? openDetails.delete(causeId) : openDetails.add(causeId);
  loadCauses();
}

let loading = false;
async function loadCauses() {
  if (loading) return;
  loading = true;
  try {
    const count = Number(await readContract.causeCount());
    $("tabCauseCount").textContent = count > 0 ? count : "";
    if (count === 0) {
      $("causes").innerHTML = "<p>No causes yet.</p>";
      return;
    }

    const cards = [];
    for (let id = count; id >= 1; id--) {
      cards.push(await renderCause(id));
    }
    // Keep whatever the user has typed into the cause inputs when re-rendering
    const typed = {};
    document.querySelectorAll("#causes input:not([type=file])").forEach((el) => (typed[el.id] = el.value));
    $("causes").innerHTML = cards.join("");
    for (const [id, value] of Object.entries(typed)) {
      if ($(id)) $(id).value = value;
    }
    // Redraw each NGO spend form's audit checklist
    for (let id = 1; id <= count; id++) updateAudit(id);
  } catch (err) {
    $("causes").innerHTML = `<p class="error">Could not load causes. Is the Hardhat node running and the contract deployed?</p>`;
    console.error(err);
  } finally {
    loading = false;
  }
}

function causeState(c, refundable, remaining) {
  if (refundable) return { label: "Goal missed · refunds open", cls: "state-refund" };
  if (c.totalRaised >= c.goal && remaining === 0n) return { label: "Fully spent · completed", cls: "state-closed" };
  if (c.totalRaised >= c.goal) return { label: "Goal reached · donations closed", cls: "state-funded" };
  if (Date.now() / 1000 > Number(c.deadline)) return { label: "Closed", cls: "state-closed" };
  return { label: "Fundraising", cls: "state-open" };
}

function renderReceipt(e) {
  if (e.receiptHash === ethers.ZeroHash && !e.receiptURI) return '<span class="muted">None</span>';
  const parts = [];
  if (e.receiptHash !== ethers.ZeroHash) {
    parts.push(`<code title="${e.receiptHash}">${e.receiptHash.slice(0, 10)}...</code>`);
    parts.push(`<button class="link" onclick="verifyReceipt('${e.receiptHash}')">Verify</button>`);
  }
  const link = e.receiptURI && safeLink(e.receiptURI);
  if (link) parts.push(`<a href="${esc(link)}" target="_blank" rel="noopener">View</a>`);
  return parts.join(" ");
}

async function renderCause(id) {
  const c = await readContract.getCause(id);
  const [remaining, chainRefundable, creatorType, expenses] = await Promise.all([
    readContract.getRemainingBalance(id),
    readContract.isRefundable(id),
    readContract.creatorType(c.ngo),
    readContract.getExpenditures(id),
  ]);
  const myContribution = account ? await readContract.contributions(id, account) : 0n;
  // View calls use the last block's timestamp, which on an idle local chain can lag behind
  // the real clock. Also check the real clock; the contract re-checks when claimRefund runs.
  const refundable = chainRefundable || (Date.now() / 1000 > Number(c.deadline) && c.totalRaised < c.goal);

  const goalReached = c.totalRaised >= c.goal;
  // Donations close at the deadline or as soon as the goal is reached (whichever comes first)
  const isOpen = Date.now() / 1000 <= Number(c.deadline) && !refundable && !goalReached;
  const progress = Math.min(100, Number((c.totalRaised * 100n) / c.goal));
  const isMyCause = same(account, c.ngo);
  const state = causeState(c, refundable, remaining);
  causeInfo[id] = { ngo: c.ngo, remaining };

  let details = "";
  if (openDetails.has(id)) {
    const donations = await readContract.getDonations(id);
    details = `
      <h4>Donations (${donations.length})</h4>
      ${donations.length === 0 ? "<p>None yet.</p>" : `
      <table>
        <tr><th>Donor</th><th>Amount</th><th>Time</th></tr>
        ${donations.map((d) => `
          <tr><td title="${d.donor}">${short(d.donor)}</td><td>${fmtEth(d.amount)}</td><td>${fmtDate(d.timestamp)}</td></tr>
        `).join("")}
      </table>`}
      <h4>Expenditures (${expenses.length})</h4>
      ${expenses.length === 0 ? "<p>None yet.</p>" : `
      <table>
        <tr><th>Description</th><th>Amount</th><th>Recipient</th><th>Audit</th><th>Receipt</th><th>Paid</th></tr>
        ${expenses.map((e) => `
          <tr>
            <td>${esc(e.description)}</td>
            <td>${fmtEth(e.amount)}</td>
            <td title="${e.recipient}">${short(e.recipient)}</td>
            <td><span class="status-pill status-approved">Passed &amp; paid</span></td>
            <td class="receipt-cell">${renderReceipt(e)}</td>
            <td>${fmtDate(e.timestamp)}</td>
          </tr>
        `).join("")}
      </table>`}
    `;
  }

  // NGO: spend form with the automatic audit (only once the goal is reached and funds remain)
  let ngoPanel = "";
  if (isMyCause) {
    let spendNote = "";
    if (!goalReached) {
      spendNote = `Spending unlocks once the goal of ${fmtEth(c.goal)} is reached. If the deadline passes first, donors can claim refunds.`;
    } else if (remaining === 0n) {
      spendNote = "All funds for this cause have been spent. No further expenditures can be made.";
    }
    ngoPanel = `
      <div class="ngo-panel">
        <h4>Spend Funds (automatic audit)</h4>
        ${!spendNote ? `
          <div class="exp-form">
            <input id="exp-desc-${id}" placeholder="Description (e.g. 50 rice bags)" oninput="updateAudit(${id})" />
            <input id="exp-amount-${id}" type="number" step="0.001" min="0" placeholder="Amount in ETH" oninput="updateAudit(${id})" />
            <input id="exp-recipient-${id}" placeholder="Supplier wallet (0x...)" oninput="updateAudit(${id})" />
          </div>
          <div class="receipt-row">
            <label class="file-btn">Attach receipt PDF (required)
              <input type="file" accept="application/pdf,.pdf" onchange="onReceiptChosen(${id}, this)" />
            </label>
            <input id="exp-uri-${id}" class="uri-input" placeholder="Optional receipt link (ipfs://... or https://...)" />
          </div>
          <ul id="audit-${id}" class="audit-list"></ul>
          <div class="audit-footer">
            <span id="audit-result-${id}" class="audit-result fail"></span>
            <button id="pay-${id}" onclick="logExpenditure(${id})" disabled>Audit &amp; Pay</button>
          </div>
        ` : `
          <p class="muted">${spendNote}</p>
        `}
      </div>`;
  }

  // Donor: refund
  let refundBox = "";
  if (refundable && myContribution > 0n) {
    refundBox = `
      <div class="refund-box">
        <span>This cause missed its goal. You donated <strong>${fmtEth(myContribution)}</strong>.</span>
        <button onclick="claimRefund(${id})">Claim refund</button>
      </div>`;
  }

  const roles = [
    isMyCause ? '<span class="badge">Your cause</span>' : "",
  ].join("");

  return `
    <div class="card cause">
      <div class="cause-tags">
        <span class="category-chip">${CATEGORIES[Number(c.category)]}</span>
        <span class="state-chip ${state.cls}">${state.label}</span>
      </div>
      <h3>#${id} ${esc(c.title)} ${roles}</h3>
      <p>${esc(c.description)}</p>
      <p class="muted">
        Created by: <span title="${c.ngo}">${short(c.ngo)}</span>
        ${Number(creatorType) === 0 ? '<span class="unverified">Unverified</span>' : `<span class="verified">${CREATOR_TYPES[Number(creatorType)]}</span>`}
        &middot; Automatic audit on every payment
        &middot; Deadline: ${fmtDate(c.deadline)}
      </p>
      <div class="progress"><div style="width:${progress}%"></div></div>
      <div class="stats">
        <div><span>Goal</span>${fmtEth(c.goal)}</div>
        <div><span>Raised</span>${fmtEth(c.totalRaised)}</div>
        <div><span>Spent</span>${fmtEth(c.totalSpent)}</div>
        <div><span>Remaining</span>${fmtEth(remaining)}</div>
      </div>
      <div class="actions">
        ${isOpen ? `
          <input id="donate-${id}" type="number" step="0.001" min="0" placeholder="Amount in ETH" />
          <button onclick="donate(${id})">Donate</button>` : `
          <span class="closed-note">${goalReached
            ? "Donations closed: goal reached. Funds can now be spent; every payment is audited automatically."
            : refundable ? "Donations closed: goal missed by the deadline." : "Donations closed: deadline passed."}</span>`}
        <button class="secondary" onclick="toggleDetails(${id})">${openDetails.has(id) ? "Hide" : "View"} donations &amp; expenditures</button>
      </div>
      ${refundBox}
      ${ngoPanel}
      ${details}
    </div>
  `;
}

// ---------------------------------------------------------------- Activity feed (from contract events)

const blockTimes = {};

async function blockTime(blockNumber) {
  if (!blockTimes[blockNumber]) {
    blockTimes[blockNumber] = (await provider.getBlock(blockNumber)).timestamp;
  }
  return blockTimes[blockNumber];
}

// One table row per event: what happened, which cause, who sent value to whom, how much, and when
const addrCell = (addr) => `<span class="mono" title="${addr}">${short(addr)}</span>`;
const CONTRACT = '<span class="party">Contract</span>';

function describeEvent(ev) {
  const a = ev.args;
  switch (ev.eventName) {
    case "CauseCreated":
      return { icon: "new", label: "Cause created", cause: a.causeId, from: addrCell(a.ngo), to: "&mdash;",
               amount: null, details: `Goal ${fmtEth(a.goal)}` };
    case "DonationReceived":
      return { icon: "donate", label: "Donation", cause: a.causeId, from: addrCell(a.donor), to: CONTRACT,
               amount: a.amount, details: "Held by the contract for this cause" };
    case "ExpenditureLogged":
      return { icon: "approve", label: "Audited payment", cause: a.causeId, from: CONTRACT, to: addrCell(a.recipient),
               amount: a.amount, details: `“${esc(a.description)}” &middot; audit passed &middot; receipt <span class="mono">${a.receiptHash.slice(0, 10)}…</span>` };
    case "RefundClaimed":
      return { icon: "refund", label: "Refund", cause: a.causeId, from: CONTRACT, to: addrCell(a.donor),
               amount: a.amount, details: "Goal missed by the deadline" };
    case "CreatorVerified": {
      const type = Number(a.creatorType);
      return { icon: "verify", label: type === 0 ? "Verification removed" : "Creator verified", cause: null,
               from: '<span class="party">Owner</span>', to: addrCell(a.creator), amount: null,
               details: type === 0 ? "Badge removed" : type === 1 ? "Registered organisation" : "Individual (personal cause)" };
    }
    default:
      return null;
  }
}

let loadingActivity = false;
async function loadActivity() {
  if (loadingActivity) return;
  loadingActivity = true;
  try {
    // Every event the contract has ever emitted, newest first
    const all = (await readContract.queryFilter("*", 0, "latest")).filter((ev) => ev.eventName);
    const titles = {};
    for (const ev of all) {
      if (ev.eventName === "CauseCreated") titles[ev.args.causeId] = ev.args.title;
    }
    const events = all.sort((x, y) => y.blockNumber - x.blockNumber || y.index - x.index).slice(0, 50);

    if (events.length === 0) {
      $("activity").innerHTML = '<p class="activity-empty">No activity yet. Every transaction will appear here.</p>';
      return;
    }

    const rows = [];
    for (const ev of events) {
      const d = describeEvent(ev);
      if (!d) continue;
      const ts = await blockTime(ev.blockNumber);
      const cause = d.cause === null ? "&mdash;" : `#${d.cause} ${esc(titles[d.cause] || "")}`;
      rows.push(`
        <tr>
          <td><span class="event-tag"><span class="activity-icon icon-${d.icon}"></span>${d.label}</span></td>
          <td>${cause}</td>
          <td>${d.from}</td>
          <td>${d.to}</td>
          <td class="num">${d.amount === null ? "&mdash;" : fmtEth(d.amount)}</td>
          <td class="details">${d.details}</td>
          <td title="${fmtDate(ts)}">${timeAgo(ts)}</td>
          <td class="num">#${ev.blockNumber}</td>
        </tr>`);
    }
    $("activity").innerHTML = `
      <table class="activity-table">
        <tr><th>Event</th><th>Cause</th><th>From</th><th>To</th><th class="num">Amount</th><th>Details</th><th>Time</th><th class="num">Block</th></tr>
        ${rows.join("")}
      </table>`;
  } catch (err) {
    console.error(err);
  } finally {
    loadingActivity = false;
  }
}

// ---------------------------------------------------------------- Tabs (navbar)

const TABS = ["causes", "create", "activity", "admin"];

// The URL hash (#causes, #create, ...) selects the tab, so refresh and the back button work
function showTab() {
  let tab = location.hash.slice(1);
  if (!TABS.includes(tab)) tab = "causes";
  document.querySelectorAll(".tab-panel").forEach((panel) => (panel.hidden = panel.dataset.panel !== tab));
  document.querySelectorAll(".tab").forEach((link) => link.classList.toggle("active", link.dataset.tab === tab));
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", showTab);
showTab();

// ---------------------------------------------------------------- Wiring

$("connectBtn").addEventListener("click", connectWallet);
$("createForm").addEventListener("submit", createCause);
$("verifyBtn").addEventListener("click", () => setVerification(Number($("verifyType").value)));
$("unverifyBtn").addEventListener("click", () => setVerification(0));
$("verifyFile").addEventListener("change", onVerifyFileChosen);

if (window.ethereum) {
  // Reload when the user switches account or network in MetaMask
  window.ethereum.on("accountsChanged", () => window.location.reload());
  window.ethereum.on("chainChanged", () => window.location.reload());
}

init().catch((err) => {
  setStatus("Could not load contract-config.json. Run the deploy script first.", true);
  console.error(err);
});
