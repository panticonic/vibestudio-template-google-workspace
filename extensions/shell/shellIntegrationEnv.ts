import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type ShellLaunch = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

const scriptRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "vscode-shell-integration");
const shellEnvReportVars = ["PATH", "VIRTUAL_ENV", "CONDA_PREFIX", "NODE_ENV"];

export async function prepareVscodeShellIntegrationLaunch(
  launch: ShellLaunch
): Promise<ShellLaunch> {
  if (launch.args.length > 0) {
    return {
      ...launch,
      env: withBaseVscodeShellIntegrationEnv(launch.env),
    };
  }

  const shell = shellBasename(launch.command);
  const env = withBaseVscodeShellIntegrationEnv(launch.env);
  switch (shell) {
    case "bash":
      return {
        command: launch.command,
        args: ["--init-file", scriptPath("shellIntegration-bash.sh")],
        env: { ...env, VSCODE_INJECTION: "1" },
      };
    case "zsh": {
      const zdotdir = await createZdotdir(env["ZDOTDIR"] || env["HOME"] || tmpdir());
      return {
        command: launch.command,
        args: [],
        env: {
          ...env,
          ZDOTDIR: zdotdir,
          USER_ZDOTDIR: env["ZDOTDIR"] || env["HOME"] || tmpdir(),
          VSCODE_INJECTION: "1",
        },
      };
    }
    case "fish":
      return {
        command: launch.command,
        args: ["--init-command", `source '${fishEscape(scriptPath("shellIntegration.fish"))}'`],
        env,
      };
    case "pwsh":
    case "powershell":
      return {
        command: launch.command,
        args: ["-NoExit", "-Command", `. ${powershellQuote(scriptPath("shellIntegration.ps1"))}`],
        env,
      };
    default:
      return { ...launch, env };
  }
}

export function withBaseVscodeShellIntegrationEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    TERM_PROGRAM: "vscode",
    VSCODE_STABLE: "1",
    VSCODE_NONCE: randomUUID(),
    VSCODE_SHELL_ENV_REPORTING: shellEnvReportVars.join(","),
  };
}

function shellBasename(command: string): string {
  return path.basename(command).replace(/\.exe$/i, "").toLowerCase();
}

function scriptPath(file: string): string {
  return path.join(scriptRoot, file);
}

async function createZdotdir(userZdotdir: string): Promise<string> {
  const dir = path.join(tmpdir(), `vibestudio-vscode-zdotdir-${randomUUID()}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(dir, ".zshenv"),
    `source ${zshQuote(scriptPath("shellIntegration-env.zsh"))}\n`,
    { mode: 0o600 }
  );
  await writeFile(
    path.join(dir, ".zprofile"),
    `source ${zshQuote(scriptPath("shellIntegration-profile.zsh"))}\n`,
    { mode: 0o600 }
  );
  await writeFile(
    path.join(dir, ".zshrc"),
    `source ${zshQuote(scriptPath("shellIntegration-rc.zsh"))}\n`,
    { mode: 0o600 }
  );
  await writeFile(
    path.join(dir, ".zlogin"),
    `source ${zshQuote(scriptPath("shellIntegration-login.zsh"))}\n`,
    { mode: 0o600 }
  );
  await writeFile(
    path.join(dir, ".zlogout"),
    `ZDOTDIR=${zshQuote(userZdotdir)}\n`,
    { mode: 0o600 }
  );
  return dir;
}

function zshQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function fishEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
