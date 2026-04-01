import { ActiveAgentsContent } from "./active-agents-content";
import { AgentSessionsContent } from "./agent-sessions-content";
import { SessionInsightsContent } from "./session-insights-content";
import { AgentActivityTabs } from "./agent-activity-tabs";

/**
 * Consolidated agent activity dashboard.
 *
 * Combines three previously separate dashboards into tabbed sections:
 * - Active (E925): live agents, heartbeat status, conflicts
 * - Sessions (E912): session history list
 * - Insights (E913): learnings and recommendations
 *
 * Each tab renders the original content component — no logic was duplicated.
 */
export async function AgentActivityContent() {
  return (
    <AgentActivityTabs
      activeContent={<ActiveAgentsContent />}
      sessionsContent={<AgentSessionsContent />}
      insightsContent={<SessionInsightsContent />}
    />
  );
}
