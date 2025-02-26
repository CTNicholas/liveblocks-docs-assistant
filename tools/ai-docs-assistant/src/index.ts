import { openai } from "@ai-sdk/openai";
import dotenv from "dotenv";
import { CoreMessage, generateText } from "ai";
import { Octokit } from "@octokit/action";
import fs from "fs";
import { getExecOutput } from "@actions/exec";
import { debug, getInput } from "@actions/core";
import parseGitDiff from "parse-git-diff";

setup();
main();

async function main() {
  const messages: CoreMessage[] = [];

  const octokit = new Octokit({
    userAgent: "ai-docs-assistant",
  });

  const eventPayload = JSON.parse(
    process.env.GITHUB_EVENT_PATH
      ? fs.readFileSync(String(process.env.GITHUB_EVENT_PATH), "utf8")
      : EXAMPLE_PR()
  );

  // console.log(eventPayload);

  const [owner, repo] = String(process.env.GITHUB_REPOSITORY).split("/");

  console.log(owner, repo);

  const pull_number = Number(eventPayload.pull_request.number);

  const pullRequestFiles = (
    await octokit.pulls.listFiles({ owner, repo, pull_number })
  ).data.map((file: any) => file.filename);

  const filePaths = pullRequestFiles.map((file: string) => `../../${file}`);
  console.log("Files to diff:", filePaths);

  if (filePaths.length === 0) {
    throw new Error("❌ No changed files detected in PR.");
  }

  const baseCommit = await getExecOutput("git", ["rev-parse", "origin/main"]);
  const headCommit = await getExecOutput("git", [
    "rev-parse",
    "origin/docs-assistant",
  ]);

  console.log(
    `🔍 Comparing commits: ${baseCommit.stdout.trim()} → ${headCommit.stdout.trim()}`
  );

  const diff = await getExecOutput(
    "git",
    ["diff", "--unified=1", "--", ...filePaths],
    { silent: false }
  );

  console.log(
    "🔍 Git Diff Output:",
    diff.stdout || "❌ No differences detected."
  );

  // const baseBranch = eventPayload.pull_request.base.ref;
  // const headBranch = eventPayload.pull_request.head.ref;
  // console.log(`🔍 Comparing ${baseBranch}...${headBranch}`);

  console.log(diff);

  debug(`Diff output: ${diff.stdout}`);

  // Create an array of changes from the diff output based on patches
  const parsedDiff = parseGitDiff(diff.stdout);

  console.log(parsedDiff);

  // Get changed files from parsedDiff (changed files have type 'ChangedFile')
  const changedFiles = parsedDiff.files.filter(
    (file) => file.type === "ChangedFile"
  );

  console.log(changedFiles);

  messages.push({
    role: "system",
    content: "Talk about lemons",
  });

  try {
    // const result = await generateText({
    //   model: openai("gpt-4o"),
    //   messages,
    // });
    // console.log("Result:", result.text);
  } catch (err) {
    console.log(err);
  }
}

function setup() {
  dotenv.config({ path: ".env.local" });

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OpenAI API key is missing");
  }
}

function EXAMPLE_PR() {
  console.log("Using example PR");
  return `{ "pull_request": { "number": 2 } }`;

  return `{
  "action": "opened",
  "pull_request": {
    "number": 2,
    "title": "Docs assistant",
    "user": {
      "login": "CTNicholas"
    },
    "body": "",
    "head": {
      "ref": "docs-assistant"
    },
    "base": {
      "ref": "main"
    }
  }
}
`;
}

//
// async function main() {
//   while (true) {
//     const userInput = await terminal.question('You: ');
//
//     messages.push({ role: 'user', content: userInput });
//
//     const result = streamText({
//       model: openai('gpt-4o'),
//       messages,
//     });
//
//     let fullResponse = '';
//     process.stdout.write('\nAssistant: ');
//     for await (const delta of result.textStream) {
//       fullResponse += delta;
//       process.stdout.write(delta);
//     }
//     process.stdout.write('\n\n');
//
//     messages.push({ role: 'assistant', content: fullResponse });
//   }
// }
//
// main().catch(console.error);
