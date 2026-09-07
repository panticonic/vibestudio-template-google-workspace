import {
  createGitHubClient,
  type GitHubClient,
  type GitHubIssue as ApiGitHubIssue,
} from "./github.js";
import type { CredentialClient } from "@workspace/runtime/credentials";

export const manifest = {
  scopes: {
    github: ["repo"],
  },
  endpoints: {
    github: [
      { url: "https://api.github.com/repos/*/issues", methods: ["GET", "POST"] },
      { url: "https://api.github.com/repos/*/issues/*", methods: ["GET", "PATCH"] },
    ],
  },
  webhooks: {
    github: [
      { event: "issues", deliver: "onSourceIssue" },
    ],
  },
} as const;

type GitHubOwner = {
  login?: string;
  name?: string;
};

type GitHubRepository = {
  name: string;
  owner: GitHubOwner;
};

/**
 * Issue payload as received from the GitHub webhook OR from the API
 * — the API's `GitHubIssue` is the widest shape, accept it.
 */
type GitHubIssue = ApiGitHubIssue;

type SourceIssueEvent = {
  action: string;
  issue: GitHubIssue;
  repository: GitHubRepository;
  // The integration host can inject the mirror destination alongside the GitHub webhook payload.
  targetOwner: string;
  targetRepo: string;
};

type MirrorIssueParams = {
  /**
   * Caller-supplied credential client. Pass `this.credentials` from a
   * DurableObject or `runtime.credentials` from a workerd worker.
   */
  credentials: CredentialClient;
  sourceOwner: string;
  sourceRepo: string;
  issueNumber: number;
  targetOwner: string;
  targetRepo: string;
};

type MirrorIssueResult = {
  source: {
    owner: string;
    repo: string;
    issueNumber: number;
  };
  target: {
    owner: string;
    repo: string;
    issueNumber: number;
    created: boolean;
    url: string;
  };
};

type MirrorLookupIssue = {
  number: number;
  body?: string | null;
  html_url: string;
  pull_request?: unknown;
};

type CreateOrUpdateIssuePayload = {
  title: string;
  body: string;
  state: "open" | "closed";
};

export async function onSourceIssue(
  event: SourceIssueEvent,
  credentials: CredentialClient,
): Promise<MirrorIssueResult | { skipped: true; reason: string }> {
  if (!shouldMirrorAction(event.action)) {
    return {
      skipped: true,
      reason: `Unsupported action: ${event.action}`,
    };
  }

  const sourceOwner = getRepositoryOwner(event.repository);
  if (!sourceOwner) {
    throw new Error("Webhook payload is missing repository.owner.login");
  }

  if (event.issue.pull_request) {
    return {
      skipped: true,
      reason: "Pull requests are not mirrored by this example",
    };
  }

  return mirrorIssue({
    credentials,
    sourceOwner,
    sourceRepo: event.repository.name,
    issueNumber: event.issue.number,
    targetOwner: event.targetOwner,
    targetRepo: event.targetRepo,
  });
}

export async function mirrorIssue(params: MirrorIssueParams): Promise<MirrorIssueResult> {
  // Source and target both speak GitHub through the same credential
  // audience, so one client suffices.
  const github = createGitHubClient(params.credentials);

  const sourceIssue = await github.getIssue(
    params.sourceOwner,
    params.sourceRepo,
    params.issueNumber,
  );

  if (sourceIssue.pull_request) {
    throw new Error("This example mirrors issues only, not pull requests");
  }

  const marker = buildMirrorMarker(params.sourceOwner, params.sourceRepo, params.issueNumber);
  const existingTargetIssue = await findMirroredIssue(
    github,
    params.targetOwner,
    params.targetRepo,
    marker,
  );

  const payload = buildTargetIssuePayload(
    params.sourceOwner,
    params.sourceRepo,
    sourceIssue,
  );

  if (existingTargetIssue) {
    const updatedIssue = await github.updateIssue(
      params.targetOwner,
      params.targetRepo,
      existingTargetIssue.number,
      payload,
    );

    return {
      source: {
        owner: params.sourceOwner,
        repo: params.sourceRepo,
        issueNumber: params.issueNumber,
      },
      target: {
        owner: params.targetOwner,
        repo: params.targetRepo,
        issueNumber: updatedIssue.number,
        created: false,
        url: updatedIssue.html_url,
      },
    };
  }

  const createdIssue = await github.createIssue(
    params.targetOwner,
    params.targetRepo,
    payload,
  );

  return {
    source: {
      owner: params.sourceOwner,
      repo: params.sourceRepo,
      issueNumber: params.issueNumber,
    },
    target: {
      owner: params.targetOwner,
      repo: params.targetRepo,
      issueNumber: createdIssue.number,
      created: true,
      url: createdIssue.html_url,
    },
  };
}

function shouldMirrorAction(action: string): boolean {
  return action === "opened"
    || action === "edited"
    || action === "reopened"
    || action === "closed";
}

function getRepositoryOwner(repository: GitHubRepository): string | null {
  return repository.owner.login ?? repository.owner.name ?? null;
}

function buildTargetIssuePayload(
  sourceOwner: string,
  sourceRepo: string,
  sourceIssue: GitHubIssue,
): CreateOrUpdateIssuePayload {
  return {
    title: `[${sourceOwner}/${sourceRepo}#${sourceIssue.number}] ${sourceIssue.title}`,
    body: [
      buildMirrorMarker(sourceOwner, sourceRepo, sourceIssue.number),
      `Mirrored from ${sourceOwner}/${sourceRepo}#${sourceIssue.number}`,
      "",
      `Source URL: ${sourceIssue.html_url}`,
      `Original author: @${sourceIssue.user?.login ?? "unknown"}`,
      "",
      sourceIssue.body?.trim() || "_No body provided on the source issue._",
    ].join("\n"),
    state: sourceIssue.state,
  };
}

function buildMirrorMarker(sourceOwner: string, sourceRepo: string, issueNumber: number): string {
  return `<!-- vibestudio-mirror-source: ${sourceOwner}/${sourceRepo}#${issueNumber} -->`;
}

/**
 * Walk pages of issues looking for one whose body contains the
 * mirror marker. Capped at 10 pages × 100 issues; if you outgrow
 * this, replace with a persistent source→target mapping.
 */
async function findMirroredIssue(
  github: GitHubClient,
  owner: string,
  repo: string,
  marker: string,
): Promise<MirrorLookupIssue | null> {
  for (let page = 1; page <= 10; page += 1) {
    const issues = await github.listIssues(owner, repo, {
      state: "all",
      per_page: 100,
      page,
    });
    const match = issues.find((issue) => !issue.pull_request && issue.body?.includes(marker));
    if (match) {
      return {
        number: match.number,
        body: match.body,
        html_url: match.html_url,
        pull_request: match.pull_request,
      };
    }
    if (issues.length < 100) {
      return null;
    }
  }
  throw new Error(
    "Mirror lookup exceeded 10 pages of issues; narrow the target repository or add persistent mapping",
  );
}
