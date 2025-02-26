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

  console.log(
    "envs",
    process.env.GITHUB_REPOSITORY,
    process.env.GITHUB_EVENT_PATH,
    process.env.GITHUB_TOKEN
  );

  const eventPayload = JSON.parse(
    fs.readFileSync(String(process.env.GITHUB_EVENT_PATH), "utf8")
  );

  const [owner, repo] = String(process.env.GITHUB_REPOSITORY).split("/");

  const pull_number = Number(eventPayload.pull_request.number);

  const pullRequestFiles = (
    await octokit.pulls.listFiles({ owner, repo, pull_number })
  ).data.map((file: any) => file.filename);

  // Get the diff between the head branch and the base branch (limit to the files in the pull request)
  const diff = await getExecOutput(
    "git",
    ["diff", "--unified=1", "--", ...pullRequestFiles],
    { silent: true }
  );

  debug(`Diff output: ${diff.stdout}`);

  // Create an array of changes from the diff output based on patches
  const parsedDiff = parseGitDiff(diff.stdout);

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
