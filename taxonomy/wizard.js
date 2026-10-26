/**
 * AAIF Taxonomy — Propose / Edit Term Wizard
 *
 * Consolidated into the main Taxonomy Explorer (index.html) per Junjie Bu
 * (@mindpower) review on PR #90. This module is intentionally:
 *   - Backend-free: it reads the taxonomy from the already-loaded
 *     window.AAIF_TAXONOMY global (same-origin taxonomy-data.js) — no fetch,
 *     no CORS, no raw.githubusercontent.com dependency.
 *   - Credential-free & vendor-neutral: NO GitHub Personal Access Token input
 *     and NO external AI SDK (no js.puter.com / Grok). Submission uses only
 *     GitHub's own token-less in-browser web flow, or a downloadable
 *     create-pr.sh script that runs locally.
 *
 * Validation guardrails preserved from the prototype:
 *   - Aliases may NOT collide with an existing primary term (#78).
 *   - relatedTerms / contrastsWith must reference existing taxonomy terms.
 */
(function () {
  "use strict";

  const REPO = "aaif/ws-taxonomy-landscape";
  const DATA_FILE = "taxonomy/taxonomy-data.js";
  const BASE_BRANCH = "main";
  const WORKGROUPS = [
    "Accuracy & Reliability",
    "Agentic Commerce",
    "Governance, Risk & Regulatory Alignment",
    "Identity & Trust",
    "Observability & Traceability",
    "Security & Privacy",
    "Workflows & Process Integration",
  ];
  const PENDING_RE = /^definition pending/i;
  const PENDING_TEXT =
    "Definition pending — term accepted; definition under working group discussion.";

  const STATE = { terms: [], byName: {} };

  const $ = (id) => document.getElementById(id);
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function isPending(t) {
    return !t.definition || PENDING_RE.test(t.definition.trim());
  }
  function banner(kind, msg) {
    const b = $("wizard-banner");
    if (!b) return;
    b.className = "wizard-msg " + kind;
    b.innerHTML = msg;
    b.style.display = "block";
    if (kind === "ok") setTimeout(() => { b.style.display = "none"; }, 6000);
  }

  // ---------- boot ----------
  function boot() {
    const data = window.AAIF_TAXONOMY || [];
    STATE.terms = data.slice().sort((a, b) => a.term.localeCompare(b.term));
    STATE.byName = {};
    STATE.terms.forEach((t) => (STATE.byName[t.term.toLowerCase()] = t));

    renderWorkgroups();
    wireTabs();
    wireTagboxes();
    wireTermField();
    $("wiz-definition").addEventListener("input", checkSentences);
    $("wiz-gen-btn").addEventListener("click", generate);
  }

  // ---------- tab integration with the existing explorer ----------
  function wireTabs() {
    const proposeTab = $("main-tab-propose");
    const proposeView = $("propose-view-container");
    const otherTabs = [
      $("main-tab-split"),
      $("main-tab-grid"),
      $("main-tab-mindmap"),
    ].filter(Boolean);
    const otherViews = [
      $("split-layout-container"),
      $("grid-view-container"),
      $("mindmap-view-container"),
    ].filter(Boolean);

    proposeTab.addEventListener("click", () => {
      otherTabs.forEach((t) => { t.classList.remove("active"); t.setAttribute("aria-selected", "false"); });
      proposeTab.classList.add("active");
      proposeTab.setAttribute("aria-selected", "true");
      otherViews.forEach((v) => { v.style.display = "none"; });
      proposeView.style.display = "block";
    });

    // When any existing tab is chosen, hide the propose view. app.js already
    // shows the correct explorer container, so we only clean up our own view.
    otherTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        proposeTab.classList.remove("active");
        proposeTab.setAttribute("aria-selected", "false");
        proposeView.style.display = "none";
      });
    });
  }

  // ---------- workgroups ----------
  function renderWorkgroups() {
    const el = $("wiz-wg-list");
    el.innerHTML = "";
    WORKGROUPS.forEach((wg) => {
      const lab = document.createElement("label");
      lab.innerHTML = `<input type="checkbox" value="${esc(wg)}"> ${esc(wg)}`;
      el.appendChild(lab);
    });
  }

  // ---------- tag boxes ----------
  function wireTagboxes() {
    document.querySelectorAll(".wizard-tagbox[data-tags]").forEach((box) => {
      const input = box.querySelector("input");
      const suggest = box.querySelector(".wizard-suggest");
      const validate = box.dataset.validate === "existing";
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const active = suggest && suggest.querySelector(".active");
          addTag(box, active ? active.textContent.replace(/\s+\(pending\)$/, "") : input.value, validate);
          input.value = "";
          if (suggest) suggest.style.display = "none";
        } else if (e.key === "Backspace" && !input.value) {
          const tags = box.querySelector(".wizard-tags");
          if (tags.lastElementChild) tags.lastElementChild.remove();
        } else if (suggest && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault();
          moveActive(suggest, e.key === "ArrowDown" ? 1 : -1);
        }
      });
      if (validate) {
        input.addEventListener("input", () => showSuggest(suggest, input.value, box));
        input.addEventListener("blur", () => setTimeout(() => (suggest.style.display = "none"), 150));
      }
    });
  }
  function currentTags(box) {
    return [...box.querySelectorAll(".wizard-tags .wizard-chip")].map((c) => c.dataset.value);
  }
  function addTag(box, value, validate, opts) {
    value = (value || "").trim();
    if (!value) return;
    if (currentTags(box).some((v) => v.toLowerCase() === value.toLowerCase())) return;
    if (validate) {
      const match = STATE.byName[value.toLowerCase()];
      if (!match) {
        banner("err", `"${esc(value)}" is not an existing taxonomy term.`);
        return;
      }
      value = match.term;
    }
    // Aliases must NOT collide with an existing primary term: an alias that is
    // also a real term creates an ambiguous reference. Reject on interactive
    // adds; programmatic prefill (opts.silent) drops it quietly so loading an
    // existing entry doesn't spray errors, but the clashing alias is still not
    // re-submittable. (Validation alignment from #78.)
    if (box.dataset.tags === "aliases") {
      const clash = STATE.byName[value.toLowerCase()];
      if (clash) {
        if (!(opts && opts.silent)) {
          banner("err", `"${esc(clash.term)}" is already an existing taxonomy term, so it can't be used as an alias.`);
        }
        return;
      }
    }
    const tags = box.querySelector(".wizard-tags");
    const chip = document.createElement("span");
    chip.className = "wizard-chip";
    chip.dataset.value = value;
    chip.innerHTML = `${esc(value)} <button type="button" aria-label="Remove">×</button>`;
    chip.querySelector("button").addEventListener("click", () => chip.remove());
    tags.appendChild(chip);
  }
  function showSuggest(suggest, q, box) {
    q = q.trim().toLowerCase();
    if (!q) { suggest.style.display = "none"; return; }
    const chosen = new Set(currentTags(box).map((v) => v.toLowerCase()));
    const termVal = $("wiz-term").value.trim().toLowerCase();
    const matches = STATE.terms
      .filter((t) => t.term.toLowerCase().includes(q) && !chosen.has(t.term.toLowerCase()) && t.term.toLowerCase() !== termVal)
      .slice(0, 8);
    suggest.innerHTML = "";
    if (!matches.length) { suggest.style.display = "none"; return; }
    matches.forEach((t, i) => {
      const d = document.createElement("div");
      if (i === 0) d.className = "active";
      d.textContent = t.term;
      if (isPending(t)) {
        const s = document.createElement("span");
        s.className = "pending";
        s.textContent = "  (pending)";
        d.appendChild(s);
      }
      d.addEventListener("mousedown", (e) => {
        e.preventDefault();
        addTag(box, t.term, true);
        box.querySelector("input").value = "";
        suggest.style.display = "none";
      });
      suggest.appendChild(d);
    });
    suggest.style.display = "block";
  }
  function moveActive(suggest, dir) {
    const items = [...suggest.children];
    const idx = items.findIndex((i) => i.classList.contains("active"));
    if (idx >= 0) items[idx].classList.remove("active");
    const next = (idx + dir + items.length) % items.length;
    if (items[next]) items[next].classList.add("active");
  }

  // ---------- term field ----------
  function wireTermField() {
    const input = $("wiz-term");
    const suggest = $("wiz-term-suggest");
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      updateTermBadge();
      if (!q) { suggest.style.display = "none"; return; }
      const matches = STATE.terms.filter((t) => t.term.toLowerCase().includes(q)).slice(0, 8);
      suggest.innerHTML = "";
      if (!matches.length) { suggest.style.display = "none"; return; }
      matches.forEach((t, i) => {
        const d = document.createElement("div");
        if (i === 0) d.className = "active";
        d.textContent = t.term;
        if (isPending(t)) {
          const s = document.createElement("span");
          s.className = "pending";
          s.textContent = "  (pending)";
          d.appendChild(s);
        }
        d.addEventListener("mousedown", (e) => {
          e.preventDefault();
          input.value = t.term;
          suggest.style.display = "none";
          prefill(t);
          updateTermBadge();
        });
        suggest.appendChild(d);
      });
      suggest.style.display = "block";
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        moveActive(suggest, e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter") {
        const active = suggest.querySelector(".active");
        if (active && suggest.style.display !== "none") {
          e.preventDefault();
          input.value = active.textContent.replace(/\s+\(pending\)$/, "");
          suggest.style.display = "none";
          const t = STATE.byName[input.value.toLowerCase()];
          if (t) prefill(t);
          updateTermBadge();
        }
      }
    });
    input.addEventListener("blur", () => setTimeout(() => (suggest.style.display = "none"), 150));
  }
  function updateTermBadge() {
    const badge = $("wiz-term-badge");
    const t = STATE.byName[$("wiz-term").value.trim().toLowerCase()];
    if (t) {
      badge.style.display = "inline-block";
      badge.className = "wizard-badge " + (isPending(t) ? "pending" : "defined");
      badge.textContent = isPending(t) ? "existing • pending" : "existing • defined";
    } else {
      badge.style.display = "none";
    }
  }
  function prefill(t) {
    $("wiz-definition").value = t.definition && !isPending(t) ? t.definition : "";
    $("wiz-scope").value = t.scopeNote || "";
    fillTags("aliases", t.aliases || []);
    fillTags("relatedTerms", t.relatedTerms || []);
    fillTags("contrastsWith", t.contrastsWith || []);
    const set = new Set(t.workgroups || []);
    document.querySelectorAll("#wiz-wg-list input").forEach((cb) => (cb.checked = set.has(cb.value)));
    checkSentences();
  }
  function fillTags(name, values) {
    const box = document.querySelector(`.wizard-tagbox[data-tags="${name}"]`);
    box.querySelector(".wizard-tags").innerHTML = "";
    values.forEach((v) => addTag(box, v, false, { silent: true }));
  }
  function checkSentences() {
    const txt = $("wiz-definition").value.trim();
    const parts = txt.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim());
    $("wiz-sentence-warn").style.display = parts.length > 1 ? "block" : "none";
  }

  // ---------- generate ----------
  function slug(s) {
    return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  }
  function commitSubject(p, exists) {
    return (exists ? "Update" : "Define") + " taxonomy term: " + p.term;
  }
  function prBody(p, exists) {
    const action = exists ? "update" : "add";
    return `Proposed via the Taxonomy Term Wizard (${action}). Touches only ${DATA_FILE}.`;
  }

  // Splice the generated entry into the raw data file text in the browser,
  // mirroring the surgical, comment-preserving edit the bash/Python script
  // performs — so the token-less GitHub web flow can prefill the FULL file.
  function spliceEntry(rawText, term, entryText) {
    if (!rawText) return null;
    const m = /window\.AAIF_TAXONOMY\s*=\s*\[/.exec(rawText);
    if (!m) return null;
    const start = m.index + m[0].length;
    let depth = 1, i = start;
    while (i < rawText.length && depth) {
      const c = rawText[i];
      if (c === "[") depth++;
      else if (c === "]") depth--;
      i++;
    }
    const end = i - 1;
    const body = rawText.slice(start, end);
    const pat = new RegExp("\\{[^{}]*?term:\\s*'" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "'[^{}]*?\\}", "s");
    let newBody;
    const existing = pat.exec(body);
    if (existing) {
      newBody = body.slice(0, existing.index) + entryText.trim() + body.slice(existing.index + existing[0].length);
    } else {
      const trimmed = body.replace(/\s+$/, "");
      const sep = trimmed.endsWith("}") ? ",\n" : "\n";
      newBody = trimmed + sep + entryText + "\n";
    }
    return rawText.slice(0, start) + newBody + rawText.slice(end);
  }

  function collectPayload() {
    return {
      term: $("wiz-term").value.trim(),
      definition: $("wiz-definition").value.trim(),
      scopeNote: $("wiz-scope").value.trim(),
      aliases: currentTags(document.querySelector('.wizard-tagbox[data-tags="aliases"]')),
      relatedTerms: currentTags(document.querySelector('.wizard-tagbox[data-tags="relatedTerms"]')),
      contrastsWith: currentTags(document.querySelector('.wizard-tagbox[data-tags="contrastsWith"]')),
      workgroups: [...document.querySelectorAll("#wiz-wg-list input:checked")].map((cb) => cb.value),
    };
  }

  // Emit a JS entry object matching the file's formatting (2-space indent,
  // single quotes).
  function jsEntry(p) {
    const q = (s) => "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
    const arr = (a) => (a.length ? "[" + a.map(q).join(", ") + "]" : "[]");
    const def = p.definition || PENDING_TEXT;
    const lines = [
      "  {",
      "    term: " + q(p.term) + ",",
      "    category: '',",
      "    aliases: " + arr(p.aliases) + ",",
      "    broaderTerm: null,",
      "    definition: " + q(def) + ",",
    ];
    if (p.scopeNote) lines.push("    scopeNote: " + q(p.scopeNote) + ",");
    lines.push("    relatedTerms: " + arr(p.relatedTerms) + ",");
    lines.push("    contrastsWith: " + arr(p.contrastsWith) + ",");
    lines.push("    workgroups: " + arr(p.workgroups));
    lines.push("  }");
    return lines.join("\n");
  }

  function buildScript(p, exists) {
    const branch = "taxonomy/define-" + slug(p.term);
    const entry = jsEntry(p);
    const action = exists ? "update" : "add";
    const subject = commitSubject(p, exists);
    const DELIM = "TAXONOMY_ENTRY_EOF";

    const py = [
      `import io, os, re, sys, json`,
      `FILE = ${JSON.stringify(DATA_FILE)}`,
      `TERM = ${JSON.stringify(p.term)}`,
      `ENTRY = open("/tmp/taxonomy_entry.txt", encoding="utf-8").read().rstrip("\\n")`,
      `src = open(FILE, encoding="utf-8").read()`,
      `m = re.search(r"window\\.AAIF_TAXONOMY\\s*=\\s*\\[", src)`,
      `if not m:`,
      `    sys.exit("Could not find window.AAIF_TAXONOMY array in " + FILE)`,
      `start = m.end()`,
      `depth = 1; i = start`,
      `while i < len(src) and depth:`,
      `    c = src[i]`,
      `    if c == '[': depth += 1`,
      `    elif c == ']': depth -= 1`,
      `    i += 1`,
      `end = i - 1  # index of closing ]`,
      `body = src[start:end]`,
      `pat = re.compile(r"\\{[^{}]*?term:\\s*'" + re.escape(TERM) + r"'[^{}]*?\\}", re.S)`,
      `existing = pat.search(body)`,
      `if existing:`,
      `    new_body = body[:existing.start()] + ENTRY.strip() + body[existing.end():]`,
      `else:`,
      `    trimmed = body.rstrip()`,
      `    sep = ",\\n" if trimmed.endswith("}") else "\\n"`,
      `    new_body = trimmed + sep + ENTRY + "\\n"`,
      `out = src[:start] + new_body + src[end:]`,
      `open(FILE, "w", encoding="utf-8").write(out)`,
      `print("Patched", FILE)`,
    ].join("\n");

    return `#!/usr/bin/env bash
#
# Auto-generated by the AAIF Taxonomy Term Wizard.
# Creates a branch, applies a surgical edit to ${DATA_FILE}, makes a
# signed-off commit, pushes, and opens a PR. Run from the repo root.
#
set -euo pipefail

REPO="${REPO}"
BASE="${BASE_BRANCH}"
BRANCH="${branch}"
FILE="${DATA_FILE}"

# --- sanity checks -----------------------------------------------------------
command -v git >/dev/null || { echo "git not found"; exit 1; }
[ -f "$FILE" ] || { echo "Run this from the repo root ($FILE not found)"; exit 1; }
if ! git diff --quiet -- "$FILE"; then
  echo "Refusing: $FILE has uncommitted changes."; exit 1
fi
ORIG_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# --- write the entry payload -------------------------------------------------
cat > /tmp/taxonomy_entry.txt <<'${DELIM}'
${entry}
${DELIM}

# --- branch ------------------------------------------------------------------
git fetch origin "$BASE" --quiet || true
git checkout -b "$BRANCH" "origin/$BASE" 2>/dev/null || git checkout -b "$BRANCH" "$BASE"

# --- surgical edit (comment-preserving) --------------------------------------
python3 - <<'${DELIM}_PY'
${py}
${DELIM}_PY

# --- commit ------------------------------------------------------------------
git add "$FILE"
git commit -s -m "${subject}" -m "Proposed via the Taxonomy Term Wizard (${action}). Touches only ${DATA_FILE}."

# --- push & PR ---------------------------------------------------------------
git push -u origin "$BRANCH"

PR_BODY="Proposed via the Taxonomy Term Wizard (${action}). Touches only ${DATA_FILE}."
if command -v gh >/dev/null; then
  gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH" \\
    --title "${subject}" --body "$PR_BODY"
else
  echo
  echo "gh CLI not found. Open the PR manually:"
  echo "  https://github.com/$REPO/compare/$BASE...$BRANCH?expand=1"
fi

git checkout "$ORIG_BRANCH" >/dev/null 2>&1 || true
echo "Done."
`;
  }

  function generate() {
    const p = collectPayload();
    if (!p.term) { banner("err", "Term is required."); return; }
    const exists = !!STATE.byName[p.term.toLowerCase()];

    const script = buildScript(p, exists);
    const entry = jsEntry(p);
    const branch = "taxonomy/define-" + slug(p.term);

    $("wiz-result-card").style.display = "block";
    $("wiz-result-meta").textContent =
      `Action: ${exists ? "update existing" : "add new"} • Branch: ${branch} • Only ${DATA_FILE} is touched.`;
    $("wiz-run-cmd").textContent = "bash create-pr.sh";
    $("wiz-script-preview").textContent = script;
    $("wiz-entry-preview").textContent = entry;
    $("wiz-gh-upstream").textContent = REPO;

    wireSubmit(p, exists, entry, script, branch);

    banner("ok", `Ready for "${esc(p.term)}". Create the PR directly on GitHub (no token needed), or download <code>create-pr.sh</code> and run it locally.`);
    $("wiz-result-card").scrollIntoView({ behavior: "smooth" });
  }

  // ---------- submit: token-less GitHub web flow + script download ----------
  function wireSubmit(p, exists, entry, script, branch) {
    const repoName = REPO.split("/")[1];
    const fileDir = DATA_FILE.split("/").slice(0, -1).join("/");
    const subject = commitSubject(p, exists);
    const description = prBody(p, exists);
    const recBranch = branch;
    const ghBtn = $("wiz-gh-pr-btn");

    // We read the local data file (same origin) and splice against it. Falls
    // back to nothing if unavailable — the paste flow still works.
    async function localRawText() {
      try {
        const r = await fetch("taxonomy-data.js", { cache: "no-cache" });
        if (r.ok) {
          const t = await r.text();
          if (t && !/^\s*</.test(t)) return t;
        }
      } catch (e) { /* ignore */ }
      return null;
    }
    async function splicedFileFor(ownerRepo) {
      let src = await localRawText();
      try {
        const rawFork = `https://raw.githubusercontent.com/${ownerRepo}/${BASE_BRANCH}/${DATA_FILE}`;
        const r = await fetch(rawFork, { cache: "no-cache" });
        if (r.ok) {
          const t = await r.text();
          if (t && !/^\s*</.test(t)) src = t;
        }
      } catch (e) { /* use local text */ }
      return spliceEntry(src, p.term, entry);
    }

    function buildPrefillUrl(ownerRepo, full) {
      if (!full) return null;
      const params = new URLSearchParams({
        filename: DATA_FILE.split("/").pop(),
        value: full,
        message: subject,
        description,
      });
      const url = `https://github.com/${ownerRepo}/new/${BASE_BRANCH}/${fileDir}?${params.toString()}`;
      return url.length > 30000 ? null : url;
    }

    async function pasteFallback(ownerRepo, note) {
      let copied = false;
      try { await navigator.clipboard.writeText(entry); copied = true; } catch (e) {}
      window.open(`https://github.com/${ownerRepo}/edit/${BASE_BRANCH}/${DATA_FILE}`, "_blank", "noopener");
      banner("warn", `${copied ? "Entry copied to clipboard." : "Copy the entry below."} Couldn't prefill automatically${note ? " (" + note + ")" : ""}, so opened the plain editor — paste the entry before the closing <code>];</code>, then <b>Commit changes → Create a new branch → Propose changes</b>.`);
    }

    ghBtn.onclick = async () => {
      const user = $("wiz-gh-user").value.trim().replace(/^@/, "");
      if (user && !/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(user)) {
        banner("err", "That doesn't look like a valid GitHub username.");
        return;
      }

      let branchCopied = false;
      try { await navigator.clipboard.writeText(recBranch); branchCopied = true; } catch (e) {}
      const branchNote = branchCopied
        ? `The branch name <code>${esc(recBranch)}</code> is on your clipboard — paste it when GitHub asks to <b>Create a new branch</b>.`
        : `Use the branch name <code>${esc(recBranch)}</code> when GitHub asks to <b>Create a new branch</b>.`;

      if (user) {
        const forkRepo = `${user}/${repoName}`;
        const forkUrl = `https://github.com/${REPO}/fork`;
        let forkExists = false;
        try {
          const r = await fetch(`https://api.github.com/repos/${forkRepo}`, {
            headers: { Accept: "application/vnd.github+json" },
            cache: "no-cache",
          });
          if (r.ok) {
            const info = await r.json();
            const parent = info && info.parent && info.parent.full_name;
            const source = info && info.source && info.source.full_name;
            forkExists = !!info.fork && ((parent && parent.toLowerCase() === REPO.toLowerCase()) || (source && source.toLowerCase() === REPO.toLowerCase()));
            if (info && !info.fork) forkExists = false;
          }
        } catch (e) { /* ignore */ }
        if (!forkExists) {
          window.open(forkUrl, "_blank", "noopener");
          banner("warn", `You don't appear to have a fork yet. Opened the <b>fork page</b> for <code>${esc(REPO)}</code> — click <b>Create fork</b>, then press the button again.`);
          return;
        }
        const full = await splicedFileFor(forkRepo);
        const prefill = buildPrefillUrl(forkRepo, full);
        if (prefill) {
          window.open(prefill, "_blank", "noopener");
          banner("ok", `Opened a <b>prefilled commit</b> on your fork <code>${esc(forkRepo)}</code>: file, commit title and description are filled in. ${branchNote} Then <b>Propose changes</b> to open the PR.`);
        } else {
          await pasteFallback(forkRepo, "the file is too large to prefill via URL");
        }
      } else {
        const full = await splicedFileFor(REPO);
        const prefill = buildPrefillUrl(REPO, full);
        if (prefill) {
          window.open(prefill, "_blank", "noopener");
          banner("ok", `Opened a <b>prefilled commit</b> (file, commit title and description filled in). GitHub will offer to <b>fork ${esc(REPO)}</b> on commit. ${branchNote}`);
        } else {
          await pasteFallback(REPO, "the file is too large to prefill via URL");
        }
      }
    };

    const dl = $("wiz-download-btn");
    dl.onclick = () => {
      const blob = new Blob([script], { type: "text/x-shellscript" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "create-pr.sh";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    };
  }

  // ---------- init ----------
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
