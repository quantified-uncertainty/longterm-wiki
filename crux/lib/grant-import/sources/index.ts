import type { GrantSource } from "../types.ts";
import { source as coefficientGiving } from "./coefficient-giving.ts";
import { source as eaFunds } from "./ea-funds.ts";
import { source as sff } from "./sff.ts";
import { source as ftxFutureFund } from "./ftx-future-fund.ts";
import { source as manifund } from "./manifund.ts";
import { source as givewell } from "./givewell.ts";
import { source as acxGrants } from "./acx-grants.ts";
// TODO: Founders Pledge — no machine-readable public grant data available.
// Their grantees page (https://www.founderspledge.com/grantees) shows organizations
// but without amounts or structured data. IRS 990 filings on ProPublica have aggregate
// numbers but not individual grants. Revisit if they publish a grants database.

export const ALL_SOURCES: GrantSource[] = [
  coefficientGiving,
  eaFunds,
  sff,
  ftxFutureFund,
  manifund,
  givewell,
  acxGrants,
];

export { coefficientGiving, eaFunds, sff, ftxFutureFund, manifund, givewell, acxGrants };
