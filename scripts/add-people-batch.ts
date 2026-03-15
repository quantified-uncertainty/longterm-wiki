/**
 * Batch add people to the KB.
 * Usage: npx tsx scripts/add-people-batch.ts
 *
 * Generates:
 * - packages/kb/data/things/{slug}.yaml for each person
 * - Appends to data/entities/people.yaml
 * - Allocates numeric IDs via crux
 */

import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function generateId(): string {
  const REPLACEMENT_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
  const raw = randomBytes(7).toString("base64url").slice(0, 10);
  return raw
    .split("")
    .map((ch) => {
      if (ch === "-" || ch === "_") {
        const byte = randomBytes(1)[0];
        return REPLACEMENT_CHARS[byte % REPLACEMENT_CHARS.length];
      }
      return ch;
    })
    .join("");
}

interface PersonData {
  slug: string;
  name: string;
  bornYear?: number;
  role: string;
  employerSlug?: string; // KB entity slug for !ref lookup
  employerStableId?: string; // will be resolved
  notableFor: string;
  education?: string;
  socialMedia?: string;
  wikipedia?: string;
  website?: string;
  description: string;
}

// Organization stableIds (looked up from existing KB data)
const ORG_STABLE_IDS: Record<string, string> = {};

function lookupOrgStableId(slug: string): string | undefined {
  if (ORG_STABLE_IDS[slug]) return ORG_STABLE_IDS[slug];
  const path = resolve(ROOT, `packages/kb/data/things/${slug}.yaml`);
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, "utf-8");
  const match = content.match(/stableId:\s*(\S+)/);
  if (match) {
    ORG_STABLE_IDS[slug] = match[1];
    return match[1];
  }
  return undefined;
}

function allocateNumericId(slug: string): string {
  // First check if already allocated
  try {
    const checkOutput = execSync(`WIKI_SERVER_ENV=prod pnpm crux ids check ${slug}`, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 30000,
    });
    const existingMatch = checkOutput.match(/E\d+/);
    if (existingMatch) return existingMatch[0];
  } catch {
    // Not found, proceed to allocate
  }

  try {
    const output = execSync(`WIKI_SERVER_ENV=prod pnpm crux ids allocate ${slug}`, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 30000,
    });
    const match = output.match(/E\d+/);
    return match ? match[0] : "";
  } catch (e) {
    console.error(`Failed to allocate ID for ${slug}:`, e);
    return "";
  }
}

const PEOPLE: PersonData[] = [
  {
    slug: "andrej-karpathy",
    name: "Andrej Karpathy",
    bornYear: 1986,
    role: "Founder",
    notableFor: "Former Director of AI at Tesla, former OpenAI researcher; founded Eureka Labs; influential AI educator and researcher",
    education: "PhD in Computer Science, Stanford University",
    socialMedia: "@kaboretsky",
    wikipedia: "https://en.wikipedia.org/wiki/Andrej_Karpathy",
    description: "Andrej Karpathy is a computer scientist and AI researcher known for his work on deep learning and computer vision. He was a founding member of OpenAI and later served as Senior Director of AI at Tesla, leading the Autopilot computer vision team. He returned briefly to OpenAI in 2023 before founding Eureka Labs, an AI education company. His educational content on neural networks has been widely influential in the field.",
  },
  {
    slug: "mustafa-suleyman",
    name: "Mustafa Suleyman",
    bornYear: 1984,
    role: "CEO of Microsoft AI",
    employerSlug: "microsoft",
    notableFor: "Co-founder of DeepMind; CEO of Microsoft AI; founded Inflection AI; advocate for AI safety and governance",
    wikipedia: "https://en.wikipedia.org/wiki/Mustafa_Suleyman",
    description: "Mustafa Suleyman co-founded DeepMind in 2010 and served as its head of Applied AI until 2019. He later founded Inflection AI, which built the Pi conversational AI. In 2024, he joined Microsoft as CEO of Microsoft AI, bringing most of the Inflection team. He is the author of 'The Coming Wave' on AI risks and governance.",
  },
  {
    slug: "jack-clark",
    name: "Jack Clark",
    bornYear: 1988,
    role: "Co-founder",
    employerSlug: "anthropic",
    notableFor: "Co-founder of Anthropic; former Policy Director at OpenAI; creator of the Import AI newsletter; AI policy advocate",
    description: "Jack Clark is a co-founder of Anthropic and a prominent voice in AI policy. Before Anthropic, he served as Policy Director at OpenAI. He writes the widely-read Import AI newsletter covering developments in artificial intelligence. He has been influential in shaping discourse around AI governance and safety policy.",
  },
  {
    slug: "sam-mccandlish",
    name: "Sam McCandlish",
    role: "Co-founder",
    employerSlug: "anthropic",
    notableFor: "Co-founder of Anthropic; co-author of neural scaling laws research; formerly at OpenAI",
    description: "Sam McCandlish is a co-founder of Anthropic. He is known for his foundational research on neural scaling laws, co-authoring influential papers that demonstrated predictable relationships between model size, data, and performance. Before Anthropic, he was a researcher at OpenAI.",
  },
  {
    slug: "jared-kaplan",
    name: "Jared Kaplan",
    role: "Co-founder",
    employerSlug: "anthropic",
    notableFor: "Co-founder of Anthropic; Johns Hopkins physics professor; co-author of neural scaling laws research",
    education: "PhD in Physics, Stanford University",
    description: "Jared Kaplan is a co-founder of Anthropic and a professor of physics at Johns Hopkins University. He is a co-author of the influential neural scaling laws papers that established predictable relationships between compute, data, model size, and AI performance. His physics background brought a rigorous quantitative approach to understanding deep learning.",
  },
  {
    slug: "mira-murati",
    name: "Mira Murati",
    bornYear: 1988,
    role: "Founder",
    notableFor: "Former CTO of OpenAI; led development of ChatGPT, DALL-E, and GPT-4; now building a new AI company",
    education: "BS in Mechanical Engineering, Dartmouth College",
    wikipedia: "https://en.wikipedia.org/wiki/Mira_Murati",
    description: "Mira Murati served as Chief Technology Officer at OpenAI from 2022 to 2024, overseeing the development and launch of ChatGPT, DALL-E, and GPT-4. She briefly served as interim CEO during the November 2023 leadership crisis. She departed OpenAI in September 2024 and is building a new AI venture.",
  },
  {
    slug: "satya-nadella",
    name: "Satya Nadella",
    bornYear: 1967,
    role: "CEO",
    employerSlug: "microsoft",
    notableFor: "CEO of Microsoft; led Microsoft's multi-billion dollar investment in OpenAI; shaped enterprise AI strategy",
    education: "MS in Computer Science, University of Wisconsin-Milwaukee; MBA, University of Chicago",
    wikipedia: "https://en.wikipedia.org/wiki/Satya_Nadella",
    description: "Satya Nadella has been CEO of Microsoft since 2014. Under his leadership, Microsoft invested over $13 billion in OpenAI and integrated AI across its product suite through Copilot. He played a central role in the November 2023 OpenAI board crisis and has been a major force in shaping the commercial AI landscape.",
  },
  {
    slug: "sundar-pichai",
    name: "Sundar Pichai",
    bornYear: 1972,
    role: "CEO",
    notableFor: "CEO of Google and Alphabet; oversees Google DeepMind and Gemini AI development",
    education: "MS in Engineering, Stanford University; MBA, Wharton School",
    wikipedia: "https://en.wikipedia.org/wiki/Sundar_Pichai",
    description: "Sundar Pichai serves as CEO of both Google and its parent company Alphabet. He oversees Google DeepMind and the development of the Gemini family of AI models. He has been a prominent voice on AI governance, calling for regulation while pushing Google's AI capabilities forward.",
  },
  {
    slug: "jensen-huang",
    name: "Jensen Huang",
    bornYear: 1963,
    role: "CEO",
    employerSlug: "nvidia",
    notableFor: "CEO and co-founder of NVIDIA; architect of the GPU computing revolution that enabled modern AI",
    wikipedia: "https://en.wikipedia.org/wiki/Jensen_Huang",
    description: "Jensen Huang co-founded NVIDIA in 1993 and has served as its CEO since. Under his leadership, NVIDIA's GPUs became the dominant hardware platform for training large AI models. NVIDIA's market capitalization grew to over $3 trillion as AI compute demand surged. The company's hardware dominance gives it significant influence over the pace and direction of AI development.",
  },
  {
    slug: "mark-zuckerberg",
    name: "Mark Zuckerberg",
    bornYear: 1984,
    role: "CEO",
    notableFor: "CEO of Meta; leads Meta AI and open-source Llama model development; advocate for open-source AI",
    wikipedia: "https://en.wikipedia.org/wiki/Mark_Zuckerberg",
    description: "Mark Zuckerberg is the founder and CEO of Meta Platforms. He has positioned Meta as a major AI player through its open-source Llama model series and significant investments in AI research. His advocacy for open-source AI models and open compute stands in contrast to the closed approaches of OpenAI and Anthropic, making him a central figure in debates about AI openness and safety.",
  },
  {
    slug: "katja-grace",
    name: "Katja Grace",
    role: "Founder",
    notableFor: "Founder of AI Impacts; conducts research on AI timelines and forecasting; author of influential AI researcher surveys",
    website: "https://aiimpacts.org",
    description: "Katja Grace is the founder of AI Impacts, a research organization that investigates questions about the future of AI. She is known for conducting large-scale surveys of AI researchers about their timeline predictions and for systematic analysis of arguments about AI risk and AI progress.",
  },
  {
    slug: "allan-dafoe",
    name: "Allan Dafoe",
    role: "VP of AI Policy",
    notableFor: "VP of AI Policy at Google DeepMind; founder of the Centre for the Governance of AI (GovAI); leading AI governance researcher",
    education: "PhD in Political Science, Yale University",
    description: "Allan Dafoe is VP of AI Policy at Google DeepMind and the founder of the Centre for the Governance of AI (GovAI) at Oxford University. His research focuses on the governance challenges posed by advanced AI systems, including international coordination, compute governance, and the strategic dynamics of AI development.",
  },
  {
    slug: "victoria-krakovna",
    name: "Victoria Krakovna",
    role: "Research Scientist",
    notableFor: "Research scientist at Google DeepMind working on AI safety; co-founder of the Future of Life Institute",
    education: "PhD in Statistics and Machine Learning, Harvard University",
    website: "https://vkrakovna.wordpress.com",
    description: "Victoria Krakovna is a research scientist at Google DeepMind focused on AI safety, particularly specification gaming and side effects avoidance. She is a co-founder of the Future of Life Institute (FLI) and maintains a widely-referenced collection of examples of specification gaming in AI systems.",
  },
  {
    slug: "rohin-shah",
    name: "Rohin Shah",
    role: "Research Scientist",
    notableFor: "Research scientist at Google DeepMind working on AI alignment; creator of the Alignment Newsletter",
    education: "PhD in Computer Science, UC Berkeley",
    description: "Rohin Shah is a research scientist at Google DeepMind working on AI alignment. He previously wrote the influential Alignment Newsletter summarizing AI safety research. His work focuses on reward learning, value alignment, and understanding the alignment problem from both technical and conceptual perspectives.",
  },
  {
    slug: "richard-ngo",
    name: "Richard Ngo",
    role: "AI Governance Researcher",
    notableFor: "AI governance researcher; formerly at OpenAI and DeepMind; influential writer on AI alignment and x-risk",
    education: "PhD candidate, University of Cambridge",
    description: "Richard Ngo is an AI governance researcher who has worked at both OpenAI and Google DeepMind. He has written influential essays on AI alignment, the case for AI risk, and AGI safety. He is known for his clear, accessible writing on technical AI safety topics and his engagement with the broader AI safety discourse.",
  },
  {
    slug: "jacob-steinhardt",
    name: "Jacob Steinhardt",
    bornYear: 1989,
    role: "Assistant Professor",
    notableFor: "UC Berkeley professor working on AI safety and robustness; leads the Steinhardt Group; runs AI forecasting contests",
    education: "PhD in Computer Science, Stanford University",
    website: "https://jsteinhardt.stat.berkeley.edu",
    description: "Jacob Steinhardt is an assistant professor of statistics at UC Berkeley. His research focuses on making machine learning systems more reliable and safe, including work on distribution shift, adversarial robustness, and AI forecasting. He runs forecasting contests on AI capabilities that have been influential in calibrating expectations about AI progress.",
  },
  {
    slug: "scott-alexander",
    name: "Scott Alexander",
    role: "Writer",
    notableFor: "Author of Astral Codex Ten (formerly Slate Star Codex); influential rationalist blogger covering AI risk and effective altruism",
    website: "https://www.astralcodexten.com",
    description: "Scott Alexander is a psychiatrist and writer behind Astral Codex Ten (ACT), one of the most widely-read blogs in the rationalist and effective altruism communities. His writing on AI risk, prediction markets, and related topics has been influential in shaping discourse around AI safety. He also runs ACX Grants, funding small projects in EA and rationality.",
  },
  {
    slug: "luke-muehlhauser",
    name: "Luke Muehlhauser",
    role: "Independent Researcher",
    notableFor: "Former Executive Director of MIRI; former GiveWell/Open Philanthropy researcher on AI risk",
    description: "Luke Muehlhauser served as Executive Director of the Machine Intelligence Research Institute (MIRI) from 2012 to 2015, during a period of significant growth. He subsequently joined GiveWell and Open Philanthropy, where he researched AI risk and helped shape Open Philanthropy's AI safety grantmaking strategy. His writings on AI timelines and existential risk have been influential in the effective altruism community.",
  },
  {
    slug: "andrew-ng",
    name: "Andrew Ng",
    bornYear: 1976,
    role: "Founder",
    notableFor: "Founder of DeepLearning.AI and Coursera; former head of Google Brain and Baidu AI; leading AI educator",
    education: "PhD in Computer Science, UC Berkeley",
    wikipedia: "https://en.wikipedia.org/wiki/Andrew_Ng",
    website: "https://www.andrewng.org",
    description: "Andrew Ng is one of the most prominent figures in AI education and research. He co-founded Google Brain, served as Chief Scientist at Baidu, and co-founded Coursera. His online courses have taught millions of people machine learning. He has been vocal about AI policy, generally advocating against heavy-handed regulation while supporting safety measures.",
  },
  {
    slug: "fei-fei-li",
    name: "Fei-Fei Li",
    bornYear: 1976,
    role: "Professor and Co-Director, Stanford HAI",
    notableFor: "Stanford professor; creator of ImageNet; co-director of Stanford Human-Centered AI Institute (HAI)",
    education: "PhD in Electrical Engineering, Caltech",
    wikipedia: "https://en.wikipedia.org/wiki/Fei-Fei_Li",
    description: "Fei-Fei Li is the Sequoia Professor of Computer Science at Stanford University and co-director of the Stanford Human-Centered AI Institute (HAI). She created ImageNet, the large-scale visual recognition dataset that catalyzed the deep learning revolution. She has been a leading voice on human-centered AI development and served as Google Cloud's Chief Scientist of AI/ML.",
  },
  {
    slug: "david-krueger",
    name: "David Krueger",
    role: "Assistant Professor",
    notableFor: "Cambridge professor researching AI alignment and safety; work on deceptive alignment and goal misgeneralization",
    education: "PhD in Computer Science, University of Montreal",
    website: "https://www.davidscottkrueger.com",
    description: "David Krueger is an assistant professor at the University of Cambridge working on AI alignment and safety. His research focuses on understanding and mitigating risks from advanced AI, including work on goal misgeneralization, deceptive alignment, and the theoretical foundations of AI safety. He has been active in organizing AI safety research community events.",
  },
  {
    slug: "timnit-gebru",
    name: "Timnit Gebru",
    bornYear: 1983,
    role: "Founder and Executive Director",
    notableFor: "Founder of the DAIR Institute; former co-lead of Google's Ethical AI team; AI ethics and fairness researcher",
    education: "PhD in Computer Science, Stanford University",
    wikipedia: "https://en.wikipedia.org/wiki/Timnit_Gebru",
    description: "Timnit Gebru is the founder and executive director of the Distributed AI Research Institute (DAIR). She previously co-led Google's Ethical AI team until her departure in 2020 amid controversy over a paper on large language model risks. Her research on algorithmic bias, data documentation, and AI ethics has been highly influential in shaping discussions about AI fairness and accountability.",
  },
];

async function main() {
  const kbThingsDir = resolve(ROOT, "packages/kb/data/things");
  const entitiesFile = resolve(ROOT, "data/entities/people.yaml");

  let entityAppendBlock = "\n";
  let created = 0;
  let skipped = 0;

  for (const person of PEOPLE) {
    const kbPath = resolve(kbThingsDir, `${person.slug}.yaml`);

    // Skip if already exists
    if (existsSync(kbPath)) {
      console.log(`⏭  ${person.slug} — already exists, skipping`);
      skipped++;
      continue;
    }

    // Allocate numeric ID
    console.log(`🆔  Allocating ID for ${person.slug}...`);
    const numericId = allocateNumericId(person.slug);
    if (!numericId) {
      console.error(`❌  Failed to allocate ID for ${person.slug}`);
      continue;
    }
    console.log(`   → ${numericId}`);

    // Generate stable ID and fact IDs
    const stableId = generateId();
    const factIds = {
      role: generateId(),
      employer: generateId(),
      bornYear: generateId(),
      notableFor: generateId(),
      education: generateId(),
      socialMedia: generateId(),
      wikipedia: generateId(),
      website: generateId(),
    };

    // Look up employer stableId if provided
    let employerRef = "";
    if (person.employerSlug) {
      const orgStableId = lookupOrgStableId(person.employerSlug);
      if (orgStableId) {
        employerRef = orgStableId;
      }
    }

    // Build KB YAML
    let yaml = `thing:\n`;
    yaml += `  id: ${person.slug}\n`;
    yaml += `  stableId: ${stableId}\n`;
    yaml += `  type: person\n`;
    yaml += `  name: "${person.name}"\n`;
    yaml += `  numericId: "${numericId}"\n`;
    yaml += `\n`;
    yaml += `facts:\n`;

    // employed-by
    if (employerRef) {
      yaml += `  - id: f_${factIds.employer}\n`;
      yaml += `    property: employed-by\n`;
      yaml += `    value: !ref ${employerRef}\n`;
      yaml += `\n`;
    }

    // role
    yaml += `  - id: f_${factIds.role}\n`;
    yaml += `    property: role\n`;
    yaml += `    value: "${person.role}"\n`;
    yaml += `\n`;

    // born-year
    if (person.bornYear) {
      yaml += `  - id: f_${factIds.bornYear}\n`;
      yaml += `    property: born-year\n`;
      yaml += `    value: ${person.bornYear}\n`;
      yaml += `\n`;
    }

    // notable-for
    yaml += `  - id: f_${factIds.notableFor}\n`;
    yaml += `    property: notable-for\n`;
    yaml += `    value: "${person.notableFor}"\n`;
    yaml += `\n`;

    // education
    if (person.education) {
      yaml += `  - id: f_${factIds.education}\n`;
      yaml += `    property: education\n`;
      yaml += `    value: "${person.education}"\n`;
      yaml += `\n`;
    }

    // social media
    if (person.socialMedia) {
      yaml += `  - id: f_${factIds.socialMedia}\n`;
      yaml += `    property: social-media\n`;
      yaml += `    value: "${person.socialMedia}"\n`;
      yaml += `\n`;
    }

    // wikipedia
    if (person.wikipedia) {
      yaml += `  - id: f_${factIds.wikipedia}\n`;
      yaml += `    property: wikipedia-url\n`;
      yaml += `    value: "${person.wikipedia}"\n`;
      yaml += `\n`;
    }

    // website
    if (person.website) {
      yaml += `  - id: f_${factIds.website}\n`;
      yaml += `    property: website\n`;
      yaml += `    value: "${person.website}"\n`;
      yaml += `\n`;
    }

    // Write KB YAML
    writeFileSync(kbPath, yaml);
    console.log(`✅  Created ${kbPath}`);

    // Build entity YAML append block
    const descriptionLines = person.description.match(/.{1,100}(\s|$)/g) ?? [person.description];
    const descYaml = descriptionLines.map((l) => `    ${l.trim()}`).join("\n");

    entityAppendBlock += `- id: ${person.slug}\n`;
    entityAppendBlock += `  stableId: ${stableId}\n`;
    entityAppendBlock += `  numericId: ${numericId}\n`;
    entityAppendBlock += `  type: person\n`;
    entityAppendBlock += `  title: "${person.name}"\n`;
    entityAppendBlock += `  description: >\n${descYaml}\n`;
    if (person.website) {
      entityAppendBlock += `  website: ${person.website}\n`;
    }
    entityAppendBlock += `  customFields:\n`;
    entityAppendBlock += `    - label: Role\n`;
    entityAppendBlock += `      value: "${person.role}"\n`;
    entityAppendBlock += `  tags:\n`;
    entityAppendBlock += `    - ai\n`;
    entityAppendBlock += `\n`;

    created++;
  }

  // Append to entities file
  if (entityAppendBlock.trim()) {
    appendFileSync(entitiesFile, entityAppendBlock);
    console.log(`\n📝  Appended ${created} entries to ${entitiesFile}`);
  }

  console.log(`\nDone: ${created} created, ${skipped} skipped`);
}

main().catch(console.error);
