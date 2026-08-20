import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const root = process.cwd();
const key = process.env.OPENAI_API_KEY;

if (!key) {
  throw new Error("OPENAI_API_KEY is not loaded.");
}

const READ_PREFIXES = [
  "packages/providers/",
  "packages/agent-core/src/",
  "packages/shared/src/",
  "config/models/",
  "tests/",
  "apps/server/src/routes/agent.ts",
  "apps/server/src/routes/tasks.ts",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  ".env.example",
];

const WRITE_PATHS = new Set([
  "packages/agent-core/src/types.ts",
  "packages/agent-core/src/agent-loop.ts",

  "packages/providers/src/interfaces.ts",
  "packages/providers/src/openai-provider.ts",
  "packages/providers/src/provider-registry.ts",
  "packages/providers/src/index.ts",

  "packages/shared/src/types.ts",
  "packages/shared/src/config.ts",
  "packages/shared/src/model-aliases.ts",

  "config/models/default.yaml",

  "tests/provider-registry.test.ts",
  "tests/model-aliases.test.ts",
  "tests/openai-provider.test.ts",

  ".env.example",
]);

const readVersions = new Map();

const timestamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");

const backupRoot = path.join(
  root,
  ".dacai",
  "openai-sol-bootstrap",
  timestamp,
);

function normalize(input) {
  return input
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
}

function absolute(input) {
  const relative = normalize(input);
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);

  if (
    rel.startsWith("..") ||
    path.isAbsolute(rel)
  ) {
    throw new Error(
      `Path escapes repository: ${input}`
    );
  }

  return {
    relative: normalize(rel),
    target,
  };
}

function canRead(relative) {
  if (
    relative === ".env" ||
    relative.startsWith(".git/") ||
    relative.startsWith("node_modules/")
  ) {
    return false;
  }

  return READ_PREFIXES.some(
    allowed =>
      relative === allowed ||
      relative.startsWith(allowed)
  );
}

function canWrite(relative) {
  return WRITE_PATHS.has(relative);
}

function sha(bytes) {
  return crypto
    .createHash("sha256")
    .update(bytes)
    .digest("hex");
}

async function readFileTool(args) {
  const { relative, target } =
    absolute(args.path);

  if (!canRead(relative)) {
    throw new Error(
      `Read not allowed: ${relative}`
    );
  }

  const bytes =
    await fs.readFile(target);

  if (bytes.length > 500_000) {
    throw new Error(
      `File too large for bootstrap read: ${relative}`
    );
  }

  const hash = sha(bytes);

  readVersions.set(
    relative,
    hash,
  );

  return {
    path: relative,
    sha256: hash,
    content: bytes.toString("utf8"),
  };
}

async function listFilesTool(args) {
  const { relative, target } =
    absolute(args.path);

  if (!canRead(relative)) {
    throw new Error(
      `List not allowed: ${relative}`
    );
  }

  const recursive =
    args.recursive === true;

  const result = [];

  async function walk(directory, depth) {
    const entries =
      await fs.readdir(
        directory,
        {
          withFileTypes: true,
        }
      );

    for (const entry of entries) {
      const full =
        path.join(
          directory,
          entry.name
        );

      const rel =
        normalize(
          path.relative(
            root,
            full
          )
        );

      if (
        rel.startsWith("node_modules/") ||
        rel.startsWith(".git/")
      ) {
        continue;
      }

      result.push(
        entry.isDirectory()
          ? `${rel}/`
          : rel
      );

      if (
        recursive &&
        entry.isDirectory() &&
        depth < 4
      ) {
        await walk(
          full,
          depth + 1
        );
      }

      if (result.length >= 500) {
        return;
      }
    }
  }

  await walk(
    target,
    0
  );

  return {
    path: relative,
    entries: result,
    truncated:
      result.length >= 500,
  };
}

async function writeFileTool(args) {
  const { relative, target } =
    absolute(args.path);

  if (!canWrite(relative)) {
    throw new Error(
      `WRITE REFUSED: ${relative}`
    );
  }

  if (
    typeof args.content !== "string"
  ) {
    throw new Error(
      "content must be a string"
    );
  }

  let existing = null;

  try {
    existing =
      await fs.readFile(target);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  /*
   * If the file already exists, Sol must have read it first and
   * supply that exact hash. This prevents overwriting newer work.
   */
  if (existing) {
    const observed =
      sha(existing);

    const expected =
      args.expected_sha256;

    const lastRead =
      readVersions.get(relative);

    if (
      typeof expected !== "string" ||
      expected !== observed ||
      lastRead !== observed
    ) {
      throw new Error(
        [
          `OPTIMISTIC WRITE REFUSED: ${relative}`,
          `current=${observed}`,
          `expected=${expected ?? "<missing>"}`,
          `lastRead=${lastRead ?? "<not-read>"}`,
          "Read the file again before editing it.",
        ].join("\n")
      );
    }

    const backup =
      path.join(
        backupRoot,
        relative
      );

    await fs.mkdir(
      path.dirname(backup),
      {
        recursive: true,
      }
    );

    await fs.writeFile(
      backup,
      existing
    );
  }

  await fs.mkdir(
    path.dirname(target),
    {
      recursive: true,
    }
  );

  await fs.writeFile(
    target,
    args.content,
    "utf8"
  );

  const written =
    await fs.readFile(target);

  const hash =
    sha(written);

  readVersions.set(
    relative,
    hash
  );

  return {
    path: relative,
    written: true,
    sha256: hash,
    backupCreated:
      Boolean(existing),
  };
}

function runProcess(
  executable,
  args,
) {
  return new Promise(
    (resolve) => {
      const child =
        spawn(
          executable,
          args,
          {
            cwd: root,
            env: process.env,
            shell: false,
            windowsHide: true,
          }
        );

      let stdout = "";
      let stderr = "";

      child.stdout.on(
        "data",
        chunk => {
          stdout += chunk;
        }
      );

      child.stderr.on(
        "data",
        chunk => {
          stderr += chunk;
        }
      );

      child.on(
        "close",
        code => {
          resolve({
            exitCode: code,
            stdout:
              stdout.slice(-30000),
            stderr:
              stderr.slice(-30000),
          });
        }
      );
    }
  );
}

async function validationTool(args) {
  const pnpm =
    process.platform === "win32"
      ? "pnpm.cmd"
      : "pnpm";

  switch (args.name) {
    case "provider_typecheck":
      return runProcess(
        pnpm,
        [
          "--filter",
          "@dacai-local-agent/providers",
          "exec",
          "tsc",
          "--noEmit",
        ]
      );

    case "agent_core_typecheck":
      return runProcess(
        pnpm,
        [
          "--filter",
          "@dacai-local-agent/agent-core",
          "exec",
          "tsc",
          "--noEmit",
        ]
      );

    case "focused_provider_tests":
      return runProcess(
        pnpm,
        [
          "exec",
          "vitest",
          "run",
          "tests/provider-registry.test.ts",
          "tests/model-aliases.test.ts",
          "tests/openai-provider.test.ts",
        ]
      );

    default:
      throw new Error(
        `Unknown validation: ${args.name}`
      );
  }
}

const tools = [
  {
    type: "function",
    name: "read_file",
    description:
      "Read an allowed live repository file. Existing files must be read before they can be overwritten. Returns content and SHA-256.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  },

  {
    type: "function",
    name: "list_files",
    description:
      "List an allowed repository directory.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
        },
        recursive: {
          type: "boolean",
        },
      },
      required: [
        "path",
        "recursive",
      ],
      additionalProperties: false,
    },
    strict: true,
  },

  {
    type: "function",
    name: "write_file",
    description:
      "Create or replace one explicitly allowed integration file. For an existing file, expected_sha256 MUST equal the hash returned by the latest read_file call.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
        },
        expected_sha256: {
          type: [
            "string",
            "null",
          ],
        },
        content: {
          type: "string",
        },
      },
      required: [
        "path",
        "expected_sha256",
        "content",
      ],
      additionalProperties: false,
    },
    strict: true,
  },

  {
    type: "function",
    name: "run_validation",
    description:
      "Run one fixed, non-destructive validation command after implementation.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: [
            "provider_typecheck",
            "agent_core_typecheck",
            "focused_provider_tests",
          ],
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    strict: true,
  },
];

async function request(body) {
  const response =
    await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${key}`,
          "Content-Type":
            "application/json",
        },
        body:
          JSON.stringify(body),
      }
    );

  const json =
    await response.json();

  if (!response.ok) {
    throw new Error(
      `OpenAI ${response.status}: ` +
      (
        json?.error?.message ??
        JSON.stringify(json)
      )
    );
  }

  return json;
}

const task = `
Integrate GPT-5.6 Sol into the LIVE DacaiLocalAgent repository.

CONTINUATION STATE:
A previous GPT-5.6 Sol bootstrap run reached its local tool-call budget after
partially implementing this integration.

The CURRENT WORKTREE is authoritative.

Before editing:
- inspect the provider/config/agent-core files as they exist NOW
- recognize any OpenAI integration already present
- preserve correct partial work
- finish or repair it rather than starting over
- do not recreate files merely because the original task mentions them
- use list_files before guessing test or route filenames
- avoid repeatedly probing nonexistent files
- do not modify unrelated files
- do not undo pre-existing user changes

TARGET RESULT

Add a production-quality OpenAI Responses API provider and register a selectable
provider/model path for:

provider instance: openai_sol
model: gpt-5.6-sol

Keep the existing local Ollama provider and every existing provider intact.

IMPORTANT: inspect the live implementation before changing anything. Do not assume
interfaces from another repository or from an older version.

ARCHITECTURAL REQUIREMENTS

1. Use the existing provider-neutral ModelProvider / ModelChatRequest /
   ModelChatResponse architecture.

2. Use OpenAI's Responses API:
   POST https://api.openai.com/v1/responses

3. Read OPENAI_API_KEY only from process.env at request time or construction time
   consistent with the existing provider architecture.
   Never read, print, rewrite, or expose .env.

4. gpt-5.6-sol must support normalized structured tool calls through the same
   DacaiLocalAgent loop used by Ollama.

5. IMPORTANT TOOL-CALL CORRELATION FIX:
   Inspect agent-core and provider interfaces.
   If the provider-neutral abstraction does not currently preserve a provider
   tool-call/call_id between the assistant tool request and the subsequent tool
   result, add the smallest optional provider-neutral correlation field needed.
   Preserve it through:
     provider response
       -> normalized tool call
       -> agent-loop message history
       -> tool-result message
       -> next provider request

   Existing Ollama/Anthropic providers must remain compatible. Optional fields are
   preferred so they do not need unnecessary behavior changes.

6. The OpenAI provider must correctly translate the complete Dacai message history,
   not depend on a singleton mutable previous_response_id that could mix concurrent
   runs.

   Reconstruct OpenAI Responses input using the provider-neutral history, including
   function_call and function_call_output correlation where applicable.

7. Translate Dacai ToolSchema definitions into strict OpenAI function tools where
   possible.

8. Normalize returned OpenAI function calls into Dacai NormalizedToolCall objects.

9. Normalize text output and usage into ModelChatResponse.

10. Respect AbortSignal.

11. Return useful errors for:
    401/403 authentication/access,
    429 rate limits,
    timeout/network failures,
    malformed Responses output.

12. Capabilities for gpt-5.6-sol must indicate verified structured tool calling so
    resolveAlias(... requireToolCalling:true) admits it to the coding loop.

13. Add a selectable alias named "sol" (or the closest convention used by the live
    alias configuration) pointing to:
      providerInstanceId: openai_sol
      model: gpt-5.6-sol

    DO NOT change the existing default "coder"/local Ollama alias.
    Sol is an additional option.

14. Use an existing paid/cloud UsageClass if one already exists.
    Only extend ProviderKind/UsageClass if the live type system actually requires it.

15. Do not add the OpenAI npm SDK unless the current architecture clearly requires it.
    Native fetch is preferred and avoids a new dependency.

16. Add focused tests for:
    - provider registration / alias resolution
    - normalized text response
    - normalized OpenAI function call
    - call_id correlation into the next request if practical with the existing test style

17. Update .env.example only with variable NAMES/default non-secret configuration
    if helpful. Never copy the real key.

18. Run targeted typechecks and focused provider tests.
    Fix failures caused by this implementation.

DO NOT:
- touch .env
- replace Ollama
- replace Anthropic
- change unrelated application code
- modify security/permission behavior
- loosen tool authorization
- run migrations
- install packages
- rewrite unrelated tests
- hide a compile/test failure

When complete, report:
- files changed
- provider instance id
- alias
- model
- whether tool-call correlation needed an agent-core change
- typecheck results
- focused test results
- exact next command/request needed to invoke alias "sol" through DacaiLocalAgent

Use tools now. Do not merely describe the patch.
`;

let response =
  await request({
    model: "gpt-5.6-sol",

    reasoning: {
      effort: "high",
    },

    instructions:
      "You are performing a tightly scoped provider integration inside a live TypeScript monorepo. Inspect before editing. Preserve existing user work. Use only the provided tools. Do not ask the user questions.",

    input: task,

    tools,

    tool_choice: "auto",

    max_output_tokens: 8000,
  });

let rounds = 0;
let totalCalls = 0;

while (rounds < 50) {
  rounds += 1;

  const calls =
    (response.output ?? [])
      .filter(
        item =>
          item.type ===
          "function_call"
      );

  if (!calls.length) {
    const text =
      (response.output ?? [])
        .flatMap(
          item =>
            Array.isArray(
              item.content
            )
              ? item.content
              : []
        )
        .filter(
          item =>
            item.type ===
            "output_text"
        )
        .map(
          item =>
            item.text ?? ""
        )
        .join("");

    console.log("");
    console.log(
      "=== SOL OPENAI PROVIDER BOOTSTRAP COMPLETE ==="
    );
    console.log(text);
    console.log("");
    console.log(
      `Tool calls executed: ${totalCalls}`
    );
    console.log(
      `Backups: ${backupRoot}`
    );

    process.exit(0);
  }

  const outputs = [];

  for (const call of calls) {
    totalCalls += 1;

    if (totalCalls > 160) {
      throw new Error(
        "Bootstrap tool-call budget exceeded."
      );
    }

    const args =
      JSON.parse(
        call.arguments ?? "{}"
      );

    console.log(
      `SOL TOOL: ${call.name}` +
      (
        args.path
          ? ` ${args.path}`
          : args.name
            ? ` ${args.name}`
            : ""
      )
    );

    let result;

    try {
      switch (call.name) {
        case "read_file":
          result =
            await readFileTool(
              args
            );
          break;

        case "list_files":
          result =
            await listFilesTool(
              args
            );
          break;

        case "write_file":
          result =
            await writeFileTool(
              args
            );
          break;

        case "run_validation":
          result =
            await validationTool(
              args
            );
          break;

        default:
          throw new Error(
            `Unknown tool: ${call.name}`
          );
      }
    } catch (error) {
      result = {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      };
    }

    outputs.push({
      type:
        "function_call_output",
      call_id:
        call.call_id,
      output:
        JSON.stringify(result),
    });
  }

  response =
    await request({
      model: "gpt-5.6-sol",

      previous_response_id:
        response.id,

      reasoning: {
        effort: "high",
      },

      input: outputs,

      tools,

      tool_choice: "auto",

      max_output_tokens: 8000,
    });
}

throw new Error(
  "Sol did not finish within 30 tool rounds."
);

