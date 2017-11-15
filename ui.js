import { sessionsBetween, clockout, clockin, clockedInSession } from "./index.js";
import { Database } from "lively.storage";
import { pt, Color } from "lively.graphics";
import { VerticalLayout, ProportionalLayout, Morph, HorizontalLayout } from "lively.morphic";
import { connect } from "lively.bindings";

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
      db: {},
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
            {type: "list", name: "session list", extent: pt(400, 180), fontSize: 14, itemHeight: 20},
            {top: 180, extent: pt(400, 20),
             layout: new HorizontalLayout({autoResize: false, spacing: 3, direction: "centered"}),
             submorphs: [
               {type: "button", name: "edit button", label: "Edit"},
               {type: "button", name: "remove button", label: "Remove"},
               {type: "button", name: "print button", label: "Print"},
             ]}];
          connect(this.getSubmorphNamed("edit button"), 'fire', this, 'editSession');
          connect(this.getSubmorphNamed("remove button"), 'fire', this, 'removeSession');
          connect(this.getSubmorphNamed("print button"), 'fire', this, 'printSessions');
        }
      }
    }
  }

  printSessions() {
    $world.execCommand("open workspace", {
      content: this.sessions.map(ea => ea.report()).join("\n"),
      title: `clockin sessions | ${this.startTime} - ${this.endTime}`,
      mode: "text"
    });
  }

  async editSession() {
    let sel = this.getSubmorphNamed("session list").selection;
    if (!sel) return;

    var startTime, endTime, startMessage, endMessage;

    startTime = await $world.prompt("start time", {requester: this, input: String(new Date(sel.start.time))});
    if (!startTime) return this.setStatusMessage("canceled");      
    startTime = new Date(startTime).getTime();
    if (isNaN(startTime)) return this.setStatusMessage("invalid start time: " + startTime);      
    

    if (sel.end) {
      endTime = await $world.prompt("end time", {requester: this, input: String(new Date(sel.end.time))});
      if (!endTime) return this.setStatusMessage("canceled");
      endTime = new Date(endTime).getTime();
      if (isNaN(endTime)) return this.setStatusMessage("invalid end time: " + endTime);      
    }

    let message = await $world.prompt("message", {requester: this, input: String(sel.end ? sel.end.message : sel.start.message)});

    let startChanged = startTime !== sel.start.time || (!sel.end && message !== sel.start.message);
    let endChanged = endTime !== sel.end.time || (sel.end && message !== sel.end.message);

    if (!startChanged && !endChanged) return this.setStatusMessage("unchanged");

    if (startChanged) {
      let newStart = {time: startTime};
      if (!sel.end) newStart.message = message;
      await sel.updateStart(this.db, newStart);
    }

    if (endChanged) {
      let newEnd = {time: endTime, message};
      await sel.updateEnd(this.db, newEnd);
    }
    
    let sessions = this.sessions
    this.sessions = [];
    this.sessions = sessions;
    this.getSubmorphNamed("session list").selection = sel;

    this.setStatusMessage("udpated");
  }

  async removeSession() {
    let list = this.getSubmorphNamed("session list"),
        session = list.selection;
    if (!session) return;
    let really = await $world.confirm(`Really remove "${session.shortReport()}"?`);
    if (!really) return;
    try {
      session.remove(this.db);
      list.removeItem(session);
    } catch (err) { this.showError(err); }
  }
}

async function listSince(db) {
  let since = await $world.prompt("List clockin's since", {
    input: "last week",
    historyId: "clocking-listsince",
    useLastInput: true
  });
  if (since === "") since = "last week";
  let startTime = since; let endTime = new Date(),
      sessions = await sessionsBetween(db, endTime, startTime);

  if (!sessions.length) {
    return $world.inform("no sessions in during this time");
  }

  let listEd = new ClockinList({db, sessions, endTime, startTime})
  return listEd.openInWindow({title: `clockin sessions | ${startTime} - ${endTime}`});
}

const commands = [

  {
    name: "[clockin] list since",
    exec(world) {
      let db = Database.ensureDB("roberts-timetracking/clockin");
      return listSince(db);
    }
  },

  {
    name: "[clockin] current",
    async exec(world) {
      let db = Database.ensureDB("roberts-timetracking/clockin"),
          sess = await clockedInSession(db);
      return $world.inform(sess ? sess.report() : "not clocked in");
    }
  },

  {
    name: "[clockin] clockin",
    async exec(world) {
      let db = Database.ensureDB("roberts-timetracking/clockin"),
          sess = await clockedInSession(db);
      if (sess) return $world.inform("already clocked in");
      let message = await $world.prompt("what do you want to do?", {historyId: "clockedin-start-message"});
      if (!message) return $world.setStatusMessage("canceled");
      await clockin(db, message);
      $world.setStatusMessage("clockedin");
    }
  },
  
  {
    name: "[clockin] clockout",
    async exec(world) {
      let db = Database.ensureDB("roberts-timetracking/clockin"),
          sess = await clockedInSession(db);
      if (!sess) return $world.inform("not clocked in");
      let message = await $world.prompt("what did you do?", {input: sess.start.message, historyId: "clockedin-end-message"});
      if (!message) return $world.setStatusMessage("canceled");
      await clockout(db, message);
      $world.setStatusMessage("clockedout");
    }
  }
]

let keybindings = [
  {keys: "Meta-Shift-L c l o c k i", command: "[clockin] clockin"},
  {keys: "Meta-Shift-L c l o c k o", command: "[clockin] clockout"},
  {keys: "Meta-Shift-L c l o c k l", command: "[clockin] list since"},
  {keys: "Meta-Shift-L c l o c k c", command: "[clockin] current"},
]

export function installInWorld(world) {
  world.addCommands(commands);
  world.addKeyBindings(keybindings);
}
