// Server wrapper for SafetyGeneralizabilityTableView
// Calls getSafetyApproaches() (which uses fs.readFileSync) on the server
// and passes the data to the client component as props.
import { getSafetyApproaches } from "@data/tables/safety-generalizability"
import SafetyGeneralizabilityTableViewClient from "./SafetyGeneralizabilityTableViewClient"

export default function SafetyGeneralizabilityTableView() {
  const approaches = getSafetyApproaches()
  return <SafetyGeneralizabilityTableViewClient approaches={approaches} />
}
