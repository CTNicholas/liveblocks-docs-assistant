import { openai } from "@ai-sdk/openai";
import dotenv from "dotenv";
import { CoreMessage, generateText } from "ai";
import { Octokit } from "@octokit/action";
import fs from "fs";
import { getExecOutput } from "@actions/exec";
import { debug, getInput } from "@actions/core";
import parseGitDiff, {
  AnyChunk,
  ChangedFile,
  Chunk,
  ChunkRange,
  CombinedChunk,
} from "parse-git-diff";

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

  // console.log(pullRequestFiles);

  // Fetch the content of each file
  // const fileContents = await Promise.all(
  //   pullRequestFiles.map(async (file: any) => {
  //     const response = await octokit.repos.getContent({
  //       owner,
  //       repo,
  //       path: file.filename,
  //       ref: `refs/pull/${pull_number}/head`, // Ensures we get the PR version
  //     });
  //
  //     // Content is base64 encoded, so we decode it
  //     const content = Buffer.from(response.data.content, "base64").toString(
  //       "utf-8"
  //     );
  //
  //     return { filename: file.filename, content };
  //   })
  // );

  // console.log(fileContents);

  const markdownFilePaths = pullRequestFiles.map(
    (file: any) => `../../${file.filename}`
  );

  // console.log("\nFiles to diff:", markdownFilePaths);

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
      "--unified=10",
      "--",
      ...markdownFilePaths,
    ],
    { silent: true }
  );

  if (!diff.stdout) {
    console.log("No differences in .md/.mdx files");
    return;
  }

  console.log(`\nDiff output:\n ${diff.stdout}`);

  // console.log("\nChanged files:\n", JSON.stringify(changedFiles, null, 2));

  console.log("Starting AI");
  const improvedDiff = await getFileSuggestions(diff.stdout);
  // console.log(fixes);
  console.log(improvedDiff);
  console.log("AI done");

  // Create an array of changes from the diff output based on patches
  const parsedDiff = parseGitDiff(improvedDiff);

  // Get changed files from parsedDiff (changed files have type 'ChangedFile')
  const changedFiles = parsedDiff.files.filter(
    (file) => file.type === "ChangedFile"
  );

  const generateSuggestionBody = (changes) => {
    const suggestionBody = changes
      .filter(({ type }) => type === "AddedLine" || type === "UnchangedLine")
      .map(({ content }) => content)
      .join("\n");
    // Quadruple backticks allow for triple backticks in a fenced code block in the suggestion body
    // https://docs.github.com/get-started/writing-on-github/working-with-advanced-formatting/creating-and-highlighting-code-blocks#fenced-code-blocks
    return `\`\`\`\`suggestion\n${suggestionBody}\n\`\`\`\``;
  };

  function createSingleLineComment(path, fromFileRange, changes) {
    return {
      path,
      line: fromFileRange.start,
      body: generateSuggestionBody(changes),
    };
  }

  function createMultiLineComment(path, fromFileRange, changes) {
    return {
      path,
      start_line: fromFileRange.start,
      // The last line of the chunk is the start line plus the number of lines in the chunk
      // minus 1 to account for the start line being included in fromFileRange.lines
      line: fromFileRange.start + fromFileRange.lines - 1,
      start_side: "RIGHT",
      side: "RIGHT",
      body: generateSuggestionBody(changes),
    };
  }

  // Fetch existing review comments
  const existingComments = (
    await octokit.pulls.listReviewComments({ owner, repo, pull_number })
  ).data;

  // Function to generate a unique key for a comment
  const generateCommentKey = (comment) =>
    `${comment.path}:${comment.line ?? ""}:${comment.start_line ?? ""}:${
      comment.body
    }`;

  // Create a Set of existing comment keys for faster lookup
  const existingCommentKeys = new Set(existingComments.map(generateCommentKey));

  // Create an array of comments with suggested changes for each chunk of each changed file
  const comments = changedFiles.flatMap(({ path, chunks }) =>
    chunks.flatMap(({ fromFileRange, changes }) => {
      debug(`Starting line: ${fromFileRange.start}`);
      debug(`Number of lines: ${fromFileRange.lines}`);
      debug(`Changes: ${JSON.stringify(changes)}`);

      const comment =
        fromFileRange.lines <= 1
          ? createSingleLineComment(path, fromFileRange, changes)
          : createMultiLineComment(path, fromFileRange, changes);

      // Generate key for the new comment
      const commentKey = generateCommentKey(comment);

      // Check if the new comment already exists
      if (existingCommentKeys.has(commentKey)) {
        return [];
      }

      return [comment];
    })
  );

  // Create a review with the suggested changes if there are any
  if (comments.length > 0) {
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      event: getInput("event").toUpperCase(),
      body: getInput("comment"),
      comments,
    });
  }
}

async function getFileSuggestions(diff: string) {
  const messages: CoreMessage[] = [
    {
      role: "system",
      content: `You are an expert at writing developer documentation. 
      It is your job to improve documentation, fixing typos, grammar, etc.
      
      I will send you a git diff, and you must merge the diff, then create a new diff, fixing any problems.
      Let me reiterate, you must APPLY the changes, then create a NEW diff where you fix it.
      Return the fixed diff, and only that. Nothing else. No code fences either. 
     
      ---
     
      Here is the diff:
      
      ${diff}
      `,
    },
  ];

  try {
    const result = await generateText({
      model: openai("gpt-4o"),
      messages,
    });
    return result.text;
  } catch (err) {
    console.log(err);
    throw new Error("Problem with OpenAI call");
  }
}

async function getFileSuggestions2(changedFiles: ChangedFile[]) {
  const messages: CoreMessage[] = [
    {
      role: "system",
      content: `You are an expert at writing developer documentation. 
      It is your job to improve documentation, fixing typos, grammar, etc.
      
      I will send you an array of changes made to a file, and you must improve these changes.
      Return the exact same array, with your changes applied, and with NOTHING ELSE. 
      Do not surround it with code fences.
     
      ---
     
      Here is the array of changes:
      
      ${JSON.stringify(changedFiles)}
      `,
    },
  ];

  try {
    const result = await generateText({
      model: openai("gpt-4o"),
      messages,
    });
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
  //   return `{
  //   "pull_request": {
  //    "number": 1,
  //    "head": {
  //       "ref": "docs-assistant"
  //     }
  //   }
  // }`;

  return `{ 
  "pull_request": {
   "number": 4,
   "head": {
      "ref": "small-changes"
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
