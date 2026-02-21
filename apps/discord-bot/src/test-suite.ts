import "dotenv/config";
import { runQuery } from "./query.js";
import { WIKI_BASE_URL } from "./config.js";

// Requires LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY env vars to be set

interface TestCase {
  name: string;
  question: string;
  expectedKeywords: string[];
  shouldFind: boolean;
}

const TEST_CASES: TestCase[] = [
  {
    name: "Find risk categories",
    question: "What are the main risk categories in this wiki?",
    expectedKeywords: ["risk", "accident", "misuse", "structural"],
    shouldFind: true,
  },
  {
    name: "Find specific risk - scheming",
    question: "What is scheming in AI safety?",
    expectedKeywords: ["scheming", "deceptive", "alignment"],
    shouldFind: true,
  },
  {
    name: "Find governance responses",
    question: "What governance responses are discussed?",
    expectedKeywords: ["governance", "policy", "regulation", "intervention"],
    shouldFind: true,
  },
  {
    name: "Handle unknown topic gracefully",
    question: "What does the wiki say about quantum computing?",
    expectedKeywords: [
      "no mention",
      "no information",
      "couldn't find",
      "not covered",
      "no relevant",
      "not discuss",
    ],
    shouldFind: false,
  },
  {
    name: "Find bioweapons risk",
    question: "What does the wiki say about bioweapons risk?",
    expectedKeywords: ["bioweapon", "biological", "pathogen", "biosecurity"],
    shouldFind: true,
  },
  {
    name: "Find compute governance",
    question: "What is compute governance?",
    expectedKeywords: ["compute", "hardware", "chip", "gpu", "governance"],
    shouldFind: true,
  },
  {
    name: "Short simple question",
    question: "What is lock-in?",
    expectedKeywords: ["lock-in", "locked", "irreversible", "path dependence"],
    shouldFind: true,
  },
  {
    name: "Typo resilience",
    question: "What is deceptve alignment?",
    expectedKeywords: ["deceptive", "alignment", "scheming"],
    shouldFind: true,
  },
  {
    name: "Includes wiki links",
    question: "What is scheming?",
    expectedKeywords: [WIKI_BASE_URL],
    shouldFind: true,
  },
  // New test cases exercising knowledge graph tools
  {
    name: "Related pages - deceptive alignment",
    question: "What topics are related to deceptive alignment?",
    expectedKeywords: ["scheming", "alignment", "related", "deceptive"],
    shouldFind: true,
  },
  {
    name: "Entity lookup - organization",
    question: "Tell me about MIRI — what kind of organization is it and what does it do?",
    expectedKeywords: ["miri", "machine intelligence", "research"],
    shouldFind: true,
  },
  {
    name: "Entity search - AI safety organizations",
    question: "Which organizations work on AI safety?",
    expectedKeywords: ["anthropic", "openai", "deepmind", "miri", "organization"],
    shouldFind: true,
  },
  {
    name: "Quantitative facts - Anthropic",
    question: "How many employees does Anthropic have or what is their funding?",
    expectedKeywords: ["anthropic", "billion", "million", "funding", "employee"],
    shouldFind: true,
  },
  {
    name: "Related topics - RLHF backlinks",
    question: "What wiki pages mention or reference RLHF?",
    expectedKeywords: ["rlhf", "reinforcement", "page", "mention"],
    shouldFind: true,
  },
  {
    name: "Resource search - interpretability papers",
    question: "Are there any good papers or resources on mechanistic interpretability?",
    expectedKeywords: ["interpretability", "paper", "mechanistic", "resource"],
    shouldFind: true,
  },
];

function checkKeywords(
  text: string,
  keywords: string[]
): { found: boolean; matched: string[] } {
  const lowerText = text.toLowerCase();
  const matched = keywords.filter((kw) =>
    lowerText.includes(kw.toLowerCase())
  );
  return { found: matched.length > 0, matched };
}

async function runTest(
  test: TestCase
): Promise<{ passed: boolean; details: string }> {
  console.log(`\n📋 Running: ${test.name}`);
  console.log(`   Question: "${test.question}"`);

  try {
    const startTime = Date.now();
    const { result, toolCalls } = await runQuery(test.question);
    const timeMs = Date.now() - startTime;

    console.log(`   Time: ${(timeMs / 1000).toFixed(1)}s`);
    console.log(`   Tools used: ${toolCalls.length}`);

    const { found, matched } = checkKeywords(result, test.expectedKeywords);

    if (test.shouldFind && found) {
      console.log(`   ✅ PASS - Found: ${matched.join(", ")}`);
      return { passed: true, details: `Found: ${matched.join(", ")}` };
    } else if (!test.shouldFind && !found) {
      console.log(`   ✅ PASS - Correctly indicated no relevant content`);
      return { passed: true, details: "Correctly handled missing content" };
    } else if (test.shouldFind && !found) {
      console.log(
        `   ❌ FAIL - Expected keywords not found: ${test.expectedKeywords.join(", ")}`
      );
      console.log(`   Result preview: ${result.slice(0, 200)}...`);
      return {
        passed: false,
        details: `Missing keywords. Got: ${result.slice(0, 100)}...`,
      };
    } else {
      console.log(`   ❌ FAIL - Should not have found content but did`);
      return { passed: false, details: `Unexpected match: ${matched.join(", ")}` };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`   ❌ FAIL - Error: ${msg}`);
    return { passed: false, details: `Error: ${msg}` };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const quickMode = args.includes("--quick");
  const testFilter = args.find((a) => !a.startsWith("--"));

  let testsToRun = TEST_CASES;

  if (quickMode) {
    testsToRun = TEST_CASES.slice(0, 3);
    console.log("🚀 Quick mode: running first 3 tests only");
  } else if (testFilter) {
    testsToRun = TEST_CASES.filter(
      (t) =>
        t.name.toLowerCase().includes(testFilter.toLowerCase()) ||
        t.question.toLowerCase().includes(testFilter.toLowerCase())
    );
    console.log(`🔍 Filter: running tests matching "${testFilter}"`);
  }

  console.log("🧪 LongtermWiki Discord Bot Test Suite");
  console.log("=".repeat(60));
  console.log(`Running ${testsToRun.length} tests`);

  const results: { name: string; passed: boolean; details: string }[] = [];

  for (const test of testsToRun) {
    const result = await runTest(test);
    results.push({ name: test.name, ...result });
  }

  console.log("\n" + "=".repeat(60));
  console.log("📊 SUMMARY");
  console.log("=".repeat(60));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  results.forEach((r) => {
    console.log(`${r.passed ? "✅" : "❌"} ${r.name}`);
    if (!r.passed) console.log(`   ${r.details}`);
  });

  console.log(`\nTotal: ${passed}/${results.length} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
