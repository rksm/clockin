import chrono from "./deps/chrono-node_1.3.5.js"
import { Database } from "lively.storage";
import { date, obj, arr, string } from "lively.lang";

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

  constructor(start, end) {
    this.start = start;
    this.end = end;
  }

  async _updateStartOrEnd(db, what, changes) {
    if (!this[what]) throw new Error(`${what} needed!`);
    if (!this[what]._id) throw new Error(`${what} has no _id!`);
    if (what === "start" && this.end && changes.time && changes.time > this.end.time)
      throw new Error(`Time for start cannot be before time for end!`);
    if (what === "end" && changes.time && changes.time < this.start.time)
      throw new Error(`Time for end cannot be before time for start!`);
    let changed = {...obj.dissoc(this[what], ["_rev"]), ...changes};
    let result = await db.set(changed._id, changed);
    this[what] = changed;
    return result;
  }

  async updateStart(db, changes) { return this._updateStartOrEnd(db, "start", changes); }
  async updateEnd(db, changes) { return this._updateStartOrEnd(db, "end", changes); }

  async remove(db) {
    if (this.start && this.start._id)
      await db.remove(this.start._id);
    if (this.end && this.end._id)
      await db.remove(this.end._id);
  }

  get isDone() { return !!this.end; }

  shortReport() {
    return string.truncate(this.report(), 200).replace(/\n/g, " ");
  }

  report(onlyEndMessage = true) {
    let startDate = new Date(this.start.time),
        startMessage = this.start.message || "", report;
    if (!this.isDone) {
      report = `Session in progress since ${readableDate(startDate)} (${date.relativeTo(startDate, new Date())})`;
      if (startMessage) report += "\n" + startMessage;
      return report;
    }

    let endDate = new Date(this.end.time),
        endMessage = this.end.message || "";

    report = `Session ${readableDate(startDate)} - ${readableDate(endDate)} (${date.relativeTo(startDate, endDate)})`;
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
        }),
        docs = rows.map(ea => ea.doc),
        last = arr.last(docs);

  if (!rows.length) return [];

  if (last.type === "end") {
    last = await db.get(last.clockin);
    docs.push(last);
  }

  docs = docs.reverse(); // from oldest to newest

  let sessions = [];
  for (let i = 0; i < docs.length; i+=2)
    sessions.push(new Session(docs[i], docs[i+1]));

  return sessions.reverse(); // newest to oldest;
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
    {name: 'by_time', version: 1, mapFn: 'function (doc) { emit(doc.time); }'},
    {name: 'start_tasks', version: 1, mapFn: 'function (doc) { doc.type = "start" && emit(doc.time); }'},
    {name: 'end_tasks', version: 1, mapFn: 'function (doc) { doc.type = "end" && emit(doc.time); }'}
  ]);
  return db;
}

async function clockedInData(db) {
  db = await ensureDB(db);
  let {rows: [last]} = await db.query("by_time", {include_docs: true, limit: 1, descending: true});
  return last && last.doc && last.doc.type === "start" ? last.doc : null;
}

export async function clockedInSession(db) {
  let start = await clockedInData(db);
  return start ? new Session(start) : null;
}

export async function clockin(db, message, time = new Date()) {
  db = await ensureDB(db);
  let {rows: [last]} = await db.query("by_time", {include_docs: true, limit: 1, descending: true}),
      lastDoc = last && last.doc;
  if (lastDoc && lastDoc.type === "start") {
    let time = readableDate(lastDoc.time),
        shortMessage = string.truncate(lastDoc.message, 50).replace(/\n/g, "");
    throw new Error(`Already clocked in (${time} – ${shortMessage})`);
  }
  let sessStartData = {time: time.getTime(), type: "start", message};
  await db.add(sessStartData);
  return new Session(sessStartData);
}

export async function clockout(db, message, time = new Date()) {
  let start = await clockedInData(db);
  if (!start) throw new Error(`Not clocked in`);
  let end = {time: time.getTime(), type: "end", message, clockin: start._id};
  await db.add(end);
  return new Session(start, end);
}
