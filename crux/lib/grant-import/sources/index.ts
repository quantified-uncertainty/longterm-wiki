import type { GrantSource } from "../types.ts";
import { source as coefficientGiving } from "./coefficient-giving.ts";
import { source as eaFunds } from "./ea-funds.ts";
import { source as sff } from "./sff.ts";
import { source as ftxFutureFund } from "./ftx-future-fund.ts";
import { source as manifund } from "./manifund.ts";

export const ALL_SOURCES: GrantSource[] = [
  coefficientGiving,
  eaFunds,
  sff,
  ftxFutureFund,
  manifund,
];

export { coefficientGiving, eaFunds, sff, ftxFutureFund, manifund };
