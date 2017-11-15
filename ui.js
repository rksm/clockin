import { sessionsBetween, ensureDate, clockout, clockin, clockedInSession } from "./index.js";
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
            {
              type: "list", name: "session list",
              extent: pt(400, 180),
              fontSize: 14, itemHeight: 20,
              multiSelect: true, multiSelectWithSimpleClick: true
            },
            {top: 180, extent: pt(400, 20),
             layout: new HorizontalLayout({autoResize: false, spacing: 3, direction: "centered"}),
             submorphs: [
               {type: "button", name: "edit button", label: "Edit"},
               {type: "button", name: "remove button", label: "Remove"},
               {type: "button", name: "print button", label: "Print"},
             ]}];
          connect(this.getSubmorphNamed("edit button"), 'fire', this, 'editSession');
          connect(this.getSubmorphNamed("remove button"), 'fire', this, 'removeSessions');
          connect(this.getSubmorphNamed("print button"), 'fire', this, 'printSessions');
        }
      }
    }
  }

  get isClockinList() { return true; }

  printSessions() {
    this.world().execCommand("open workspace", {
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
    startTime = new Date(ensureDate(startTime)).getTime();
    if (isNaN(startTime)) return this.setStatusMessage("invalid start time: " + startTime);


    if (sel.end) {
      endTime = await $world.prompt("end time", {requester: this, input: String(new Date(sel.end.time))});
      if (!endTime) return this.setStatusMessage("canceled");
      endTime = new Date(ensureDate(endTime)).getTime();
      if (isNaN(endTime)) return this.setStatusMessage("invalid end time: " + endTime);
    }

    let message = await $world.editPrompt("message", {requester: this, input: String(sel.end ? sel.end.message : sel.start.message)});

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

  async removeSessions() {
    let list = this.getSubmorphNamed("session list"),
        sessions = list.selections;
    if (!sessions.length) return;
    let really = await $world.confirm(`Really remove ${sessions.length} sessions?`);
    if (!really) return;
    try {
      sessions.forEach(ea => { ea.remove(this.db); list.removeItem(ea); });
    } catch (err) { this.showError(err); }
  }

  onFocus() {
    this.get("session list").focus();
  }

  async update(startTime = "", endTime = "") {
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
    exec(world) {
      let db = Database.ensureDB("roberts-timetracking/clockin"),
          listEd = new ClockinList({db});
      listEd.openInWindow().activate();
      return listEd.interactiveUpdate();
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
      let message = await $world.editPrompt("what do you want to do?", {historyId: "clockedin-start-message"});
      if (!message) return $world.setStatusMessage("canceled");
      await clockin(db, message);
      $world.setStatusMessage("clockedin");
      $world.getWindows().filter(ea => ea.targetMorph && ea.targetMorph.isClockinList).forEach(ea => ea.targetMorph.update());
    }
  },

  {
    name: "[clockin] clockout",
    async exec(world) {
      let db = Database.ensureDB("roberts-timetracking/clockin"),
          sess = await clockedInSession(db);
      if (!sess) return $world.inform("not clocked in");
      let message = await $world.editPrompt("what did you do?", {input: sess.start.message, historyId: "clockedin-end-message"});
      if (!message) return $world.setStatusMessage("canceled");
      await clockout(db, message);
      $world.setStatusMessage("clockedout");
      $world.getWindows().filter(ea => ea.targetMorph && ea.targetMorph.isClockinList).forEach(ea => ea.targetMorph.update());
    }
  }
]

let keybindings = [
  {keys: "Meta-Shift-L c l i", command: "[clockin] clockin"},
  {keys: "Meta-Shift-L c l o", command: "[clockin] clockout"},
  {keys: "Meta-Shift-L c l l", command: "[clockin] list since"},
  {keys: "Meta-Shift-L c l c", command: "[clockin] current"},
]

export function installInWorld(world) {
  world.addCommands(commands);
  world.addKeyBindings(keybindings);
}
