import chrono from "./deps/chrono-node_1.3.5.js"
import { Database } from "lively.storage";
import { date, obj, arr, string } from "lively.lang";
import { LoadingIndicator } from "lively.components";

/*
let db = await ensureDB("roberts-timetracking/clockin");

await db.getAll()

*/


// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// time helpers

function readableDate(time) {
  if (typeof time === "number") time = new Date(time);
  return date.format(time, "yyyy-mm-dd HH:MM");
}

export function ensureDate(d) {
  if (typeof d === "number") return new Date(d);
  if (typeof d === "string") d = chrono.parse(d);
  if (d instanceof Date) return d;
  // chrono parsed?
  if (Array.isArray(d) && d[0] && d[0].start)
    return d[0].start.date();
  if (Array.isArray(d) && d[0] && d[0].end)
    return d[0].end.date();
  throw new Error(`Cannot convert ${d} to a date object!`)
}


// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// sessions

class Session {

  constructor(sessionData) {
    if (!sessionData) throw new Error("need sessionData");
    if (!sessionData._id) throw new Error("sessionData needs _id");
    if (!sessionData.startTime) throw new Error("sessionData needs startTime");
    this.sessionData = sessionData;
  }

  get isDone() { return !!this.sessionData.endTime; }
  get id() { return this.sessionData._id; }
  get startTime() { return this.sessionData.startTime; }
  get endTime() { return this.sessionData.endTime; }
  get startMessage() { return this.sessionData.startMessage; }
  get endMessage() { return this.sessionData.endMessage; }

  async change(db, changes) {
    let newSessionData = {...this.sessionData, ...changes};
    if (newSessionData.endTime && newSessionData.startTime > newSessionData.endTime)
      throw new Error(`Time for start cannot be before time for end!`);
    delete newSessionData._rev;
    await db.set(newSessionData._id, newSessionData);
    this.sessionData = newSessionData;
    return this;
  }

  remove(db) { return db.remove(this.id); }

  shortReport() {
    return string.truncate(this.report(), 100).replace(/\n/g, " ");
  }

  report(opts = {}) {
    let {onlyEndMessage = true} = opts,
        startDate = new Date(this.sessionData.startTime),
        startMessage = this.sessionData.startMessage || "", report;

    if (!this.isDone) {
      report = `in progress since ${readableDate(startDate)} (${date.relativeTo(startDate, new Date())})`;
      if (startMessage) report += "\n" + startMessage;
      return report;
    }

    let endDate = new Date(this.sessionData.endTime),
        endMessage = this.sessionData.endMessage || "",
        startDay = date.format(startDate, "mmm d"),
        endDay = date.format(endDate, "mmm d"),
        startTime = date.format(startDate, "HH:MM"),
        endTime = date.format(startDate, "HH:MM");

    report = startDay === endDay ?
      `${startDay} ${startTime} - ${endTime}` :
      `${startDay} ${startTime} - ${endDay} ${endTime}`;
    report += ` (${date.relativeTo(startDate, endDate)})`
    if (startMessage && !onlyEndMessage) report += "\n" + startMessage;
    if (endMessage) report += "\n" + endMessage;
    return report;
  }
}

export async function sessionsBetween(db, startDate, endDate) {
  db = await ensureDB(db);
  startDate = ensureDate(startDate);
  endDate = ensureDate(endDate);

  if (endDate > startDate) [startDate, endDate] = [endDate, startDate]

  let {rows} = await db.query("by_time", {
          include_docs: true,
          descending: true,
          startkey: startDate.getTime(),
          endkey: endDate.getTime()
        });
  return rows.map(ea => new Session(ea.doc));
}

export async function sessionsBetweenPrinted(db, startDate, endDate) {
  let sessions = await sessionsBetween(db, startDate, endDate);
  return sessions.map(ea => ea.report()).join("\n");
}

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// state

export async function ensureDB(db) {
  if (db instanceof Database) return db;
  db = Database.ensureDB(db);
  await db.addDesignDocs([
    {name: 'by_time', version: 1, mapFn: 'function (doc) { emit(doc.startTime); }'},
    {name: 'unfinished_tasks', version: 1, mapFn: 'function (doc) { !doc.endTime && emit(doc.startTime); }'}
  ]);
  return db;
}

async function clockedInData(db) {
  db = await ensureDB(db);
  let {rows} = await db.query('unfinished_tasks', {include_docs: true, descending: true});
  return rows.map(ea => ea.doc);
}

export async function clockedInSessions(db) {
  return (await clockedInData(db)).map(ea => new Session(ea));
}

export async function clockin(db, startMessage, time = new Date()) {
  db = await ensureDB(db);
  let sessData = {startTime: time.getTime(), endTime: null, startMessage},
      {id} = await db.add(sessData);
  return new Session({...sessData, _id: id});
}

export async function clockout(db, startedId, endMessage, time = new Date()) {
  db = await ensureDB(db);
  let sessData = await db.get(startedId);
  if (!sessData) throw new Error(`Not clocked in with id ${startedId}`);
  if (sessData.endTime) throw new Error(`Session ${startedId} already marked as done (${readableDate(sessData.endTime)}, ${sessData.endMessage.split("\n")[0]})`);
  delete sessData._rev;
  Object.assign(sessData, {endTime: time.getTime(), endMessage});
  await db.set(sessData._id, sessData);
  return new Session(sessData);
}

export async function syncWithCloudIfOlderThan(db, remoteDBUrl, olderThan) {
  if (typeof sessionStorage !== "undefined") {
    let lastTime = Number(sessionStorage[`clockin-sync-${remoteDBUrl}`]) || 0;
    if (lastTime >= ensureDate(olderThan)) return false;
  }
  await syncWithCloud(db, remoteDBUrl);
  sessionStorage[`clockin-sync-${remoteDBUrl}`] = Date.now();
  return true;
}

export async function syncWithCloud(db, remoteDBUrl) {
  db = await ensureDB(db);
  let i = LoadingIndicator.open("Syncing...");
  let syncReport;
  try {
    syncReport = await db.sync(remoteDBUrl);
  } catch (err) {
    $world.showError(`Syncing to ${remoteDBUrl} failed!\n${err.stack}`);
    return;
  } finally { i.remove(); }
  let {
    push: {docs_written: nSent, start_time, end_time},
    pull: {docs_written: nReceived}
  } = syncReport;
  let conflicts = await db.getConflicts();
  
  $world.setStatusMessage(`sent ${nSent}, received ${nReceived}, ${((end_time - start_time) / 1000).toFixed(1)}secs, ${conflicts.length || "no"} conflicts`);
}
