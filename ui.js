import {
  sessionsBetween,
  ensureDB,
  clockedInSessions,
  syncWithCloud,
  syncWithCloudIfOlderThan,
  ensureDate,
  clockout,
  clockin
} from "./index.js";
import { Database } from "lively.storage";
import { pt, Color } from "lively.graphics";
import { ProportionalLayout, Morph, HorizontalLayout } from "lively.morphic";
import { connect } from "lively.bindings";
import { arr, date } from "lively.lang/index.js";

/*

let listEdMorph = await listSince()
installInWorld($world);

*/


class ClockinList extends Morph {

  static get properties() {
    return {
      extent: {defaultValue: pt(400, 200)},
      fill: {defaultValue: Color.lightGray},
      layout: {initialize() { this.layout = new ProportionalLayout(); }},

      startTime: {}, endTime: {},
      db: {}, remoteDBUrl: {},

      sessions: {
        after: ["submorphs"],
        set(sessions) {
          this.setProperty("sessions", sessions);
          this.getSubmorphNamed("session list").items = sessions.map(ea => {
            return {
              isListItem: true,
              string: ea.shortReport(),
              value: ea
            }
          })
        }
      },

      submorphs: {
        initialize() {
          this.submorphs = [
            {
              type: "list", name: "session list",
              extent: pt(400, 180),
              fontSize: 14, itemHeight: 20,
              multiSelect: true, multiSelectWithSimpleClick: true
            },
            {top: 180, extent: pt(400, 20),
             layout: new HorizontalLayout({autoResize: false, spacing: 3, direction: "centered"}),
             submorphs: [
               {type: "button", name: "clockin button", label: "clockin"},
               {type: "button", name: "clockout button", label: "clockout"},
               {type: "button", name: "add button", label: "Add"},
               {type: "button", name: "edit button", label: "Edit"},
               {type: "button", name: "remove button", label: "Remove"},
               {type: "button", name: "print button", label: "Print"},
             ]}];
          connect(this.getSubmorphNamed("clockin button"), 'fire', this, 'clockin');
          connect(this.getSubmorphNamed("clockout button"), 'fire', this, 'clockout');
          connect(this.getSubmorphNamed("add button"), 'fire', this, 'addSession', {converter: () => undefined});
          connect(this.getSubmorphNamed("edit button"), 'fire', this, 'editSession', {converter: () => undefined});
          connect(this.getSubmorphNamed("remove button"), 'fire', this, 'removeSessions');
          connect(this.getSubmorphNamed("print button"), 'fire', this, 'printSessions');
        }
      }
    }
  }

  get isClockinList() { return true; }

  printSessions() {
    let byDay = arr.groupBy(this.sessions, ea => date.format(new Date(ea.startTime), "yyyy-mm-dd ddd"));
    let today = date.format(new Date(), "yyyy-mm-dd ddd");
    let report = [];
    // day = today
    for (let day in byDay) {
      let sessions = byDay[day],
          timeWorked = sessions.reduce((time, ea) => time + (ea.isDone ? ea.endTime - ea.startTime : day === today ? Date.now() - ea.startTime : 0), 0),
          timeWorkedH = timeWorked / (1000*60*60),
          restMins = Math.round((timeWorkedH - Math.floor(timeWorkedH)) * 60);
      report.push(day + `\ntime worked: ${Math.floor(timeWorkedH)} hours${restMins ? ` ${restMins} mins` : ""}\n`);
      // report.push(day + `\ntime worked: ${Math.floor(timeWorkedH)} hours ${restMins} mins\n`);
      report.push({fontWeight: "bold"});
      report.push(sessions.map(ea => ea.report()).join("\n") + "\n\n", null);
    }

    this.world().execCommand("open workspace", {
      content: report,
      title: `clockin sessions | ${this.startTime} - ${this.endTime}`,
      mode: "text"
    });
  }

  async addSession() {
    let session = await clockin(this.db, "", new Date(), new Date(), "...");
    await this.editSession(session);
    await this.update();
    this.focus();
    return session;
  }

  async editSession(session = this.getSubmorphNamed("session list").selection) {
    if (!session) return;

    var startTime, endTime, startMessage, endMessage,
        w = this.world();

    startTime = await w.prompt("start time", {requester: this, input: String(new Date(session.startTime))});
    if (!startTime) return this.setStatusMessage("canceled");
    startTime = new Date(ensureDate(startTime)).getTime();
    if (isNaN(startTime)) return this.setStatusMessage("invalid start time: " + startTime);


    if (session.isDone) {
      endTime = await w.prompt("end time", {requester: this, input: String(new Date(session.endTime))});
      if (!endTime) return this.setStatusMessage("canceled");
      endTime = new Date(ensureDate(endTime)).getTime();
      if (isNaN(endTime)) return this.setStatusMessage("invalid end time: " + endTime);
    }

    let message = await w.editPrompt("message", {requester: this, input: String(session.isDone ? session.endMessage : session.startMessage)});
    if (message === undefined) return this.setStatusMessage("canceled");

    let startChanged = startTime != session.startTime || (!session.isDone && message !== session.startMessage),
        endChanged = endTime != session.endTime || (session.isDone && message !== session.endMessage);

    if (!startChanged && !endChanged) return this.setStatusMessage("unchanged");


    let changes = {};
    if (startChanged) {
      changes.startTime = startTime;
      if (!session.isDone) changes.startMessage = message;
    }

    if (endChanged) {
      changes.endTime = endTime
      changes.endMessage = message;
    }

    await session.change(this.db, changes);

    let sessions = this.sessions
    this.sessions = [];
    this.sessions = sessions;
    this.getSubmorphNamed("session list").selection = session;

    this.setStatusMessage("udpated");
    if (this.remoteDBUrl) await syncWithCloud(this.db, this.remoteDBUrl);
    this.focus();
  }

  async removeSessions() {
    let list = this.getSubmorphNamed("session list"),
        sessions = list.selections;
    if (!sessions.length) return;
    let really = await $world.confirm(`Really remove ${sessions.length} sessions?`);
    if (!really) return;
    try {
      sessions.forEach(ea => { ea.remove(this.db); list.removeItem(ea); });
    } catch (err) { this.showError(err); }
    if (this.remoteDBUrl) await syncWithCloud(this.db, this.remoteDBUrl);
  }

  clockin() { return $world.execCommand("[clockin] clockin"); }

  clockout() {
    let sel = this.get("session list").selection
    if (sel.isDone) return this.setStatusMessage("Already clocked out");
    return $world.execCommand("[clockin] clockout", {session: sel});
  }

  onFocus() {
    this.get("session list").focus();
  }

  async update(startTime = this.startTime, endTime = this.endTime) {
    if (this.remoteDBUrl) {
      await syncWithCloudIfOlderThan(this.db, this.remoteDBUrl, this.syncWithCloudIfOlderThan || "now");
    }
    
    if (startTime === "") startTime = "last week";
    if (endTime === "") endTime = "now";

    let sessions = await sessionsBetween(this.db, endTime, startTime);

    this.startTime = startTime;
    this.endTime = endTime;
    this.sessions = sessions;

    if (this.getWindow())
      this.getWindow().title = `clockin sessions | ${startTime} - ${endTime}`;

    return this;
  }

  async interactiveUpdate() {
    let w = this.world(),
        from = await w.prompt("List clockin's since", {
          input: this.startTime || "last week",
          historyId: "clocking-listsince",
          useLastInput: true
        }),
        to = await w.prompt("List clockin's to", {
          input: this.endTime || "now",
          historyId: "clocking-listtil",
          useLastInput: true
        });
    return this.update(from || "last week", "now");
  }

  get commands() {
    return [
      ...super.commands,
      {
        name: "[clockin list] remove sessions",
        exec: async () => this.removeSessions()
      },

      {
        name: "[clockin list] edit session",
        exec: async () => this.editSession()
      },

      {
        name: "[clockin list] print sessions",
        exec: async () => this.printSessions()
      },

      {
        name: "[clockin list] update",
        exec: async () => this.interactiveUpdate()
      }

    ]
  }

  get keybindings() {
    return [
      ...super.keybindings,
      {keys: "Backspace", command: "[clockin list] remove sessions"},
      {keys: "Enter", command: "[clockin list] edit session"},
      {keys: "p", command: "[clockin list] print sessions"},
      {keys: "g", command: "[clockin list] update"},
    ]
  }
}

const commands = [

  {
    name: "[clockin] list since",
    exec: async (world) => {
      let db = await ensureDB("roberts-timetracking/clockin"),
          remoteDBUrl = 'http://robert.kra.hn:5984/roberts-timetracking-clockin',
          listEd = new ClockinList({db, remoteDBUrl, syncWithCloudIfOlderThan: "3 minutes ago"});
      listEd.openInWindow().activate();
      return listEd.interactiveUpdate();
    }
  },

  {
    name: "[clockin] current",
    async exec(world) {
      let db = await ensureDB("roberts-timetracking/clockin"),
          remoteDBUrl = 'http://robert.kra.hn:5984/roberts-timetracking-clockin';
      await syncWithCloudIfOlderThan(db, remoteDBUrl, "3 minutes ago");
      let sessions = await clockedInSessions(db);
      let report = sessions.length ? sessions.map(ea => ea.report()).join("\n") : "not clocked in";
      return $world.inform(report);
    }
  },

  {
    name: "[clockin] sync with cloud",
    async exec(world) {
      let db = await ensureDB("roberts-timetracking/clockin"),
          remoteDBUrl = 'http://robert.kra.hn:5984/roberts-timetracking-clockin';
      await syncWithCloud(db, remoteDBUrl);
    }
  },

  {
    name: "[clockin] clockin",
    async exec(world) {
      let db = await ensureDB("roberts-timetracking/clockin"),
          remoteDBUrl = 'http://robert.kra.hn:5984/roberts-timetracking-clockin';
      await syncWithCloudIfOlderThan(db, remoteDBUrl, "3 minutes ago");
      let message = await $world.editPrompt("what do you want to do?", {historyId: "clockedin-start-message"});
      if (!message) return $world.setStatusMessage("canceled");
      await clockin(db, message);
      $world.setStatusMessage("clockedin");
      $world.getWindows().filter(ea => ea.targetMorph && ea.targetMorph.isClockinList).forEach(ea => ea.targetMorph.update());
      await syncWithCloud(db, remoteDBUrl);
    }
  },

  {
    name: "[clockin] clockout",
    async exec(world, opts = {}) {
      let {
        dbName = "roberts-timetracking/clockin",
        remoteDBUrl = 'http://robert.kra.hn:5984/roberts-timetracking-clockin',
        syncWithCloud: doSync = true,
        syncWithCloudIfOlder = "3 minutes ago",
        session, clockoutMessage
      } = opts;

      let db = await ensureDB(dbName);

      if (doSync)
        await syncWithCloudIfOlderThan(db, remoteDBUrl, syncWithCloudIfOlder);

      let sessions = await clockedInSessions(db);
      if (!sessions.length) return $world.setStatusMessage("not clocked in");

      let choice;
      if (session) {
        choice = sessions.find(ea => ea.id === session.id);
        if (!choice) return $world.showError(`Cannot find session ${session.id} for clockout`)

      } else {
        let items = sessions.map(ea => ({isListItem: true, string: ea.shortReport(), value: ea})),
            {selected} = await $world.listPrompt("select session", items);
        choice = selected[0];
        if (!choice) return $world.setStatusMessage("canceled");
      }

      let message = clockoutMessage || await $world.editPrompt("what did you do?", {input: choice.startMessage, historyId: "clockedin-end-message"});
      if (!message) return $world.setStatusMessage("canceled");
      await clockout(db, choice.id, message);
      $world.setStatusMessage("clockedout");
      $world.getWindows().filter(ea => ea.targetMorph && ea.targetMorph.isClockinList).forEach(ea => ea.targetMorph.update());
      if (doSync) await syncWithCloud(db, remoteDBUrl);
    }
  }

];

let keybindings = [
  {keys: "Meta-Shift-L c l i", command: "[clockin] clockin"},
  {keys: "Meta-Shift-L c l o", command: "[clockin] clockout"},
  {keys: "Meta-Shift-L c l l", command: "[clockin] list since"},
  {keys: "Meta-Shift-L c l c", command: "[clockin] current"},
  {keys: "Meta-Shift-L c l s y n c", command: "[clockin] sync with cloud"},
];

export function installInWorld(world) {
  world.addCommands(commands);
  world.addKeyBindings(keybindings);
}
