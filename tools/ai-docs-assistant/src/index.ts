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
  const octokit = new Octokit({
    userAgent: "ai-docs-assistant",
  });

  const eventPayload = JSON.parse(
    process.env.GITHUB_EVENT_PATH
      ? fs.readFileSync(String(process.env.GITHUB_EVENT_PATH), "utf8")
      : EXAMPLE_PR()
  );

  const [owner, repo] = String(process.env.GITHUB_REPOSITORY).split("/");
  console.log("\nRepo:", `${owner}/${repo}`);

  const pull_number = Number(eventPayload.pull_request.number);

  // Get file paths, from repo root
  const pullRequestFiles = (
    await octokit.pulls.listFiles({ owner, repo, pull_number })
  ).data.filter(
    (file: any) =>
      file.filename.toLowerCase().endsWith(".md") ||
      file.filename.toLowerCase().endsWith(".mdx")
  );

  console.log(pullRequestFiles);

  // Fetch the content of each file
  const fileContents = await Promise.all(
    pullRequestFiles.map(async (file: any) => {
      const response = await octokit.repos.getContent({
        owner,
        repo,
        path: file.filename,
        ref: `refs/pull/${pull_number}/head`, // Ensures we get the PR version
      });

      // Content is base64 encoded, so we decode it
      const content = Buffer.from(response.data.content, "base64").toString(
        "utf-8"
      );

      return { filename: file.filename, content };
    })
  );

  console.log(fileContents);

  const markdownFilePaths = pullRequestFiles.map(
    (file: any) => `../../${file.filename}`
  );

  console.log("\nFiles to diff:", markdownFilePaths);

  if (markdownFilePaths.length === 0) {
    console.log("No changed .md/.mdx files");
    return;
  }

  // Get diff
  const diff = await getExecOutput(
    "git",
    [
      "diff",
      "origin/main",
      `origin/${eventPayload.pull_request.head.ref}`,
      "--unified=1",
      "--",
      ...markdownFilePaths,
    ],
    { silent: false }
  );

  if (!diff.stdout) {
    console.log("No differences in .md/.mdx files");
    return;
  }

  debug(`\nDiff output:\n ${diff.stdout}`);

  // Create an array of changes from the diff output based on patches
  const changedFiles = parseGitDiff(diff.stdout).files.filter(
    (file) => file.type === "ChangedFile"
  );

  console.log("\nChanged files:\n", JSON.stringify(changedFiles, null, 2));

  const fixes = await getFileSuggestions(fileContents[0], changedFiles[0]);
  console.log(fixes);
}

async function getFileSuggestions(fileContent: any, fileDiff: any) {
  const messages: CoreMessage[] = [
    {
      role: "system",
      content: `You are an expert at writing developer documentation. 
      It is your job to improve documentation, fixing typos, grammar, etc.
      
      Here is a file that has been changed:
      \`\`\`\`
      ${fileContent}
      \`\`\`\`
      
             
      The specific diffs for the file are notated for you here:
      \`\`\`\`
      ${fileDiff}
      \`\`\`\`
      
      You must fix problems that are in any diffs, or are close to them. 
      If something is important to change elsewhere in the file, such as a typo, you can change that too.
      
      Return the newly fixed file.
      `,
    },
  ];

  try {
    const result = await generateText({
      model: openai("gpt-4o"),
      messages,
    });
    console.log("Result:", result.text);
    return result.text;
  } catch (err) {
    console.log(err);
    throw new Error("Problem with OpenAI call");
  }
}

function setup() {
  dotenv.config({ path: ".env.local" });

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OpenAI API key is missing");
  }
}

// You need a real PR open to test this. Add its number and branch name
function EXAMPLE_PR() {
  console.log("Using example PR");
  return `{ 
  "pull_request": {
   "number": 1,
   "head": {
      "ref": "docs-assistant"
    }
  }
}`;
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
