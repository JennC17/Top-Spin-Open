// ============================================================================
// The Topspin Open — app logic. Talks only to window.TopspinDB (db.js or
// db.mock.js — identical interface) and window.TopspinAlgo. Never touches
// Firebase directly, so the backend can change without touching this file.
// ============================================================================

(function () {
  const CFG = window.TOPSPIN_CONFIG;
  const Algo = window.TopspinAlgo;
  let DB = null;

  // ---- live state, kept in sync by DB subscriptions ----
  let config = { currentSeasonId: null, adminPasscodeHash: null };
  let players = [];                 // full roster, active + inactive
  let seasonsCache = {};            // seasonId -> season doc (as loaded)
  let weeks = [];                   // weeks for the VIEWED season
  let rsvpUnsub = null;             // per-week RSVP subscriptions, keyed below
  let weeksUnsub = null;
  let viewedSeasonId = null;        // which season the UI is currently showing
  let isAdmin = false;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $all = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const byId = (arr, id) => arr.find(x => x.id === id);
  const playerName = (id) => { const p = byId(players, id); return p ? p.name : "(removed player)"; };

  function fmtDate(iso) {
    if (!iso || iso === "—") return "—";
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  function fmtDateLong(iso) {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  }
  function addDays(iso, n) {
    const d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }
  function todayISO() { return new Date().toISOString().slice(0, 10); }

  // =====================================================================
  // INIT
  // =====================================================================
  async function init() {
    DB = window.TopspinDB.create(CFG.firebase);

    DB.watchConfig(async (c) => {
      config = c || {};
      if (!viewedSeasonId) {
        viewedSeasonId = config.currentSeasonId;
        subscribeWeeks(viewedSeasonId);
      }
      await ensureSeasonLoaded(config.currentSeasonId);
      await ensureSeasonLoaded(viewedSeasonId);
      renderSeasonSwitcher();
      renderAll();
    });

    DB.watchPlayers((p) => { players = p; renderAll(); });

    document.title = CFG.siteName;
    wireStaticUI();
  }

  // Kept as a LIVE subscription per season (not one-shot) so admin edits to
  // season name/day/time/deadline reflect everywhere immediately.
  let seasonUnsubs = {};
  function ensureSeasonLoaded(seasonId) {
    if (!seasonId) return Promise.resolve(null);
    if (seasonUnsubs[seasonId]) return Promise.resolve(seasonsCache[seasonId]);
    return new Promise(resolve => {
      let first = true;
      seasonUnsubs[seasonId] = DB.watchSeason(seasonId, (s) => {
        seasonsCache[seasonId] = s;
        if (first) { first = false; resolve(s); }
        else { renderSeasonSwitcher(); renderAll(); }
      });
    });
  }

  function switchViewedSeason(seasonId) {
    viewedSeasonId = seasonId;
    ensureSeasonLoaded(seasonId).then(() => { subscribeWeeks(seasonId); renderSeasonSwitcher(); });
  }

  function subscribeWeeks(seasonId) {
    if (weeksUnsub) weeksUnsub();
    weeks = [];
    weeksUnsub = DB.watchWeeks(seasonId, (w) => {
      weeks = w; subscribeAllRsvps(); renderAll();
      if (seasonId === config.currentSeasonId) checkAutoReminders();
    });
  }

  // RSVP docs for every non-off week in view, kept live so counts/pills update instantly.
  let rsvpUnsubs = [];
  let rsvpsByWeek = {}; // weekId -> {playerId: {status, respondedAt}}
  function subscribeAllRsvps() {
    rsvpUnsubs.forEach(u => u());
    rsvpUnsubs = [];
    rsvpsByWeek = {};
    weeks.filter(w => w.type !== "off").forEach(w => {
      const unsub = DB.watchRsvps(viewedSeasonId, w.id, (r) => { rsvpsByWeek[w.id] = r; renderAll(); });
      rsvpUnsubs.push(unsub);
    });
  }

  // =====================================================================
  // DERIVED DATA
  // =====================================================================
  function activePlayers() { return players.filter(p => p.active); }
  function isArchivedView() { return viewedSeasonId !== config.currentSeasonId; }

  function matchResultsForStandings() {
    const results = [];
    const byWeekForH2H = [];
    weeks.forEach(w => {
      const weekEntries = [];
      (w.courts || []).forEach(c => {
        if (!c.winner) return;
        const teamAWin = c.winner === "A";
        c.teamA.forEach(id => { const r = { playerId: id, result: teamAWin ? "win" : "loss", sets: c.sets, opponents: c.teamB }; results.push(r); weekEntries.push(r); });
        c.teamB.forEach(id => { const r = { playerId: id, result: teamAWin ? "loss" : "win", sets: c.sets, opponents: c.teamA }; results.push(r); weekEntries.push(r); });
      });
      if (w.singles && w.singles.winner) {
        const aWin = w.singles.winner === "A";
        const ra = { playerId: w.singles.a, result: aWin ? "win" : "loss", sets: w.singles.sets, opponents: [w.singles.b] };
        const rb = { playerId: w.singles.b, result: aWin ? "loss" : "win", sets: w.singles.sets, opponents: [w.singles.a] };
        results.push(ra, rb); weekEntries.push(ra, rb);
      }
      if (weekEntries.length) byWeekForH2H.push(weekEntries);
    });
    return { results, byWeekForH2H };
  }

  function computeLiveStandings() {
    const { results, byWeekForH2H } = matchResultsForStandings();
    const stats = Algo.computeStandings(activePlayers().map(p => p.id), results);
    stats.sort(Algo.standingsComparator(byWeekForH2H));
    return stats;
  }

  function thisWeek() {
    // The single week (if any) whose courts are generated but not yet archived as "played".
    return weeks.filter(w => w.status === "generated").sort((a, b) => new Date(a.date) - new Date(b.date))[0] || null;
  }
  function pastWeeks() {
    return weeks.filter(w => w.status === "played" || (w.status === "generated" && allScored(w)))
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }
  function allScored(w) {
    const courts = w.courts || [];
    if (!courts.length) return false;
    if (!courts.every(c => c.winner)) return false;
    if (w.singles && !w.singles.winner) return false;
    return true;
  }
  function upcomingOpenWeeks(limit) {
    return weeks.filter(w => w.type !== "off" && w.status === "scheduled")
      .sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, limit == null ? 3 : limit);
  }
  function nextWeekToGenerate() {
    return weeks.filter(w => w.type !== "off" && w.status === "scheduled")
      .sort((a, b) => new Date(a.date) - new Date(b.date))[0] || null;
  }

  // Build partner/opponent/singles history from everything already played,
  // excluding the week we're about to generate.
  function buildHistoryExcluding(weekId) {
    const played = weeks.filter(w => w.id !== weekId && (w.status === "played" || w.status === "generated"));
    return Algo.buildHistory(played.map(w => ({ courts: w.courts || [], singles: w.singles })));
  }
  function buildSinglesHistory() {
    const hist = {};
    weeks.forEach((w, idx) => {
      if (w.singles) {
        [w.singles.a, w.singles.b].forEach(id => {
          hist[id] = hist[id] || { count: 0, lastWeekIndex: -1 };
          hist[id].count += 1;
          hist[id].lastWeekIndex = Math.max(hist[id].lastWeekIndex, idx);
        });
      }
    });
    return hist;
  }

  // =====================================================================
  // RENDER
  // =====================================================================
  function renderAll() {
    renderStandings();
    renderRsvpTab();
    renderThisWeek();
    renderPastMatches();
    if (isAdmin) renderAdmin();
  }

  function renderSeasonSwitcher() {
    const btn = $("#season-btn"); const menu = $(".season-menu");
    if (!btn || !menu) return;
    const cur = seasonsCache[config.currentSeasonId];
    const label = (seasonsCache[viewedSeasonId] && seasonsCache[viewedSeasonId].name) || (cur && cur.name) || "Season";
    btn.firstChild.textContent = label + " · Individual standings ";
    DB.getSeasons().then(list => {
      menu.innerHTML = "";
      list.forEach(s => {
        const b = document.createElement("button");
        b.className = s.id === viewedSeasonId ? "active" : "";
        b.dataset.season = s.id;
        b.innerHTML = `${s.name}<span class="tag">${s.id === config.currentSeasonId ? "CURRENT" : "PAST"}</span>`;
        b.addEventListener("click", () => { switchViewedSeason(s.id); document.getElementById("season-switch").classList.remove("open"); });
        menu.appendChild(b);
      });
    });
  }

  function renderStandings() {
    const body = $("#standings-body"); if (!body) return;
    const stats = computeLiveStandings();
    body.innerHTML = "";
    stats.forEach((s, i) => {
      const rank = i + 1;
      const medalClass = rank === 1 ? "gold" : rank === 2 ? "silver" : rank === 3 ? "bronze" : null;
      const rankHtml = medalClass ? `<span class="medal ${medalClass}">${rank}</span>` : `<span class="rank-plain">${rank}</span>`;
      const p = byId(players, s.playerId);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><div class="rank-cell">${rankHtml}</div></td>
        <td class="player-name">${p ? p.name : "(removed)"}${p && p.singlesOptIn ? '<span class="singles-tag">S</span>' : ""}</td>
        <td class="num pts-badge">${s.points}</td>
        <td class="num">${s.wins}</td>
        <td class="num">${s.losses}</td>
        <td class="num">${s.played}</td>`;
      body.appendChild(tr);
    });
  }

  function renderRsvpTab() {
    const stripEl = $("#season-strip"); const listEl = $("#rsvp-weeks"); const noteEl = $("#rsvp-future-note");
    if (!stripEl || !listEl) return;

    stripEl.innerHTML = "";
    const openIds = new Set(upcomingOpenWeeks().map(w => w.id));
    weeks.forEach(w => {
      let status = "later";
      if (w.type === "off") status = "off";
      else if (w.status === "played" || (w.status === "generated" && allScored(w))) status = "played";
      else if (thisWeek() && w.id === thisWeek().id) status = "played";
      else if (openIds.has(w.id)) status = "open";
      const label = { played: "Played", open: "RSVP open", off: "Off", later: "Upcoming" }[status];
      const el = document.createElement("div");
      el.className = "season-pip"; el.dataset.status = status;
      el.innerHTML = `<span class="d">${fmtDate(w.date)}</span><span class="s">${label}</span>`;
      stripEl.appendChild(el);
    });

    if (isArchivedView()) {
      listEl.innerHTML = `<div class="card new-season-empty"><div class="big">${seasonsCache[viewedSeasonId]?.name || "This season"} has ended</div><p>RSVP is only open for the current season. Switch back to the current season above to sign up.</p></div>`;
      if (noteEl) noteEl.style.display = "none";
      return;
    }
    if (noteEl) noteEl.style.display = "";

    listEl.innerHTML = "";
    const season = seasonsCache[viewedSeasonId] || {};
    upcomingOpenWeeks().forEach(w => {
      const deadlineDate = w.rsvpDeadlineDate || (season.rsvpDeadlineDays != null ? addDays(w.date, season.rsvpDeadlineDays) : null);
      const deadlineTime = w.rsvpDeadlineTime || season.rsvpDeadlineTime || w.time;
      const title = w.type === "championship"
        ? `${fmtDate(w.date)} · ${w.time} — Championship Night`
        : `${fmtDate(w.date)} Match · ${w.time} — ${w.label}`;
      const deadlineText = w.type === "championship"
        ? `Everyone's invited — let us know by ${fmtDateLong(deadlineDate)}`
        : `Reservations close ${fmtDateLong(deadlineDate)} at ${deadlineTime}`;
      const rsvps = rsvpsByWeek[w.id] || {};
      const inCount = Object.values(rsvps).filter(r => r.status === "in").length;

      const card = document.createElement("div");
      card.className = "card rsvp-week-card";
      card.innerHTML = `
        <div class="rsvp-head"><div class="rsvp-title">${title}</div><div class="deadline-pill">${deadlineText}</div></div>
        <div class="rsvp-count" style="padding:0 18px 10px"><b>${inCount}</b> / ${activePlayers().length} confirmed</div>
        <div class="roster-grid"></div>`;
      listEl.appendChild(card);
      const grid = card.querySelector(".roster-grid");
      activePlayers().forEach(p => {
        const state = (rsvps[p.id] && rsvps[p.id].status) || "out";
        const btn = document.createElement("button");
        btn.className = "roster-btn"; btn.dataset.state = state;
        btn.innerHTML = `<span style="display:flex;align-items:center;gap:8px"><span class="dot"></span>${p.name}</span><span class="state-label">${state === "in" ? "IN" : "OUT"}</span>`;
        btn.addEventListener("click", async () => {
          const next = btn.dataset.state === "in" ? "out" : "in";
          btn.dataset.state = next; btn.querySelector(".state-label").textContent = next === "in" ? "IN" : "OUT";
          await DB.setRsvp(viewedSeasonId, w.id, p.id, next);
        });
        grid.appendChild(btn);
      });
    });
  }

  function courtCardHtml(c, opts) {
    opts = opts || {};
    const aName = c.teamA.map(playerName).join(" &amp; ");
    const bName = c.teamB.map(playerName).join(" &amp; ");
    const aWin = c.winner === "A", bWin = c.winner === "B";
    const scoreLine = c.sets ? `<div class="score-line">Final: ${formatSets(c.sets)}</div>` : "";
    return `
      <div class="court-card ${opts.singles ? "singles" : ""}">
        <div class="court-label">${opts.label}</div>
        <div class="side">${aName}${aWin ? '<span class="winner-tag">W</span>' : ""}</div>
        <div class="vs-div">vs</div>
        <div class="side">${bName}${bWin ? '<span class="winner-tag">W</span>' : ""}</div>
        ${scoreLine}
      </div>`;
  }
  function formatSets(sets) { return sets.map(([a, b]) => a + "–" + b).join(", "); }

  function renderThisWeek() {
    const head = $("#thisweek-head"); const grid = $("#week-grid"); const sitoutCard = $("#thisweek-sitout");
    if (!grid) return;
    const w = thisWeek();
    if (!w) {
      head.innerHTML = `<div><h2>No match generated yet</h2><p>Check back once this week's courts are set.</p></div>`;
      grid.innerHTML = ""; if (sitoutCard) sitoutCard.style.display = "none";
      return;
    }
    head.innerHTML = `<div><h2>${fmtDate(w.date)} Match · ${w.time} — ${w.label}</h2><p>Generated from this week's RSVPs</p></div>`;
    let html = (w.courts || []).map((c, i) => courtCardHtml(c, { label: "Court " + (i + 1) })).join("");
    if (w.singles) html += courtCardHtml({ teamA: [w.singles.a], teamB: [w.singles.b], winner: w.singles.winner, sets: w.singles.sets }, { label: "Singles", singles: true });
    grid.innerHTML = html;
    if (sitoutCard) {
      sitoutCard.style.display = w.sitOutPlayerId ? "" : "none";
      if (w.sitOutPlayerId) sitoutCard.querySelector(".sitout-name").textContent = playerName(w.sitOutPlayerId);
    }
  }

  function renderPastMatches() {
    const listEl = $("#past-list"); if (!listEl) return;
    listEl.innerHTML = "";
    pastWeeks().forEach(w => {
      const sec = document.createElement("div"); sec.className = "past-week";
      let cards = (w.courts || []).map((c, i) => courtCardHtml(c, { label: "Court " + (i + 1) })).join("");
      if (w.singles) cards += courtCardHtml({ teamA: [w.singles.a], teamB: [w.singles.b], winner: w.singles.winner, sets: w.singles.sets }, { label: "Singles", singles: true });
      sec.innerHTML = `<div class="past-week-head"><h3>${w.label} — ${fmtDate(w.date)}, ${w.time}</h3><span>Scores entered</span></div><div class="week-grid">${cards}</div>`;
      listEl.appendChild(sec);
    });
    if (!pastWeeks().length) listEl.innerHTML = `<p style="color:var(--muted);font-size:13.5px">No matches played yet this season.</p>`;
  }

  // =====================================================================
  // ADMIN
  // =====================================================================
  function renderAdmin() {
    renderAdminRoster();
    renderAdminThisWeek();
    renderAdminSeasonSettings();
  }

  function renderAdminRoster() {
    const body = $("#admin-roster-body"); if (!body) return;
    body.innerHTML = "";
    players.forEach(p => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td style="font-weight:600">${p.name}</td>
        <td class="contact">${p.email || p.phone || ""}</td>
        <td><label class="toggle"><input type="checkbox" ${p.active ? "checked" : ""} data-action="active" data-id="${p.id}"><span class="track"><span class="knob"></span></span></label></td>
        <td><label class="toggle"><input type="checkbox" ${p.singlesOptIn ? "checked" : ""} data-action="singles" data-id="${p.id}"><span class="track"><span class="knob"></span></span></label></td>
        <td><button class="remove-btn" data-action="remove" data-id="${p.id}">Remove</button></td>`;
      body.appendChild(tr);
    });
    $all('input[data-action="active"]', body).forEach(el => el.addEventListener("change", () => DB.updatePlayer(el.dataset.id, { active: el.checked })));
    $all('input[data-action="singles"]', body).forEach(el => el.addEventListener("change", () => DB.updatePlayer(el.dataset.id, { singlesOptIn: el.checked })));
    $all('button[data-action="remove"]', body).forEach(el => el.addEventListener("click", () => { if (confirm("Remove this player from the active roster? Their history is kept.")) DB.removePlayer(el.dataset.id); }));
  }

  function renderAdminThisWeek() {
    const head = $("#admin-thisweek-head"); const pulledRow = $("#pulled-rsvp-row");
    const genSection = $("#admin-generate-section"); const scoreSection = $("#admin-score-section");
    if (!head) return;

    const generated = thisWeek();
    const target = generated || nextWeekToGenerate();
    if (!target) {
      head.innerHTML = `<div><h2>This Week</h2><p>No upcoming week is scheduled — add one in Match Schedule below.</p></div>`;
      if (pulledRow) pulledRow.innerHTML = "";
      if (genSection) genSection.style.display = "none";
      if (scoreSection) scoreSection.innerHTML = "";
      return;
    }
    head.innerHTML = `<div><h2>This Week — ${fmtDate(target.date)}, ${target.time}</h2><p>${generated ? "Courts are set for this week." : "RSVPs below are pulled automatically from the public RSVP tab — nothing to re-enter unless someone told you directly instead."}</p></div>`;

    if (pulledRow) {
      pulledRow.innerHTML = "";
      const rsvps = rsvpsByWeek[target.id] || {};
      activePlayers().forEach(p => {
        const state = (rsvps[p.id] && rsvps[p.id].status) || "out";
        const pill = document.createElement("span");
        pill.className = "pulled-pill"; pill.dataset.state = state;
        pill.textContent = p.name + (state === "out" ? " · out" : "");
        pill.addEventListener("click", async () => {
          const next = pill.dataset.state === "in" ? "out" : "in";
          await DB.setRsvp(viewedSeasonId, target.id, p.id, next);
        });
        pulledRow.appendChild(pill);
      });
    }

    if (genSection) {
      genSection.style.display = generated ? "none" : "";
      const btn = $("#generate-courts-btn");
      if (btn) btn.onclick = () => generateCourtsFor(target);
    }

    if (scoreSection) renderScoreEntry(scoreSection, generated);
  }

  function renderScoreEntry(container, week) {
    if (!week) { container.innerHTML = ""; return; }
    const matches = (week.courts || []).map((c, i) => ({ ref: { kind: "court", index: i }, label: "Court " + (i + 1), teamA: c.teamA, teamB: c.teamB, sets: c.sets, winner: c.winner }));
    if (week.singles) matches.push({ ref: { kind: "singles" }, label: "Singles", teamA: [week.singles.a], teamB: [week.singles.b], sets: week.singles.sets, winner: week.singles.winner });

    container.innerHTML = matches.map((m, mi) => `
      <div class="card score-card" data-mi="${mi}" style="padding:14px 16px;margin-bottom:10px">
        <div style="font-weight:600;margin-bottom:8px">${m.label}: ${m.teamA.map(playerName).join(" & ")} vs ${m.teamB.map(playerName).join(" & ")}</div>
        <div class="score-inputs">
          ${[0, 1, 2].map(si => `
            <span class="set-pair">
              <input type="number" min="0" max="30" placeholder="-" data-set="${si}" data-side="a" value="${m.sets && m.sets[si] ? m.sets[si][0] : ""}">
              <span>–</span>
              <input type="number" min="0" max="30" placeholder="-" data-set="${si}" data-side="b" value="${m.sets && m.sets[si] ? m.sets[si][1] : ""}">
            </span>`).join("")}
          <button class="admin-action-btn" data-save="${mi}">Save Score</button>
          ${m.winner ? `<span class="winner-tag" style="margin-left:8px">Winner: ${m.winner === "A" ? m.teamA.map(playerName).join(" & ") : m.teamB.map(playerName).join(" & ")}</span>` : ""}
        </div>
      </div>`).join("");

    $all("[data-save]", container).forEach(btn => {
      btn.addEventListener("click", async () => {
        const card = btn.closest(".score-card");
        const sets = [];
        for (let si = 0; si < 3; si++) {
          const a = card.querySelector(`input[data-set="${si}"][data-side="a"]`).value;
          const b = card.querySelector(`input[data-set="${si}"][data-side="b"]`).value;
          if (a !== "" && b !== "") sets.push([Number(a), Number(b)]);
        }
        if (!sets.length) { alert("Enter at least one set score."); return; }
        let aSets = 0, bSets = 0;
        sets.forEach(([a, b]) => { if (a > b) aSets++; else if (b > a) bSets++; });
        const winner = aSets > bSets ? "A" : "B";
        const mi = Number(btn.dataset.save);
        const m = matches[mi];
        await DB.setScore(viewedSeasonId, week.id, week, m.ref, { sets, winner });
        maybeMarkWeekPlayed(week.id);
      });
    });
  }

  async function maybeMarkWeekPlayed(weekId) {
    const w = byId(weeks, weekId);
    if (w && allScored(w)) await DB.updateWeek(viewedSeasonId, weekId, { status: "played" });
  }

  async function generateCourtsFor(week) {
    const rsvps = rsvpsByWeek[week.id] || {};
    const rsvpList = activePlayers()
      .filter(p => rsvps[p.id] && rsvps[p.id].status === "in")
      .map(p => ({ playerId: p.id, respondedAt: rsvps[p.id].respondedAt, sitPriority: false }));

    const n = rsvpList.length;
    if (n < 4) { alert("Not enough confirmed players yet to generate courts (need at least 4)."); return; }

    const plan = Algo.courtPlan(n);
    const sitOuts = Algo.selectSitOuts(rsvpList, plan.sitOut);
    let remaining = rsvpList.map(r => r.playerId).filter(id => !sitOuts.includes(id));

    let singlesPlayers = [];
    if (plan.singles > 0) {
      const eligible = new Set(activePlayers().filter(p => p.singlesOptIn).map(p => p.id));
      const res = Algo.selectSingles(remaining, plan.singles * 2, eligible, buildSinglesHistory(), weeks.indexOf(week));
      if (!res.shortfall) { singlesPlayers = res.chosen; remaining = remaining.filter(id => !singlesPlayers.includes(id)); }
      // shortfall: fold everyone into doubles instead — recompute the plan for a no-singles week.
      else {
        const replan = Algo.courtPlan(remaining.length + singlesPlayers.length);
        plan.courts = replan.courts; plan.singles = 0;
      }
    }

    const history = buildHistoryExcluding(week.id);
    const courts = Algo.generateWeekCourts(remaining, plan.courts, history, { trials: 3000 });
    const singles = singlesPlayers.length === 2 ? { a: singlesPlayers[0], b: singlesPlayers[1], sets: null, winner: null } : null;
    const courtsNoScore = courts.map(c => ({ court: c.court, teamA: c.teamA, teamB: c.teamB, sets: null, winner: null }));

    await DB.generateCourts(viewedSeasonId, week.id, { courts: courtsNoScore, singles, sitOutPlayerId: sitOuts[0] || null });
  }

  let seasonSettingsWired = false;
  function renderAdminSeasonSettings() {
    const season = seasonsCache[viewedSeasonId] || {};
    const nameInput = $("#season-name-input"); const dayInput = $("#season-day-input");
    const timeInput = $("#season-time-input"); const deadlineDaysInput = $("#season-deadline-days-input");
    const deadlineTimeInput = $("#season-deadline-time-input");
    if (nameInput && document.activeElement !== nameInput) nameInput.value = season.name || "";
    if (dayInput && document.activeElement !== dayInput) dayInput.value = season.defaultDay || "Monday";
    if (timeInput && document.activeElement !== timeInput) timeInput.value = season.defaultTime || "";
    if (deadlineDaysInput && document.activeElement !== deadlineDaysInput) deadlineDaysInput.value = season.rsvpDeadlineDays != null ? season.rsvpDeadlineDays : 8;
    if (deadlineTimeInput && document.activeElement !== deadlineTimeInput) deadlineTimeInput.value = season.rsvpDeadlineTime || "";

    if (!seasonSettingsWired && nameInput) {
      seasonSettingsWired = true;
      nameInput.addEventListener("change", () => DB.updateSeason(viewedSeasonId, { name: nameInput.value }));
      dayInput.addEventListener("change", () => DB.updateSeason(viewedSeasonId, { defaultDay: dayInput.value }));
      timeInput.addEventListener("change", () => DB.updateSeason(viewedSeasonId, { defaultTime: timeInput.value }));
      deadlineDaysInput.addEventListener("change", () => DB.updateSeason(viewedSeasonId, { rsvpDeadlineDays: Number(deadlineDaysInput.value) || 0 }));
      deadlineTimeInput.addEventListener("change", () => DB.updateSeason(viewedSeasonId, { rsvpDeadlineTime: deadlineTimeInput.value }));

      const deleteBtn = $("#delete-season-btn");
      if (deleteBtn) deleteBtn.addEventListener("click", async () => {
        const name = (seasonsCache[viewedSeasonId] || {}).name || "this season";
        if (!confirm(`Permanently delete "${name}" and all of its weeks, RSVPs, and scores? This cannot be undone.`)) return;
        const toDelete = viewedSeasonId;
        viewedSeasonId = config.currentSeasonId;
        switchViewedSeason(viewedSeasonId);
        await DB.removeSeason(toDelete);
      });
    }

    // Only an archived (non-current) season can be deleted — the live season
    // everyone's using is never deletable from here, only replaced by starting
    // a new one.
    const deleteBtn2 = $("#delete-season-btn"); const deleteNote = $("#delete-season-note");
    if (deleteBtn2) deleteBtn2.style.display = isArchivedView() ? "" : "none";
    if (deleteNote) deleteNote.style.display = isArchivedView() ? "" : "none";

    const body = $("#schedule-table-body"); if (!body) return;
    body.innerHTML = "";
    weeks.slice().sort((a, b) => new Date(a.date) - new Date(b.date)).forEach(w => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="week-cell">${w.label}</td>
        <td><input type="text" data-field="date" data-id="${w.id}" value="${w.date}"></td>
        <td><input type="text" data-field="time" data-id="${w.id}" value="${w.time}"></td>
        <td><select data-field="type" data-id="${w.id}">
              <option value="regular" ${w.type === "regular" ? "selected" : ""}>Regular</option>
              <option value="off" ${w.type === "off" ? "selected" : ""}>Off</option>
              <option value="championship" ${w.type === "championship" ? "selected" : ""}>Championship</option>
            </select></td>
        <td><button class="remove-btn" data-remove-week="${w.id}">✕</button></td>`;
      body.appendChild(tr);
    });
    $all("input[data-field], select[data-field]", body).forEach(el => {
      el.addEventListener("change", () => DB.updateWeek(viewedSeasonId, el.dataset.id, { [el.dataset.field]: el.value }));
    });
    $all("[data-remove-week]", body).forEach(el => el.addEventListener("click", () => {
      if (confirm("Remove this week from the schedule?")) DB.removeWeek(viewedSeasonId, el.dataset.removeWeek);
    }));
  }

  // =====================================================================
  // STATIC UI WIRING (tabs, admin unlock, season dropdown, add player/week, start season)
  // =====================================================================
  function wireStaticUI() {
    $all(".tab-btn").forEach(btn => btn.addEventListener("click", () => {
      $all(".tab-btn").forEach(b => b.classList.remove("active"));
      $all(".panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      $("#panel-" + btn.dataset.tab).classList.add("active");
    }));

    $(".admin-link").addEventListener("click", () => {
      $all(".tab-btn").forEach(b => b.classList.remove("active"));
      $all(".panel").forEach(p => p.classList.remove("active"));
      $("#panel-admin").classList.add("active");
    });

    $("#admin-unlock-btn").addEventListener("click", async () => {
      const val = $("#admin-pass").value;
      const hash = await sha256(val);
      if (config.adminPasscodeHash && hash !== config.adminPasscodeHash) { alert("Incorrect passcode."); return; }
      if (!config.adminPasscodeHash) { await DB.setAdminPasscodeHash(hash); } // first run: whoever unlocks first sets it
      isAdmin = true;
      $("#admin-lock").style.display = "none";
      $("#admin-content").style.display = "";
      renderAdmin();
    });

    const seasonSwitch = $("#season-switch"), seasonBtn = $("#season-btn");
    seasonBtn.addEventListener("click", (e) => { e.stopPropagation(); seasonSwitch.classList.toggle("open"); });
    document.addEventListener("click", () => seasonSwitch.classList.remove("open"));

    $("#add-player-btn").addEventListener("click", async () => {
      const name = prompt("Player name?"); if (!name) return;
      const contact = prompt("Email or cell? (optional)") || "";
      await DB.addPlayer({ name, email: contact.includes("@") ? contact : "", phone: contact.includes("@") ? "" : contact });
    });

    $("#add-week-btn").addEventListener("click", async () => {
      const season = seasonsCache[viewedSeasonId] || {};
      const n = weeks.filter(w => w.type === "regular").length + 1;
      await DB.addWeek(viewedSeasonId, { label: "Week " + n, date: todayISO(), time: season.defaultTime || "6:00 PM", type: "regular", status: "scheduled" });
    });

    $("#start-new-season-btn").addEventListener("click", async () => {
      const name = prompt("New season name?", "Spring 2027"); if (!name) return;
      const season = seasonsCache[viewedSeasonId] || {};
      const id = await DB.startNewSeason({
        name, defaultDay: season.defaultDay || "Monday", defaultTime: season.defaultTime || "6:00 PM",
        rsvpDeadlineDays: season.rsvpDeadlineDays || 8, rsvpDeadlineTime: season.rsvpDeadlineTime || season.defaultTime || "6:00 PM",
      });
      viewedSeasonId = id;
      alert("New season created — add its Match Schedule in Season Settings below.");
    });
  }

  async function sha256(text) {
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  // =====================================================================
  // EMAIL (EmailJS) — best-effort; silently no-ops if not configured
  // =====================================================================
  function emailConfigured() { return !!(CFG.emailjs && CFG.emailjs.publicKey && CFG.emailjs.serviceId); }

  let emailjsInited = false;
  async function sendEmail(templateId, params) {
    if (!emailConfigured() || !templateId || typeof emailjs === "undefined") return { skipped: true };
    if (!emailjsInited) { emailjs.init({ publicKey: CFG.emailjs.publicKey }); emailjsInited = true; }
    return emailjs.send(CFG.emailjs.serviceId, templateId, params);
  }

  async function sendScheduleEmails(week) {
    const rsvps = rsvpsByWeek[week.id] || {};
    const siteUrl = window.location.href.split("#")[0];
    for (const p of activePlayers()) {
      const status = rsvps[p.id] && rsvps[p.id].status;
      if (status !== "in" || !p.email) continue;
      const isSitOut = week.sitOutPlayerId === p.id;
      const templateId = isSitOut ? CFG.emailjs.sitoutTemplateId : CFG.emailjs.scheduleTemplateId;
      await sendEmail(templateId, { to_email: p.email, to_name: p.name, match_date: fmtDate(week.date), match_time: week.time, site_url: siteUrl });
    }
    await DB.markEmailSent(viewedSeasonId, week.id, "schedule");
  }

  async function sendReminderEmails(week) {
    const siteUrl = window.location.href.split("#")[0];
    const season = seasonsCache[viewedSeasonId] || {};
    const deadline = week.rsvpDeadlineDate || addDays(week.date, season.rsvpDeadlineDays || 8);
    for (const p of activePlayers()) {
      if (!p.email) continue;
      await sendEmail(CFG.emailjs.reminderTemplateId, {
        to_email: p.email, to_name: p.name, match_date: fmtDate(week.date), match_time: week.time,
        deadline: fmtDateLong(deadline), site_url: siteUrl,
      });
    }
    await DB.markEmailSent(viewedSeasonId, week.id, "reminder");
  }

  // Wire the Approve & Send button once the DOM element exists (added by index.html markup).
  document.addEventListener("DOMContentLoaded", () => {
    const approveBtn = document.getElementById("approve-send-email-btn");
    if (approveBtn) approveBtn.addEventListener("click", async () => {
      const w = thisWeek(); if (!w) return;
      approveBtn.disabled = true; approveBtn.textContent = "Sending…";
      await sendScheduleEmails(w);
      approveBtn.textContent = "Sent ✓";
    });
    const reminderBtn = document.getElementById("send-reminder-btn");
    if (reminderBtn) reminderBtn.addEventListener("click", async () => {
      const w = nextWeekToGenerate(); if (!w) return;
      await sendReminderEmails(w);
      reminderBtn.textContent = "Sent ✓";
    });
  });

  // Auto-fire the reminder 3 days before each week's deadline, once per week,
  // checked every time the app loads/refreshes (a client checking in is enough
  // for a once-a-week cadence; see SETUP_GUIDE.md for the always-on alternative).
  const remindersInFlight = new Set();
  function checkAutoReminders() {
    if (!emailConfigured()) return;
    const season = seasonsCache[viewedSeasonId] || {};
    weeks.filter(w => w.type !== "off" && w.status === "scheduled" && !w.emailSentReminder && !remindersInFlight.has(w.id)).forEach(w => {
      const deadline = w.rsvpDeadlineDate || addDays(w.date, season.rsvpDeadlineDays || 8);
      const daysOut = Math.floor((new Date(deadline) - new Date(todayISO())) / 86400000);
      if (daysOut <= 3 && daysOut >= 0) {
        remindersInFlight.add(w.id);
        sendReminderEmails(w).finally(() => remindersInFlight.delete(w.id));
      }
    });
  }

  window.addEventListener("load", init);
})();
