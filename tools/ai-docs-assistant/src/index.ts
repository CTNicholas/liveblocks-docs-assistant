import { openai } from "@ai-sdk/openai";
import dotenv from "dotenv";
import { CoreMessage, generateText } from "ai";

dotenv.config({ path: ".env.local" });

const messages: CoreMessage[] = [];

console.log(
  "✅ Secret Key Loaded:",
  (process.env.OPENAI_SECRET_KEY as string).replace(/.(?=.{4})/g, "*")
);

//
// const result = generateText({
//   model: openai('gpt-4o'),
//   messages,
// });
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
