import { openai } from "@ai-sdk/openai";
import dotenv from "dotenv";
import { CoreMessage, generateText } from "ai";

setup();
main();

async function main() {
  const messages: CoreMessage[] = [];

  messages.push({
    role: "system",
    content: "Talk about lemons",
  });
  try {
    const result = await generateText({
      model: openai("gpt-4o"),
      messages,
    });
    console.log("Result:", result.text);
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
