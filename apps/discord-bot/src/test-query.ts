import "dotenv/config";
import { runQuery } from "./query.js";

async function testQuery(question: string): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testing question: "${question}"`);
  console.log("=".repeat(60));

  const startTime = Date.now();

  try {
    const { result, toolCalls } = await runQuery(question);

    console.log(`\n${"-".repeat(60)}`);
    console.log("RESULT:");
    console.log("-".repeat(60));
    console.log(result);
    console.log(`\nTools used: ${toolCalls.length}`);
  } catch (error) {
    console.error("\nERROR:", error instanceof Error ? error.message : error);
  }

  console.log(`\nTotal time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

async function main() {
  const questions = process.argv.slice(2);

  if (questions.length === 0) {
    await testQuery("What are the main AI risk categories covered in this wiki?");
  } else {
    for (const q of questions) {
      await testQuery(q);
    }
  }
}

main().catch(console.error);
