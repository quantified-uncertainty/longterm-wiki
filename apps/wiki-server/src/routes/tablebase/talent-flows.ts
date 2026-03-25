import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";

// ---- Types ----

interface TransitionPersonRow {
  person_name: string;
  person_slug: string | null;
  role: string | null;
  transition_year: string | null;
}

interface FlowRow {
  from_org_entity_id: string;
  from_org_name: string;
  from_org_slug: string | null;
  to_org_entity_id: string;
  to_org_name: string;
  to_org_slug: string | null;
  flow_count: number;
  people_json: string; // JSON array of TransitionPersonRow
  [key: string]: unknown;
}

interface StatsRow {
  total_transitions: number;
  unique_people: number;
  unique_orgs: number;
  [key: string]: unknown;
}

interface NetFlowRow {
  org_entity_id: string;
  org_name: string;
  org_slug: string | null;
  inflows: number;
  outflows: number;
  net: number;
  [key: string]: unknown;
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const talentFlowsApp = new Hono()

  // ---- GET / ----
  // Computes org-to-org talent transitions from the personnel table.
  // For each person with 2+ career records (ordered by startDate),
  // consecutive orgs form directed edges (org A → org B).
  .get("/", async (c) => {
    const db = getDrizzleDb();

    // Step 1: Compute transitions using a window function.
    // For each person, order their career records by start_date, then
    // use LAG() to get the previous org. Each (prev_org → current_org) pair
    // is a transition.
    //
    // We filter to role_type = 'career' since key-person and board roles
    // represent concurrent positions, not sequential career moves.
    const flowRows = await db.execute<FlowRow>(sql`
      WITH person_careers AS (
        SELECT
          p.person_entity_id,
          COALESCE(pe.title, p.person_display_name, p.person_id) AS person_name,
          pe.id AS person_slug,
          p.org_entity_id,
          p.role,
          p.start_date,
          ROW_NUMBER() OVER (
            PARTITION BY p.person_entity_id
            ORDER BY p.start_date ASC NULLS LAST, p.created_at ASC
          ) AS rn,
          LAG(p.org_entity_id) OVER (
            PARTITION BY p.person_entity_id
            ORDER BY p.start_date ASC NULLS LAST, p.created_at ASC
          ) AS prev_org_entity_id
        FROM personnel p
        LEFT JOIN entities pe ON pe.stable_id = p.person_entity_id
        WHERE p.person_entity_id IS NOT NULL
          AND p.org_entity_id IS NOT NULL
          AND p.role_type = 'career'
      ),
      transitions AS (
        SELECT
          pc.prev_org_entity_id AS from_org_entity_id,
          pc.org_entity_id AS to_org_entity_id,
          pc.person_name,
          pc.person_slug,
          pc.role,
          LEFT(pc.start_date, 4) AS transition_year
        FROM person_careers pc
        WHERE pc.prev_org_entity_id IS NOT NULL
          AND pc.prev_org_entity_id != pc.org_entity_id
      )
      SELECT
        t.from_org_entity_id,
        COALESCE(fe.title, t.from_org_entity_id) AS from_org_name,
        fe.id AS from_org_slug,
        t.to_org_entity_id,
        COALESCE(te.title, t.to_org_entity_id) AS to_org_name,
        te.id AS to_org_slug,
        COUNT(*)::int AS flow_count,
        json_agg(json_build_object(
          'person_name', t.person_name,
          'person_slug', t.person_slug,
          'role', t.role,
          'transition_year', t.transition_year
        ) ORDER BY t.transition_year DESC NULLS LAST, t.person_name) AS people_json
      FROM transitions t
      LEFT JOIN entities fe ON fe.stable_id = t.from_org_entity_id
      LEFT JOIN entities te ON te.stable_id = t.to_org_entity_id
      GROUP BY t.from_org_entity_id, fe.title, fe.id,
               t.to_org_entity_id, te.title, te.id
      ORDER BY flow_count DESC, from_org_name, to_org_name
    `);

    // Step 2: Compute aggregate stats
    const statsRows = await db.execute<StatsRow>(sql`
      WITH person_careers AS (
        SELECT
          p.person_entity_id,
          p.org_entity_id,
          LAG(p.org_entity_id) OVER (
            PARTITION BY p.person_entity_id
            ORDER BY p.start_date ASC NULLS LAST, p.created_at ASC
          ) AS prev_org_entity_id
        FROM personnel p
        WHERE p.person_entity_id IS NOT NULL
          AND p.org_entity_id IS NOT NULL
          AND p.role_type = 'career'
      ),
      transitions AS (
        SELECT
          pc.person_entity_id,
          pc.prev_org_entity_id AS from_org,
          pc.org_entity_id AS to_org
        FROM person_careers pc
        WHERE pc.prev_org_entity_id IS NOT NULL
          AND pc.prev_org_entity_id != pc.org_entity_id
      )
      SELECT
        COUNT(*)::int AS total_transitions,
        COUNT(DISTINCT person_entity_id)::int AS unique_people,
        (SELECT COUNT(DISTINCT org)::int FROM (
          SELECT from_org AS org FROM transitions
          UNION
          SELECT to_org AS org FROM transitions
        ) all_orgs) AS unique_orgs
      FROM transitions
    `);

    const stats = statsRows[0] ?? {
      total_transitions: 0,
      unique_people: 0,
      unique_orgs: 0,
    };

    // Step 3: Compute net talent gain/loss per org
    // (inflows - outflows for each org)
    const netFlowRows = await db.execute<NetFlowRow>(sql`
      WITH person_careers AS (
        SELECT
          p.person_entity_id,
          p.org_entity_id,
          LAG(p.org_entity_id) OVER (
            PARTITION BY p.person_entity_id
            ORDER BY p.start_date ASC NULLS LAST, p.created_at ASC
          ) AS prev_org_entity_id
        FROM personnel p
        WHERE p.person_entity_id IS NOT NULL
          AND p.org_entity_id IS NOT NULL
          AND p.role_type = 'career'
      ),
      transitions AS (
        SELECT
          prev_org_entity_id AS from_org,
          org_entity_id AS to_org
        FROM person_careers
        WHERE prev_org_entity_id IS NOT NULL
          AND prev_org_entity_id != org_entity_id
      ),
      outflows AS (
        SELECT from_org AS org_entity_id, COUNT(*)::int AS cnt
        FROM transitions GROUP BY from_org
      ),
      inflows AS (
        SELECT to_org AS org_entity_id, COUNT(*)::int AS cnt
        FROM transitions GROUP BY to_org
      ),
      combined AS (
        SELECT
          COALESCE(i.org_entity_id, o.org_entity_id) AS org_entity_id,
          COALESCE(i.cnt, 0) AS inflows,
          COALESCE(o.cnt, 0) AS outflows,
          COALESCE(i.cnt, 0) - COALESCE(o.cnt, 0) AS net
        FROM inflows i
        FULL OUTER JOIN outflows o ON i.org_entity_id = o.org_entity_id
      )
      SELECT
        c.org_entity_id,
        COALESCE(e.title, c.org_entity_id) AS org_name,
        e.id AS org_slug,
        c.inflows,
        c.outflows,
        c.net
      FROM combined c
      LEFT JOIN entities e ON e.stable_id = c.org_entity_id
      ORDER BY ABS(c.net) DESC, c.inflows + c.outflows DESC
    `);

    // Format flows
    const flows = flowRows.map((r) => {
      const people: TransitionPersonRow[] =
        typeof r.people_json === "string"
          ? JSON.parse(r.people_json)
          : (r.people_json as unknown as TransitionPersonRow[]);

      return {
        fromOrg: {
          id: r.from_org_entity_id,
          name: r.from_org_name,
          slug: r.from_org_slug,
        },
        toOrg: {
          id: r.to_org_entity_id,
          name: r.to_org_name,
          slug: r.to_org_slug,
        },
        count: Number(r.flow_count),
        people: people.map((p) => ({
          name: p.person_name,
          slug: p.person_slug,
          role: p.role,
          year: p.transition_year,
        })),
      };
    });

    // Format net flows
    const orgNetFlows = netFlowRows.map((r) => ({
      org: {
        id: r.org_entity_id,
        name: r.org_name,
        slug: r.org_slug,
      },
      inflows: Number(r.inflows),
      outflows: Number(r.outflows),
      net: Number(r.net),
    }));

    return c.json({
      flows,
      orgNetFlows,
      stats: {
        totalTransitions: Number(stats.total_transitions),
        uniquePeople: Number(stats.unique_people),
        uniqueOrgs: Number(stats.unique_orgs),
      },
    });
  });

// ---- Exports ----

export const talentFlowsRoute = talentFlowsApp;
export type TalentFlowsRoute = typeof talentFlowsApp;
