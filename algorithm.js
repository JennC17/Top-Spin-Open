// Topspin Open — pairing & standings algorithm.
// Pure functions, no DOM/Firebase dependency, so it can be unit-tested in
// plain Node and then dropped into the browser app unchanged.
// Exposed both as CommonJS (for tests) and as `window.TopspinAlgo` (for the app).

(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  if (typeof root !== "undefined") {
    root.TopspinAlgo = mod;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {

  // ---------- 1. Courts / singles / sit-out counts from attendance ----------
  // Matches the league doc's table exactly (10-16 players) and generalizes
  // sensibly outside that range.
  function courtPlan(n) {
    if (n < 4) return { courts: 0, singles: 0, sitOut: n };
    const r = n % 4;
    if (r === 0) return { courts: n / 4, singles: 0, sitOut: 0 };
    if (r === 1) return { courts: (n - 1) / 4, singles: 0, sitOut: 1 };
    if (r === 2) return { courts: (n - 2) / 4, singles: 1, sitOut: 0 };
    return { courts: (n - 3) / 4, singles: 1, sitOut: 1 }; // r === 3
  }

  // ---------- 2. Sit-out selection ----------
  // rsvps: [{ playerId, respondedAt (ISO or epoch ms), sitPriority (bool) }]
  // Last person to RSVP sits, unless they hold sit-priority (protected)
  // from having sat out the previous time it was needed — in which case
  // skip to the next-latest responder. Priority protects at most one week.
  function selectSitOuts(rsvps, sitOutCount) {
    if (sitOutCount <= 0) return [];
    const sorted = [...rsvps].sort((a, b) => new Date(b.respondedAt) - new Date(a.respondedAt));
    const chosen = [];
    const skipped = [];
    for (const r of sorted) {
      if (chosen.length >= sitOutCount) break;
      if (r.sitPriority) { skipped.push(r); continue; }
      chosen.push(r);
    }
    // If everyone left is protected (small group edge case), take from the
    // protected pool anyway rather than leaving a slot unfilled.
    let i = 0;
    while (chosen.length < sitOutCount && i < skipped.length) {
      chosen.push(skipped[i]); i++;
    }
    return chosen.map(r => r.playerId);
  }

  // ---------- 3. Singles selection (opt-in only) ----------
  // eligiblePool: playerIds from `remaining` who have singlesOptIn = true.
  // singlesHistory: { [playerId]: { count, lastWeekIndex } }
  // Falls back to fewer/no singles matches if not enough opted-in players
  // are present this week (never conscripts a non-opted-in player).
  function selectSingles(remaining, neededPlayers, eligibleSet, singlesHistory, currentWeekIndex) {
    const pool = remaining.filter(id => eligibleSet.has(id));
    if (pool.length < neededPlayers) {
      return { chosen: [], shortfall: true }; // caller folds everyone into doubles instead
    }
    const ranked = [...pool].sort((a, b) => {
      const ha = singlesHistory[a] || { count: 0, lastWeekIndex: -1 };
      const hb = singlesHistory[b] || { count: 0, lastWeekIndex: -1 };
      if (ha.count !== hb.count) return ha.count - hb.count;
      return ha.lastWeekIndex - hb.lastWeekIndex; // longer since they last played singles first
    });
    return { chosen: ranked.slice(0, neededPlayers), shortfall: false };
  }

  // ---------- 4. Doubles pairing (randomized local search) ----------
  // history: { partners: {pairKey: count}, opponents: {pairKey: count}, played: {playerId: count} }
  // standingsPoints: { playerId: points } — only used as a late-season tiebreak.
  function pairKey(a, b) { return a < b ? a + "|" + b : b + "|" + a; }

  function splitCost(four, history) {
    // three ways to split 4 players into two teams of 2; return the best.
    const [a, b, c, d] = four;
    const splits = [
      { teamA: [a, b], teamB: [c, d] },
      { teamA: [a, c], teamB: [b, d] },
      { teamA: [a, d], teamB: [b, c] },
    ];
    let best = null;
    for (const s of splits) {
      const partnerPenalty =
        (history.partners[pairKey(...s.teamA)] || 0) * 100 +
        (history.partners[pairKey(...s.teamB)] || 0) * 100;
      let oppPenalty = 0;
      for (const x of s.teamA) for (const y of s.teamB) {
        oppPenalty += (history.opponents[pairKey(x, y)] || 0) * 10;
      }
      const cost = partnerPenalty + oppPenalty;
      if (!best || cost < best.cost) best = { ...s, cost, partnerPenalty, oppPenalty };
    }
    return best;
  }

  function generateWeekCourts(doublesPlayers, courtsCount, history, opts) {
    opts = opts || {};
    const trials = opts.trials || 3000;
    const standingsPoints = opts.standingsPoints || {};
    const standingsWeight = opts.lateSeasonStandingsWeight || 0; // 0 = ignore (early season)

    if (doublesPlayers.length !== courtsCount * 4) {
      throw new Error(`Expected ${courtsCount * 4} doubles players, got ${doublesPlayers.length}`);
    }
    if (courtsCount === 0) return [];

    let best = null;
    let bestCost = Infinity;
    for (let t = 0; t < trials; t++) {
      const shuffled = shuffle(doublesPlayers.slice());
      const groups = [];
      for (let i = 0; i < courtsCount; i++) groups.push(shuffled.slice(i * 4, i * 4 + 4));

      let totalCost = 0;
      const assignment = groups.map(g => {
        const split = splitCost(g, history);
        totalCost += split.cost;
        if (standingsWeight > 0) {
          const pts = g.map(id => standingsPoints[id] || 0);
          const spread = Math.max(...pts) - Math.min(...pts);
          totalCost += spread * standingsWeight;
        }
        return split;
      });
      // small balance term: variance of games-played among this week's doubles pool
      if (t === 0 || totalCost < bestCost) {
        if (totalCost < bestCost) { bestCost = totalCost; best = assignment; }
      }
    }
    return best.map((s, i) => ({
      court: "Court " + (i + 1),
      teamA: s.teamA,
      teamB: s.teamB,
      isNewPartnersA: (history.partners[pairKey(...s.teamA)] || 0) === 0,
      isNewPartnersB: (history.partners[pairKey(...s.teamB)] || 0) === 0,
    }));
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Build history maps from prior weeks' completed courts (and singles).
  // weeks: [{ courts: [{teamA:[id,id], teamB:[id,id]}], singles: {a,b}|null }]
  function buildHistory(weeks) {
    const partners = {}, opponents = {}, played = {};
    const bump = (map, key) => { map[key] = (map[key] || 0) + 1; };
    for (const w of weeks || []) {
      for (const c of w.courts || []) {
        bump(partners, pairKey(...c.teamA));
        bump(partners, pairKey(...c.teamB));
        for (const x of c.teamA) for (const y of c.teamB) bump(opponents, pairKey(x, y));
        for (const id of [...c.teamA, ...c.teamB]) played[id] = (played[id] || 0) + 1;
      }
      if (w.singles) {
        for (const id of [w.singles.a, w.singles.b]) played[id] = (played[id] || 0) + 1;
      }
    }
    return { partners, opponents, played };
  }

  // ---------- 5. Standings & tiebreakers ----------
  // matchResults: [{ playerId, weekId, result: 'win'|'loss'|'dnp', sets: [[gf,ga],...] }]
  function computeStandings(playerIds, matchResults) {
    const stats = {};
    for (const id of playerIds) {
      stats[id] = { playerId: id, points: 0, wins: 0, losses: 0, played: 0, setsFor: 0, setsAgainst: 0, gamesFor: 0, gamesAgainst: 0 };
    }
    for (const m of matchResults) {
      const s = stats[m.playerId];
      if (!s) continue;
      if (m.result === "win") { s.points += 3; s.wins += 1; s.played += 1; }
      else if (m.result === "loss") { s.points += 1; s.losses += 1; s.played += 1; }
      // 'dnp' / no-show contributes 0 and doesn't increment played
      for (const [gf, ga] of (m.sets || [])) {
        s.gamesFor += gf; s.gamesAgainst += ga;
        if (gf > ga) s.setsFor += 1; else if (ga > gf) s.setsAgainst += 1;
      }
    }
    return Object.values(stats);
  }

  // headToHead(a, b, matchResults): +1 if a beat b more often, -1 reverse, 0 unknown/even.
  function headToHead(aId, bId, matchResultsByWeek) {
    let aWins = 0, bWins = 0;
    for (const week of matchResultsByWeek) {
      const a = week.find(r => r.playerId === aId);
      const b = week.find(r => r.playerId === bId);
      if (!a || !b || !a.opponents || !a.opponents.includes(bId)) continue;
      if (a.result === "win") aWins++;
      else if (b.result === "win") bWins++;
    }
    if (aWins === bWins) return 0;
    return aWins > bWins ? 1 : -1;
  }

  function standingsComparator(matchResultsByWeek) {
    return function (a, b) {
      if (b.points !== a.points) return b.points - a.points;
      if (b.wins !== a.wins) return b.wins - a.wins;
      const h2h = headToHead(a.playerId, b.playerId, matchResultsByWeek || []);
      if (h2h !== 0) return -h2h;
      const setDiffA = a.setsFor - a.setsAgainst, setDiffB = b.setsFor - b.setsAgainst;
      if (setDiffB !== setDiffA) return setDiffB - setDiffA;
      const gameDiffA = a.gamesFor - a.gamesAgainst, gameDiffB = b.gamesFor - b.gamesAgainst;
      return gameDiffB - gameDiffA;
    };
  }

  return {
    courtPlan,
    selectSitOuts,
    selectSingles,
    generateWeekCourts,
    buildHistory,
    computeStandings,
    standingsComparator,
    headToHead,
    pairKey,
  };
});
