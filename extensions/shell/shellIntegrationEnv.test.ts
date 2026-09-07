import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  prepareVscodeShellIntegrationLaunch,
  withBaseVscodeShellIntegrationEnv,
} from "./shellIntegrationEnv.js";

describe("VS Code shell integration launch preparation", () => {
  it("adds the base VS Code terminal environment", () => {
    const env = withBaseVscodeShellIntegrationEnv({ PATH: "/bin" });

    expect(env).toMatchObject({
      PATH: "/bin",
      TERM_PROGRAM: "vscode",
      VSCODE_STABLE: "1",
      VSCODE_SHELL_ENV_REPORTING: "PATH,VIRTUAL_ENV,CONDA_PREFIX,NODE_ENV",
    });
    expect(env["VSCODE_NONCE"]).toMatch(/[0-9a-f-]{36}/);
  });

  it("injects bash using VS Code's init file while preserving explicit commands", async () => {
    const interactive = await prepareVscodeShellIntegrationLaunch({
      command: "/bin/bash",
      args: [],
      env: {},
    });
    expect(interactive.args[0]).toBe("--init-file");
    expect(interactive.args[1]).toContain("shellIntegration-bash.sh");
    expect(interactive.env["VSCODE_INJECTION"]).toBe("1");

    const explicit = await prepareVscodeShellIntegrationLaunch({
      command: "/bin/bash",
      args: ["-lc", "echo hi"],
      env: {},
    });
    expect(explicit.args).toEqual(["-lc", "echo hi"]);
    expect(explicit.env["TERM_PROGRAM"]).toBe("vscode");
    expect(explicit.env["VSCODE_INJECTION"]).toBeUndefined();
  });

  it("creates a zsh dotdir that sources VS Code's zsh integration files", async () => {
    const launch = await prepareVscodeShellIntegrationLaunch({
      command: "/bin/zsh",
      args: [],
      env: { HOME: "/home/user" },
    });

    expect(launch.args).toEqual([]);
    expect(launch.env["USER_ZDOTDIR"]).toBe("/home/user");
    expect(launch.env["ZDOTDIR"]).toContain("vibestudio-vscode-zdotdir-");
    await expect(stat(`${launch.env["ZDOTDIR"]}/.zshrc`)).resolves.toBeTruthy();
    await expect(readFile(`${launch.env["ZDOTDIR"]}/.zshrc`, "utf8")).resolves.toContain(
      "shellIntegration-rc.zsh"
    );
  });

  it("injects fish and PowerShell with shell-specific startup arguments", async () => {
    const fish = await prepareVscodeShellIntegrationLaunch({
      command: "/usr/bin/fish",
      args: [],
      env: {},
    });
    expect(fish.args).toEqual([
      "--init-command",
      expect.stringContaining("shellIntegration.fish"),
    ]);

    const pwsh = await prepareVscodeShellIntegrationLaunch({
      command: "/usr/bin/pwsh",
      args: [],
      env: {},
    });
    expect(pwsh.args).toEqual([
      "-NoExit",
      "-Command",
      expect.stringContaining("shellIntegration.ps1"),
    ]);
  });
});
