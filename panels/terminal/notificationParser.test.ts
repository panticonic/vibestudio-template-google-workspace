import { describe, expect, it } from "vitest";
import { NotificationStreamParser, parseNotifications } from "./notificationParser.js";

describe("terminal notification parser", () => {
  it("classifies iTerm-style OSC 9 notifications from markers and keywords", () => {
    expect(parseNotifications("\x1b]9;[approval] approve deploy\x07")).toEqual([
      { severity: "approval", message: "approve deploy", source: "osc" },
    ]);
    expect(parseNotifications("\x1b]9;build failed\x07")).toEqual([
      { severity: "failure", message: "build failed", source: "osc" },
    ]);
  });

  it("parses OSC 777 title/body notifications", () => {
    expect(parseNotifications("\x1b]777;notify;Tests;done running\x07")).toEqual([
      { severity: "done", title: "Tests", message: "done running", source: "osc" },
    ]);
  });

  it("parses vibestudio snug OSC parameters", () => {
    expect(parseNotifications("\x1b]1337;snug;sev=waiting;title=Agent+blocked;msg=Needs+input\x07")).toEqual([
      { severity: "waiting", title: "Agent blocked", message: "Needs input", source: "snug" },
    ]);
  });

  it("strips failure markers from visible text", () => {
    expect(parseNotifications("\x1b]9;[failure] command denied\x07")).toEqual([
      { severity: "failure", message: "command denied", source: "osc" },
    ]);
  });

  it("buffers OSC notifications split across terminal chunks", () => {
    const parser = new NotificationStreamParser();

    expect(parser.push("before \x1b]1337;snug;sev=approval;title=Need")).toEqual([]);
    expect(parser.push("+approval;msg=Click+allow\x07 after")).toEqual([
      { severity: "approval", title: "Need approval", message: "Click allow", source: "snug" },
    ]);
  });

  it("keeps parsing after incomplete non-notification output", () => {
    const parser = new NotificationStreamParser();

    expect(parser.push("plain output")).toEqual([]);
    expect(parser.push("\x1b]9;done\x07")).toEqual([
      { severity: "done", message: "done", source: "osc" },
    ]);
  });
});
