// ============================================================================
// Firestore data layer for The Topspin Open.
// Every call the rest of the app needs goes through window.TopspinDB — the
// UI code (app.js) never touches the Firebase SDK directly, so this file is
// the only place that changes if the backend ever changes.
//
// Firestore layout:
//   config/global                         { currentSeasonId, adminPasscodeHash }
//   players/{playerId}                    { name, email, phone, active, singlesOptIn }
//   seasons/{seasonId}                    { name, defaultDay, defaultTime, rsvpDeadlineDays, rsvpDeadlineTime, startedAt }
//   seasons/{seasonId}/weeks/{weekId}      { label, date, time, type, status, rsvpDeadlineDate,
//                                            rsvpDeadlineTime, sitOutPlayerId, courts, singles,
//                                            emailSentSchedule, emailSentReminder }
//   seasons/{seasonId}/weeks/{weekId}/rsvps/{playerId}   { status: 'in'|'out', respondedAt }
// ============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

function createFirebaseDB(firebaseConfig) {
  const app = initializeApp(firebaseConfig);
  const fs = getFirestore(app);

  // ---------- config ----------
  const configRef = doc(fs, "config", "global");

  async function getConfig() {
    const snap = await getDoc(configRef);
    return snap.exists() ? snap.data() : { currentSeasonId: null, adminPasscodeHash: null };
  }
  function watchConfig(cb) {
    return onSnapshot(configRef, snap => cb(snap.exists() ? snap.data() : {}));
  }
  async function setCurrentSeason(seasonId) {
    await setDoc(configRef, { currentSeasonId: seasonId }, { merge: true });
  }
  async function setAdminPasscodeHash(hash) {
    await setDoc(configRef, { adminPasscodeHash: hash }, { merge: true });
  }

  // ---------- players (roster carries across seasons) ----------
  const playersCol = collection(fs, "players");

  function watchPlayers(cb) {
    return onSnapshot(query(playersCol, orderBy("name")), snap => {
      cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  }
  async function getPlayers() {
    const snap = await getDocs(query(playersCol, orderBy("name")));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  async function addPlayer(data) {
    const ref = doc(playersCol);
    await setDoc(ref, { active: true, singlesOptIn: false, ...data });
    return ref.id;
  }
  async function updatePlayer(playerId, patch) {
    await updateDoc(doc(fs, "players", playerId), patch);
  }
  async function removePlayer(playerId) {
    // Soft-delete: keeps history (past courts reference this id) intact.
    await updateDoc(doc(fs, "players", playerId), { active: false });
  }

  // ---------- seasons ----------
  const seasonsCol = collection(fs, "seasons");

  async function getSeasons() {
    const snap = await getDocs(query(seasonsCol, orderBy("startedAt", "desc")));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  function watchSeason(seasonId, cb) {
    return onSnapshot(doc(fs, "seasons", seasonId), snap => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null));
  }
  async function createSeason(data) {
    const ref = doc(seasonsCol);
    await setDoc(ref, { startedAt: serverTimestamp(), ...data });
    return ref.id;
  }
  async function updateSeason(seasonId, patch) {
    await updateDoc(doc(fs, "seasons", seasonId), patch);
  }

  // ---------- weeks ----------
  function weeksCol(seasonId) { return collection(fs, "seasons", seasonId, "weeks"); }

  function watchWeeks(seasonId, cb) {
    return onSnapshot(query(weeksCol(seasonId), orderBy("date")), snap => {
      cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  }
  async function getWeeks(seasonId) {
    const snap = await getDocs(query(weeksCol(seasonId), orderBy("date")));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  async function addWeek(seasonId, data) {
    const ref = doc(weeksCol(seasonId));
    await setDoc(ref, { status: "scheduled", ...data });
    return ref.id;
  }
  async function updateWeek(seasonId, weekId, patch) {
    await updateDoc(doc(fs, "seasons", seasonId, "weeks", weekId), patch);
  }
  async function removeWeek(seasonId, weekId) {
    await deleteDoc(doc(fs, "seasons", seasonId, "weeks", weekId));
  }

  // ---------- RSVPs ----------
  function rsvpsCol(seasonId, weekId) { return collection(fs, "seasons", seasonId, "weeks", weekId, "rsvps"); }

  function watchRsvps(seasonId, weekId, cb) {
    return onSnapshot(rsvpsCol(seasonId, weekId), snap => {
      const out = {};
      snap.forEach(d => { out[d.id] = d.data(); });
      cb(out);
    });
  }
  async function getRsvps(seasonId, weekId) {
    const snap = await getDocs(rsvpsCol(seasonId, weekId));
    const out = {};
    snap.forEach(d => { out[d.id] = d.data(); });
    return out;
  }
  async function setRsvp(seasonId, weekId, playerId, status) {
    await setDoc(doc(fs, "seasons", seasonId, "weeks", weekId, "rsvps", playerId),
      { status, respondedAt: serverTimestamp() }, { merge: true });
  }

  // ---------- generation / scoring ----------
  async function generateCourts(seasonId, weekId, { courts, singles, sitOutPlayerId }) {
    await updateDoc(doc(fs, "seasons", seasonId, "weeks", weekId), {
      courts, singles: singles || null, sitOutPlayerId: sitOutPlayerId || null,
      status: "generated", generatedAt: serverTimestamp(),
    });
  }
  // matchRef: { kind: 'court', index: 0 } or { kind: 'singles' }
  async function setScore(seasonId, weekId, week, matchRef, { sets, winner }) {
    const courts = (week.courts || []).map(c => ({ ...c }));
    let singles = week.singles ? { ...week.singles } : null;
    if (matchRef.kind === "court") {
      courts[matchRef.index] = { ...courts[matchRef.index], sets, winner };
    } else {
      singles = { ...singles, sets, winner };
    }
    await updateDoc(doc(fs, "seasons", seasonId, "weeks", weekId), { courts, singles });
  }
  async function markEmailSent(seasonId, weekId, kind) {
    const field = kind === "reminder" ? "emailSentReminder" : "emailSentSchedule";
    await updateDoc(doc(fs, "seasons", seasonId, "weeks", weekId), { [field]: true });
  }

  // ---------- new season (roster carries forward automatically since it's a
  // separate top-level collection; nothing to copy) ----------
  async function startNewSeason({ name, defaultDay, defaultTime, rsvpDeadlineDays, rsvpDeadlineTime }) {
    const id = await createSeason({ name, defaultDay, defaultTime, rsvpDeadlineDays, rsvpDeadlineTime });
    await setCurrentSeason(id);
    return id;
  }

  return {
    getConfig, watchConfig, setCurrentSeason, setAdminPasscodeHash,
    watchPlayers, getPlayers, addPlayer, updatePlayer, removePlayer,
    getSeasons, watchSeason, createSeason, updateSeason,
    watchWeeks, getWeeks, addWeek, updateWeek, removeWeek,
    watchRsvps, getRsvps, setRsvp,
    generateCourts, setScore, markEmailSent,
    startNewSeason,
  };
}

window.TopspinDB = { create: createFirebaseDB };
