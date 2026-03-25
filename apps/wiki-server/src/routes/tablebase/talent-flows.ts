import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";

// ---- Types ----

type TransitionRow = {
  from_org_entity_id: string;
  from_org_name: string;
  from_org_slug: string | null;
  to_org_entity_id: string;
  to_org_name: string;
  to_org_slug: string | null;
  person_name: string;
  person_slug: string | null;
  person_entity_id: string;
  role: string | null;
  transition_year: string | null;
};

// ---- Route definition (method-chained for Hono RPC type inference) ----

const talentFlowsApp = new Hono()

  // Computes org-to-org talent transitions from the personnel table.
  // Single query returns all transitions; stats and net flows are derived in JS.
  .get("/", async (c) => {
    const db = getDrizzleDb();

    // Compute all transitions in a single query using LAG() window function.
    // For each person, order career records by start_date, then each
    // (prev_org → current_org) pair is a directed transition edge.
    // Filters to role_type = 'career' since key-person and board roles
    // represent concurrent positions, not sequential career moves.
    const transitions = await db.execute<TransitionRow>(sql`
      WITH person_careers AS (
        SELECT
          p.person_entity_id,
          COALESCE(pe.title, p.person_display_name, p.person_id) AS person_name,
          pe.id AS person_slug,
          p.org_entity_id,
          p.role,
          p.start_date,
          LAG(p.org_entity_id) OVER (
            PARTITION BY p.person_entity_id
            ORDER BY p.start_date ASC NULLS LAST, p.created_at ASC
          ) AS prev_org_entity_id
        FROM personnel p
        LEFT JOIN entities pe ON pe.stable_id = p.person_entity_id
        WHERE p.person_entity_id IS NOT NULL
          AND p.org_entity_id IS NOT NULL
          AND p.role_type = 'career'
      )
      SELECT
        pc.prev_org_entity_id AS from_org_entity_id,
        COALESCE(fe.title, pc.prev_org_entity_id) AS from_org_name,
        fe.id AS from_org_slug,
        pc.org_entity_id AS to_org_entity_id,
        COALESCE(te.title, pc.org_entity_id) AS to_org_name,
        te.id AS to_org_slug,
        pc.person_name,
        pc.person_slug,
        pc.person_entity_id,
        pc.role,
        LEFT(pc.start_date, 4) AS transition_year
      FROM person_careers pc
      LEFT JOIN entities fe ON fe.stable_id = pc.prev_org_entity_id
      LEFT JOIN entities te ON te.stable_id = pc.org_entity_id
      WHERE pc.prev_org_entity_id IS NOT NULL
        AND pc.prev_org_entity_id != pc.org_entity_id
      ORDER BY pc.person_name, pc.start_date
    `);

    // Aggregate flows (group by from→to org pair)
    const flowMap = new Map<
      string,
      {
        fromOrg: { id: string; name: string; slug: string | null };
        toOrg: { id: string; name: string; slug: string | null };
        people: { name: string; slug: string | null; role: string | null; year: string | null }[];
      }
    >();

    const personIds = new Set<string>();
    const orgIds = new Set<string>();
    const orgInflows = new Map<string, { id: string; name: string; slug: string | null; count: number }>();
    const orgOutflows = new Map<string, { id: string; name: string; slug: string | null; count: number }>();

    for (const t of transitions) {
      const edgeKey = `${t.from_org_entity_id}→${t.to_org_entity_id}`;
      personIds.add(t.person_entity_id);
      orgIds.add(t.from_org_entity_id);
      orgIds.add(t.to_org_entity_id);

      // Flow edges
      if (!flowMap.has(edgeKey)) {
        flowMap.set(edgeKey, {
          fromOrg: { id: t.from_org_entity_id, name: t.from_org_name, slug: t.from_org_slug },
          toOrg: { id: t.to_org_entity_id, name: t.to_org_name, slug: t.to_org_slug },
          people: [],
        });
      }
      flowMap.get(edgeKey)!.people.push({
        name: t.person_name,
        slug: t.person_slug,
        role: t.role,
        year: t.transition_year,
      });

      // Net flows: track in/outflows per org
      const outEntry = orgOutflows.get(t.from_org_entity_id) ?? {
        id: t.from_org_entity_id, name: t.from_org_name, slug: t.from_org_slug, count: 0,
      };
      outEntry.count++;
      orgOutflows.set(t.from_org_entity_id, outEntry);

      const inEntry = orgInflows.get(t.to_org_entity_id) ?? {
        id: t.to_org_entity_id, name: t.to_org_name, slug: t.to_org_slug, count: 0,
      };
      inEntry.count++;
      orgInflows.set(t.to_org_entity_id, inEntry);
    }

    // Build flows array sorted by count desc
    const flows = [...flowMap.values()]
      .map((f) => ({ ...f, count: f.people.length }))
      .sort((a, b) => b.count - a.count);

    // Build net flows
    const allOrgIds = new Set([...orgInflows.keys(), ...orgOutflows.keys()]);
    const orgNetFlows = [...allOrgIds]
      .map((orgId) => {
        const inData = orgInflows.get(orgId);
        const outData = orgOutflows.get(orgId);
        const org = inData ?? outData!;
        const inCount = inData?.count ?? 0;
        const outCount = outData?.count ?? 0;
        return {
          org: { id: org.id, name: org.name, slug: org.slug },
          inflows: inCount,
          outflows: outCount,
          net: inCount - outCount,
        };
      })
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || (b.inflows + b.outflows) - (a.inflows + a.outflows));

    return c.json({
      flows,
      orgNetFlows,
      stats: {
        totalTransitions: transitions.length,
        uniquePeople: personIds.size,
        uniqueOrgs: orgIds.size,
      },
    });
  });

// ---- Exports ----

export const talentFlowsRoute = talentFlowsApp;
export type TalentFlowsRoute = typeof talentFlowsApp;
