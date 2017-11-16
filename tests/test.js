/*global describe,afterEach,it*/
import { expect } from "mocha-es6";
import { Database } from "lively.storage";
import { clockin, syncWithCloud, sessionsBetweenPrinted, clockout } from "clockin";
import { promise, date } from "lively.lang";

function datePrint(d) { return date.format(d, "yyyy-mm-dd HH:MM"); }


describe("clockin, clockout", () => {

  afterEach(() =>
    Promise.all([
      Database.ensureDB("clockin-test-db").destroy(),
      Database.ensureDB("remote-clockin-test-db").destroy()]));

  it("generates sessions", async () => {
    let start = new Date();
    let sess1 = await clockin("clockin-test-db", "start to work");
    expect(sess1.report()).matches(new RegExp(`Session in progress since ${datePrint(start)} .*\nstart to work`, "m"));
    await promise.delay(300);
    let end = new Date();
    let sess2 = await clockout("clockin-test-db", sess1.id, "end of work");
    expect(sess2.report()).matches(new RegExp(`Session ${datePrint(start)} - ${datePrint(end)} .*\nend of work`, "m"));
  });

  it("prints session", async () => {
    let s1 = await clockin("clockin-test-db", "start to work 1");
    await promise.delay(300);
    await clockout("clockin-test-db", s1.id, "end of work 1");
    await promise.delay(300);
    let s2 = await clockin("clockin-test-db", "start to work 2");
    let printed = await sessionsBetweenPrinted("clockin-test-db", "last week", "now"),
        lines = printed.split("\n");
    expect(lines[0]).matches(/^Session in progress since /);
    expect(lines[1]).equals("start to work 2");
    expect(lines[2]).matches(/^Session/);
    expect(lines[3]).equals("end of work 1");
  });

  it("syncs with another DB", async () => {
    let s1 = await clockin("clockin-test-db", "start to work 1");
    await promise.delay(100);
    await clockout("clockin-test-db", s1.id, "end of work 1");
    await syncWithCloud("clockin-test-db", "remote-clockin-test-db");
  
    let remoteDB = Database.ensureDB("remote-clockin-test-db");
    let docs = (await remoteDB.getAll()).filter(ea => !ea._id.startsWith("_"));
    expect(docs).containSubset([{startMessage: "start to work 1", endMessage: "end of work 1"}]);
  });

});